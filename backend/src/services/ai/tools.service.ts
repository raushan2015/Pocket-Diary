/**
 * AI Tool Registry and Execution Engine.
 * Provides full server-side workspace control for Pocket Diary AI tools
 * with strict RBAC (`verifyWorkspaceMembership`), attachment cleanup, and
 * privacy guardrails (`blocked` notes & `[REDACTED]` protected sections).
 */
import fs from 'node:fs/promises';
import type { DatabaseContext } from '../../db/index.js';
import { config, resolveAppUrl } from '../../config.js';
import {
  verifyWorkspaceMembership,
  createWorkspace,
  removeWorkspaceMember,
  changeMemberRole,
  leaveWorkspace,
  transferWorkspaceOwnership,
} from '../workspace.service.js';
import {
  listMemos,
  getMemoById,
  createMemo,
  updateMemo,
  deleteMemo,
  restoreMemo,
  emptyTrash,
  getMemoVersions,
  reorderMemos,
  VALID_MEMO_COLORS,
  VALID_PRIORITIES,
  VALID_STATUSES,
  VALID_THEMES,
  type ChecklistItem,
  type MemoPriority,
  type MemoStatus,
} from '../memo.service.js';
import { listFolders, createFolder, updateFolder, deleteFolder } from '../folder.service.js';
import { listCategories, createCategory, updateCategory, deleteCategory } from '../category.service.js';
import { listTags, createTag, renameTag, deleteTag } from '../tag.service.js';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '../notification.service.js';
import { createInvite, listInvites, revokeInvite } from '../invite.service.js';
import { exportWorkspaceData } from '../migration.service.js';
import { assertPublicHttpUrl } from '../url-guard.js';
import { guardedFetch } from '../safe-fetch.js';
import {
  audit,
  getLiveGrant,
  getNoteAiAccess,
  prepareNoteForProvider,
  redactProtectedSections,
  revokeGrantsForMemo,
  scanAndRedactSecrets,
} from './privacy.service.js';
import { expandQueryLocally, searchNotesLocally } from './search.service.js';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolContext {
  dbCtx: DatabaseContext;
  userId: string;
  workspaceId: string;
  conversationId: string;
  provider?: string | null;
  providerConfigId?: string;
  noteGrant?: { grantId: string; memoId: string; version: number; expiresAt: number } | null;
  searchGrantIds?: string[];
  emitUiEvent?: (event: string, data: unknown) => void;
  onNoteCreated?: (memo: { id: string; title: string }) => void;
}

export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
  truncated?: boolean;
}

const MAX_TOOL_RESULT_CHARS = 12_000;
const WRITE_ROLES = ['owner', 'admin', 'editor'];

export interface ToolAuditEntry {
  timestamp: number;
  conversationId: string;
  userId: string;
  workspaceId: string;
  toolName: string;
  argsHash: string;
  resultStatus: 'success' | 'error' | 'timeout';
  latencyMs: number;
  errorMessage?: string;
}

const toolAuditLog: ToolAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 10000;

function hashArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args).slice(0, 200);
}

function addAuditEntry(entry: ToolAuditEntry) {
  toolAuditLog.push(entry);
  if (toolAuditLog.length > MAX_AUDIT_ENTRIES) {
    toolAuditLog.shift();
  }
}

export function getToolAuditLog(filters?: { conversationId?: string; userId?: string; toolName?: string; limit?: number }): ToolAuditEntry[] {
  let result = [...toolAuditLog].reverse();
  if (filters?.conversationId) result = result.filter((e) => e.conversationId === filters.conversationId);
  if (filters?.userId) result = result.filter((e) => e.userId === filters.userId);
  if (filters?.toolName) result = result.filter((e) => e.toolName === filters.toolName);
  return result.slice(0, filters?.limit ?? 100);
}

/** Parse either Unix ms integer or ISO-8601 / date string into Unix ms (or null to clear). */
export function parseOptionalTimestamp(value: unknown, fieldName = 'timestamp'): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${fieldName}`);
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{10,16}$/.test(trimmed)) {
      const n = Number(trimmed);
      // Treat 10-digit epoch seconds carefully if ever supplied as seconds
      return trimmed.length === 10 ? n * 1000 : n;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid ${fieldName}: "${trimmed}". Use ISO-8601 (e.g. 2026-11-14T09:00:00Z) or Unix ms.`);
    }
    return parsed;
  }
  throw new Error(`Invalid ${fieldName}`);
}

function normalizeChecklist(raw: unknown): ChecklistItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, 500).map((item, idx) => {
    const rec = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(rec.id ?? `chk-${idx}`).slice(0, 64),
      text: String(rec.text ?? '').slice(0, 5000),
      checked: Boolean(rec.checked ?? rec.completed ?? false),
    };
  });
}

function resolveTargetWorkspace(args: Record<string, unknown>, context: ToolContext): string {
  return typeof args.workspaceId === 'string' && args.workspaceId.trim()
    ? args.workspaceId.trim()
    : context.workspaceId;
}

function emitWorkspaceChange(context: ToolContext, detail: Record<string, unknown>): void {
  try {
    context.emitUiEvent?.('workspace_changed', detail);
  } catch {
    // non-fatal
  }
}

export const BUILTIN_TOOLS: ToolDefinition[] = [
  {
    name: 'list_notes',
    description: 'List notes in the workspace with filters (search, folderId, categoryId, tag, status, priority, isPinned, isFavorite, isArchived, hasReminder, deletedOnly, includeDeleted). Returns metadata (never blocked note contents).',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        search: { type: 'string', description: 'Optional keyword search' },
        folderId: { type: 'string' },
        categoryId: { type: 'string' },
        tag: { type: 'string', description: 'Filter by tag name' },
        status: { type: 'string', enum: [...VALID_STATUSES] },
        priority: { type: 'string', enum: [...VALID_PRIORITIES] },
        isPinned: { type: 'boolean' },
        isFavorite: { type: 'boolean' },
        isArchived: { type: 'boolean' },
        hasReminder: { type: 'boolean' },
        deletedOnly: { type: 'boolean', description: 'True to list only trashed notes' },
        includeDeleted: { type: 'boolean' },
        page: { type: 'integer', minimum: 1, default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'read_note',
    description: 'Read the full redacted content and metadata of a note by memoId. Respects privacy locks (blocked notes cannot be read).',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        memoId: { type: 'string', description: 'Note ID to read' },
        grantId: { type: 'string', description: 'Optional explicit grant ID if already issued' },
      },
      required: ['memoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_note',
    description: 'Create and immediately save a new note or checklist in the workspace (with optional folder, category, tags, color, theme, priority, status, pin/favorite, dueDate, reminderTime, reminderLocation).',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        title: { type: 'string', maxLength: 200 },
        content: { type: 'string', description: 'Note content in Markdown' },
        folderId: { type: ['string', 'null'] },
        categoryId: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        checklistData: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              checked: { type: 'boolean' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        noteType: { type: 'string', enum: ['text', 'checklist'] },
        color: { type: 'string', enum: [...VALID_MEMO_COLORS] },
        theme: { type: 'string', enum: [...VALID_THEMES] },
        priority: { type: 'string', enum: [...VALID_PRIORITIES] },
        status: { type: 'string', enum: [...VALID_STATUSES] },
        isPinned: { type: 'boolean' },
        isFavorite: { type: 'boolean' },
        isArchived: { type: 'boolean' },
        dueDate: { type: ['string', 'integer', 'null'], description: 'ISO-8601 date/time or Unix ms' },
        reminderTime: { type: ['string', 'integer', 'null'], description: 'ISO-8601 date/time or Unix ms' },
        reminderLocation: { type: ['string', 'null'] },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_note',
    description: 'Directly update any existing note (title, content, checklist, tags, folderId, categoryId, color, theme, priority, status, isPinned, isFavorite, isArchived, dueDate, reminderTime, reminderLocation). Pass null to clear optional fields.',
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        memoId: { type: 'string', description: 'Note ID to update' },
        title: { type: 'string', maxLength: 200 },
        content: { type: 'string' },
        folderId: { type: ['string', 'null'] },
        categoryId: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        checklistData: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              checked: { type: 'boolean' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
        noteType: { type: 'string', enum: ['text', 'checklist'] },
        color: { type: 'string', enum: [...VALID_MEMO_COLORS] },
        theme: { type: 'string', enum: [...VALID_THEMES] },
        priority: { type: 'string', enum: [...VALID_PRIORITIES] },
        status: { type: 'string', enum: [...VALID_STATUSES] },
        isPinned: { type: 'boolean' },
        isFavorite: { type: 'boolean' },
        isArchived: { type: 'boolean' },
        dueDate: { type: ['string', 'integer', 'null'], description: 'ISO-8601 date/time, Unix ms, or null to clear' },
        reminderTime: { type: ['string', 'integer', 'null'], description: 'ISO-8601 date/time, Unix ms, or null to clear' },
        reminderLocation: { type: ['string', 'null'] },
        expectedVersion: { type: 'integer' },
      },
      required: ['memoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_note',
    description: 'Delete a note by memoId. Moves the note to Trash by default (permanent=false), or permanently deletes it when permanent=true.',
    parameters: {
      type: 'object',
      properties: {
        memoId: { type: 'string', description: 'Note ID to delete' },
        permanent: { type: 'boolean', default: false, description: 'True for irreversible hard delete; false moves to Trash' },
      },
      required: ['memoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'restore_note',
    description: 'Restore a trashed (soft-deleted) note back to active notes.',
    parameters: {
      type: 'object',
      properties: {
        memoId: { type: 'string', description: 'Note ID in Trash to restore' },
      },
      required: ['memoId'],
      additionalProperties: false,
    },
  },
  {
    name: 'empty_trash',
    description: 'Permanently purge all trashed notes in the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        confirm: { type: 'boolean', description: 'Must be true to permanently empty Trash' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_reminder',
    description: 'Create a calendar reminder/event (or set/update/clear reminderTime & dueDate on an existing memoId). Accepts ISO-8601 strings or Unix ms.',
    parameters: {
      type: 'object',
      properties: {
        memoId: { type: 'string', description: 'Existing note ID (omit to create a new scheduled note/reminder)' },
        title: { type: 'string', maxLength: 200, description: 'Title if creating a new reminder note' },
        content: { type: 'string', description: 'Optional description/details if creating a new reminder note' },
        reminderTime: { type: ['string', 'integer', 'null'], description: 'Reminder trigger timestamp (ISO-8601 or Unix ms, null to clear)' },
        dueDate: { type: ['string', 'integer', 'null'], description: 'Calendar due date (defaults to reminderTime when setting a reminder)' },
        reminderLocation: { type: ['string', 'null'] },
        priority: { type: 'string', enum: [...VALID_PRIORITIES] },
        tags: { type: 'array', items: { type: 'string' } },
        clear: { type: 'boolean', description: 'Set true to remove reminderTime and dueDate from memoId' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_calendar_schedule',
    description: 'Get calendar events, due dates, upcoming/overdue reminders, and recent reminder notifications in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        startDate: { type: ['string', 'integer'], description: 'Optional window start (ISO-8601 or Unix ms)' },
        endDate: { type: ['string', 'integer'], description: 'Optional window end (ISO-8601 or Unix ms)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_notifications',
    description: 'List reminder notifications for the signed-in user.',
    parameters: {
      type: 'object',
      properties: {
        includeRead: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'mark_notifications_read',
    description: 'Mark a specific notification read or mark all reminder notifications read.',
    parameters: {
      type: 'object',
      properties: {
        notificationId: { type: 'string', description: 'Notification ID (omit or pass all=true to mark all read)' },
        all: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_notes',
    description: 'Local SQLite FTS search across workspace notes. Returns non-sensitive hit metadata (IDs, titles, non-blocked snippets) so you can identify notes.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        phrases: { type: 'array', items: { type: 'string' } },
        page: { type: 'integer', minimum: 1, default: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_workspaces',
    description: 'List/create/rename workspaces, check storage/members/activities, leave, or manage member roles/ownership.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'rename', 'storage', 'members', 'activities', 'leave', 'change_role', 'remove_member', 'transfer_ownership'] },
        workspaceId: { type: 'string', description: 'Target workspace ID (defaults to active workspace)' },
        name: { type: 'string', description: 'Workspace name (for create/rename)' },
        slug: { type: 'string', description: 'Optional slug (for create)' },
        targetUserId: { type: 'string', description: 'Target member user ID' },
        role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_invites',
    description: 'List, create, or revoke workspace invitations (owner/admin only).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'revoke'] },
        workspaceId: { type: 'string' },
        email: { type: 'string' },
        role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
        inviteId: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_note_extras',
    description: 'View note revision history (versions), reorder notes (reorder), or fetch a safe URL link preview (link_preview).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['versions', 'reorder', 'link_preview'] },
        workspaceId: { type: 'string' },
        memoId: { type: 'string', description: 'Note ID (for versions or attachToMemo)' },
        memoIds: { type: 'array', items: { type: 'string' }, description: 'Ordered memo IDs (for reorder)' },
        url: { type: 'string', description: 'Public http/https URL (for link_preview)' },
        attachToMemo: { type: 'boolean', description: 'Save preview onto memoId when true' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_attachments',
    description: 'List non-blocked note attachments (without revealing server paths) or delete an attachment.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'delete'] },
        workspaceId: { type: 'string' },
        memoId: { type: 'string', description: 'Optional memo ID filter for list' },
        attachmentId: { type: 'string', description: 'Attachment ID (required for delete)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'export_data',
    description: 'Export non-blocked workspace notes/metadata (workspace_json) or RFC-5545 .ics calendar feed of scheduled reminders (calendar_ics).',
    parameters: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['workspace_json', 'calendar_ics'] },
        workspaceId: { type: 'string' },
        includeArchived: { type: 'boolean', default: false },
        includeDeleted: { type: 'boolean', default: false },
      },
      required: ['format'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_folders',
    description: 'List, create, rename/move, or delete folders in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        workspaceId: { type: 'string' },
        folderId: { type: 'string', description: 'Required for update/delete' },
        name: { type: 'string', description: 'Folder name (required for create)' },
        parentId: { type: ['string', 'null'], description: 'Optional parent folder ID' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_categories',
    description: 'List, create, update, or delete categories in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        workspaceId: { type: 'string' },
        categoryId: { type: 'string', description: 'Required for update/delete' },
        name: { type: 'string', description: 'Category name (required for create)' },
        color: { type: ['string', 'null'] },
        icon: { type: ['string', 'null'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_tags',
    description: 'List, create, rename, or delete tags in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'rename', 'delete'] },
        workspaceId: { type: 'string' },
        tagId: { type: 'string', description: 'Required for rename/delete' },
        name: { type: 'string', description: 'Tag name (required for create/rename)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

export const GENERAL_TOOL_NAMES = new Set<string>([
  ...BUILTIN_TOOLS.map((t) => t.name),
  // Backwards-compatible aliases
  'list_workspaces',
  'list_folders',
  'list_categories',
]);

export const WRITE_TOOL_NAMES = new Set<string>([
  'create_note',
  'update_note',
  'delete_note',
  'restore_note',
  'empty_trash',
  'set_reminder',
  'mark_notifications_read',
  'manage_workspaces',
  'manage_invites',
  'manage_note_extras',
  'manage_attachments',
  'manage_folders',
  'manage_categories',
  'manage_tags',
]);

const WRITE_ACTION_TOOLS: Record<string, Set<string>> = {
  manage_folders: new Set(['create', 'update', 'delete']),
  manage_categories: new Set(['create', 'update', 'delete']),
  manage_tags: new Set(['create', 'rename', 'delete']),
  manage_workspaces: new Set(['create', 'rename', 'leave', 'change_role', 'remove_member', 'transfer_ownership']),
  manage_invites: new Set(['create', 'revoke']),
  manage_attachments: new Set(['delete']),
};

/** Returns true when invoking `toolName` with `args` mutates workspace state. */
export function isWriteToolInvocation(toolName: string, args: Record<string, unknown>): boolean {
  if (!WRITE_TOOL_NAMES.has(toolName)) return false;
  if (toolName === 'manage_note_extras') {
    const action = typeof args.action === 'string' ? args.action : '';
    return action === 'reorder' || (action === 'link_preview' && Boolean(args.attachToMemo));
  }
  const gatedActions = WRITE_ACTION_TOOLS[toolName];
  if (gatedActions) {
    const action = typeof args.action === 'string' ? args.action : '';
    return gatedActions.has(action);
  }
  return true;
}

/** Execute a tool by name with arguments. */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const startTime = Date.now();
  const argsHash = hashArgs(args);

  try {
    let result: unknown;

    switch (toolName) {
      case 'list_notes':
        result = await executeListNotes(args, context);
        break;
      case 'search_notes':
        result = await executeSearchNotes(args, context);
        break;
      case 'read_note':
        result = await executeReadNote(args, context);
        break;
      case 'create_note':
        result = await executeCreateNote(args, context);
        break;
      case 'update_note':
        result = await executeUpdateNote(args, context);
        break;
      case 'delete_note':
        result = await executeDeleteNote(args, context);
        break;
      case 'restore_note':
        result = await executeRestoreNote(args, context);
        break;
      case 'empty_trash':
        result = await executeEmptyTrash(args, context);
        break;
      case 'set_reminder':
        result = await executeSetReminder(args, context);
        break;
      case 'get_calendar_schedule':
        result = await executeGetCalendarSchedule(args, context);
        break;
      case 'list_notifications':
        result = await executeListNotifications(args, context);
        break;
      case 'mark_notifications_read':
        result = await executeMarkNotificationsRead(args, context);
        break;
      case 'manage_workspaces':
        result = await executeManageWorkspaces(args, context);
        break;
      case 'manage_invites':
        result = await executeManageInvites(args, context);
        break;
      case 'manage_note_extras':
        result = await executeManageNoteExtras(args, context);
        break;
      case 'manage_attachments':
        result = await executeManageAttachments(args, context);
        break;
      case 'export_data':
        result = await executeExportData(args, context);
        break;
      case 'manage_folders':
        result = await executeManageFolders(args, context);
        break;
      case 'manage_categories':
        result = await executeManageCategories(args, context);
        break;
      case 'manage_tags':
        result = await executeManageTags(args, context);
        break;
      // Backwards-compatible aliases
      case 'list_workspaces':
        result = await executeManageWorkspaces({ action: 'list' }, context);
        break;
      case 'list_folders':
        result = await executeManageFolders({ ...args, action: 'list' }, context);
        break;
      case 'list_categories':
        result = await executeManageCategories({ ...args, action: 'list' }, context);
        break;
      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }

    const resultStr = JSON.stringify(result);
    addAuditEntry({
      timestamp: startTime,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      toolName,
      argsHash,
      resultStatus: 'success',
      latencyMs: Date.now() - startTime,
    });

    if (resultStr.length > MAX_TOOL_RESULT_CHARS) {
      return {
        success: true,
        result: { truncated: true, preview: resultStr.slice(0, MAX_TOOL_RESULT_CHARS) },
        truncated: true,
      };
    }

    return { success: true, result };
  } catch (err) {
    addAuditEntry({
      timestamp: startTime,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
      toolName,
      argsHash,
      resultStatus: 'error',
      latencyMs: Date.now() - startTime,
      errorMessage: err instanceof Error ? err.message : 'Unknown error',
    });

    return {
      success: false,
      error: err instanceof Error ? err.message : 'Tool execution failed',
    };
  }
}

async function executeListNotes(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);

  const page = typeof args.page === 'number' && args.page >= 1 ? Math.floor(args.page) : 1;
  const limit = Math.min(typeof args.limit === 'number' && args.limit >= 1 ? Math.floor(args.limit) : 25, 50);

  const listed = listMemos(context.dbCtx, {
    workspaceId,
    search: typeof args.search === 'string' ? args.search : undefined,
    folderId: typeof args.folderId === 'string' ? args.folderId : undefined,
    categoryId: typeof args.categoryId === 'string' ? args.categoryId : undefined,
    tagName: typeof args.tag === 'string' ? args.tag : undefined,
    status: typeof args.status === 'string' ? args.status : undefined,
    priority: typeof args.priority === 'string' ? args.priority : undefined,
    isPinned: typeof args.isPinned === 'boolean' ? args.isPinned : undefined,
    isFavorite: typeof args.isFavorite === 'boolean' ? args.isFavorite : undefined,
    isArchived: typeof args.isArchived === 'boolean' ? args.isArchived : undefined,
    hasReminder: typeof args.hasReminder === 'boolean' ? args.hasReminder : undefined,
    deletedOnly: typeof args.deletedOnly === 'boolean' ? args.deletedOnly : undefined,
    includeDeleted: typeof args.includeDeleted === 'boolean' ? args.includeDeleted : undefined,
    page,
    limit,
  });

  const notes = listed.memos.map((m) => {
    const aiAccess = getNoteAiAccess(context.dbCtx, m.id, workspaceId);
    const blocked = aiAccess === 'blocked';
    return {
      id: m.id,
      title: blocked ? '[Blocked Note]' : scanAndRedactSecrets(m.title || 'Untitled').text,
      folderId: m.folderId,
      categoryId: m.categoryId,
      tags: blocked ? [] : m.tags,
      status: m.status,
      priority: m.priority,
      color: m.color,
      noteType: m.noteType,
      isPinned: m.isPinned,
      isFavorite: m.isFavorite,
      isArchived: m.isArchived,
      dueDate: m.dueDate,
      reminderTime: m.reminderTime,
      reminderLocation: blocked ? null : m.reminderLocation,
      aiAccess,
      version: m.version,
      deletedAt: m.deletedAt,
      updatedAt: m.updatedAt,
    };
  });

  return { workspaceId, notes, total: listed.total, page: listed.page, limit: listed.limit };
}

async function executeSearchNotes(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);

  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('Search query is required');
  const phrases = Array.isArray(args.phrases) ? args.phrases.map(String) : [];
  const page = typeof args.page === 'number' ? Math.max(1, args.page) : 1;
  const limit = Math.min(typeof args.limit === 'number' ? Math.max(1, args.limit) : 25, 50);

  const result = searchNotesLocally(context.dbCtx, {
    userId: context.userId,
    workspaceId,
    isMember: true,
    queries: expandQueryLocally(query, phrases),
    page,
    limit,
  });

  return {
    workspaceId,
    total: result.total,
    page: result.page,
    limit: result.limit,
    hits: result.hits.map((h) => ({
      id: h.id,
      title: h.llmEligible || h.eligibility !== 'blocked' ? scanAndRedactSecrets(h.title).text : '[Blocked Note]',
      snippet: h.eligibility === 'blocked' ? '' : scanAndRedactSecrets(h.snippet).text,
      eligibility: h.eligibility,
      updatedAt: h.updatedAt,
    })),
  };
}

async function executeReadNote(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
  const memoId = String(args.memoId ?? '').trim();
  if (!memoId) throw new Error('memoId is required');

  const policy = getNoteAiAccess(context.dbCtx, memoId, workspaceId);
  if (policy === 'blocked') {
    audit(context.dbCtx, context.userId, workspaceId, 'send_blocked', memoId, context.provider ?? null, 0);
    throw new Error('This note is marked "never share with AI" and cannot be read.');
  }

  const grantId = typeof args.grantId === 'string' && args.grantId.trim() ? args.grantId.trim() : null;
  if (grantId) {
    const grant = getLiveGrant(context.dbCtx, grantId, { userId: context.userId, conversationId: context.conversationId });
    if (!grant || grant.memoId !== memoId) {
      throw new Error('Grant not found or does not authorize this note');
    }
    const prepared = prepareNoteForProvider(context.dbCtx, {
      memoId,
      workspaceId,
      grant,
      maxChars: 50_000,
    });
    if (prepared.withheld) throw new Error(`Note content withheld: ${prepared.withheldReason}`);
    audit(context.dbCtx, context.userId, workspaceId, 'send', memoId, context.provider ?? null, prepared.redactedBytes);
    return {
      id: prepared.memoId,
      title: prepared.title,
      content: prepared.excerpt,
      version: prepared.version,
      truncated: prepared.truncated,
      redactedBytes: prepared.redactedBytes,
    };
  }

  const memo = getMemoById(context.dbCtx, memoId, workspaceId);
  if (!memo) throw new Error('Note not found');

  const protectResult = redactProtectedSections(context.dbCtx, memoId, memo.content ?? '');
  if (protectResult.stale) {
    throw new Error('Protected passages for this note are out of date; refresh AI protections before reading.');
  }
  const contentScan = scanAndRedactSecrets(protectResult.text);
  const titleScan = scanAndRedactSecrets(memo.title ?? '');
  audit(context.dbCtx, context.userId, workspaceId, 'send', memoId, context.provider ?? null, protectResult.redactedBytes + contentScan.redactedBytes);

  return {
    id: memo.id,
    title: titleScan.text,
    content: contentScan.text.slice(0, 50_000),
    truncated: contentScan.text.length > 50_000,
    checklistData: memo.checklistData,
    tags: memo.tags,
    folderId: memo.folderId,
    categoryId: memo.categoryId,
    color: memo.color,
    theme: memo.theme,
    priority: memo.priority,
    status: memo.status,
    noteType: memo.noteType,
    isPinned: memo.isPinned,
    isFavorite: memo.isFavorite,
    isArchived: memo.isArchived,
    dueDate: memo.dueDate,
    reminderTime: memo.reminderTime,
    reminderLocation: memo.reminderLocation,
    version: memo.version,
    deletedAt: memo.deletedAt,
    updatedAt: memo.updatedAt,
    redactedBytes: protectResult.redactedBytes + contentScan.redactedBytes,
  };
}

async function executeCreateNote(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);

  const title = String(args.title ?? '').trim().slice(0, 200) || 'Untitled note';
  const content = String(args.content ?? '').slice(0, 200_000);
  const checklistData = normalizeChecklist(args.checklistData);
  const dueDate = parseOptionalTimestamp(args.dueDate, 'dueDate');
  const reminderTime = parseOptionalTimestamp(args.reminderTime, 'reminderTime');

  const memo = createMemo(
    context.dbCtx,
    {
      workspaceId,
      title,
      content,
      folderId: args.folderId === null ? null : typeof args.folderId === 'string' ? args.folderId : undefined,
      categoryId: args.categoryId === null ? null : typeof args.categoryId === 'string' ? args.categoryId : undefined,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      checklistData,
      noteType: args.noteType === 'checklist' || (checklistData && checklistData.length > 0) ? 'checklist' : 'text',
      color: typeof args.color === 'string' && (VALID_MEMO_COLORS as readonly string[]).includes(args.color) ? args.color : undefined,
      theme: typeof args.theme === 'string' && (VALID_THEMES as readonly string[]).includes(args.theme) ? args.theme : undefined,
      priority: typeof args.priority === 'string' && (VALID_PRIORITIES as readonly string[]).includes(args.priority) ? (args.priority as MemoPriority) : undefined,
      status: typeof args.status === 'string' && (VALID_STATUSES as readonly string[]).includes(args.status) ? (args.status as MemoStatus) : undefined,
      isPinned: typeof args.isPinned === 'boolean' ? args.isPinned : undefined,
      isFavorite: typeof args.isFavorite === 'boolean' ? args.isFavorite : undefined,
      isArchived: typeof args.isArchived === 'boolean' ? args.isArchived : undefined,
      dueDate: dueDate ?? (reminderTime ?? undefined),
      reminderTime: reminderTime ?? undefined,
      reminderLocation: typeof args.reminderLocation === 'string' ? args.reminderLocation.slice(0, 500) : args.reminderLocation === null ? null : undefined,
    },
    context.userId
  );

  context.onNoteCreated?.({ id: memo.id, title: memo.title });
  context.emitUiEvent?.('note_saved', { memoId: memo.id, title: memo.title, autoApproved: true });
  emitWorkspaceChange(context, { action: 'create_note', memoId: memo.id });

  return {
    ok: true,
    status: 'saved',
    memoId: memo.id,
    title: memo.title,
    dueDate: memo.dueDate,
    reminderTime: memo.reminderTime,
    reminderLocation: memo.reminderLocation,
    version: memo.version,
  };
}

async function executeUpdateNote(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);

  const memoId = String(args.memoId ?? '').trim();
  if (!memoId) throw new Error('memoId is required');

  const checklistData = normalizeChecklist(args.checklistData);
  const dueDate = parseOptionalTimestamp(args.dueDate, 'dueDate');
  const reminderTime = parseOptionalTimestamp(args.reminderTime, 'reminderTime');

  const updated = updateMemo(
    context.dbCtx,
    memoId,
    workspaceId,
    {
      title: typeof args.title === 'string' ? args.title.slice(0, 200) : undefined,
      content: typeof args.content === 'string' ? args.content.slice(0, 200_000) : undefined,
      folderId: args.folderId === null ? null : typeof args.folderId === 'string' ? args.folderId : undefined,
      categoryId: args.categoryId === null ? null : typeof args.categoryId === 'string' ? args.categoryId : undefined,
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      checklistData,
      noteType: args.noteType === 'checklist' || args.noteType === 'text' ? args.noteType : undefined,
      color: typeof args.color === 'string' && (VALID_MEMO_COLORS as readonly string[]).includes(args.color) ? args.color : undefined,
      theme: typeof args.theme === 'string' && (VALID_THEMES as readonly string[]).includes(args.theme) ? args.theme : undefined,
      priority: typeof args.priority === 'string' && (VALID_PRIORITIES as readonly string[]).includes(args.priority) ? (args.priority as MemoPriority) : undefined,
      status: typeof args.status === 'string' && (VALID_STATUSES as readonly string[]).includes(args.status) ? (args.status as MemoStatus) : undefined,
      isPinned: typeof args.isPinned === 'boolean' ? args.isPinned : undefined,
      isFavorite: typeof args.isFavorite === 'boolean' ? args.isFavorite : undefined,
      isArchived: typeof args.isArchived === 'boolean' ? args.isArchived : undefined,
      dueDate,
      reminderTime,
      reminderLocation: args.reminderLocation === null ? null : typeof args.reminderLocation === 'string' ? args.reminderLocation.slice(0, 500) : undefined,
      version: typeof args.expectedVersion === 'number' ? args.expectedVersion : undefined,
    },
    context.userId
  );

  emitWorkspaceChange(context, { action: 'update_note', memoId: updated.id });

  return {
    ok: true,
    status: 'updated',
    memoId: updated.id,
    title: updated.title,
    version: updated.version,
    dueDate: updated.dueDate,
    reminderTime: updated.reminderTime,
    isPinned: updated.isPinned,
    isFavorite: updated.isFavorite,
    isArchived: updated.isArchived,
  };
}

async function executeDeleteNote(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
  const memoId = String(args.memoId ?? '').trim();
  if (!memoId) throw new Error('memoId is required');
  const permanent = Boolean(args.permanent);

  const existing = getMemoById(context.dbCtx, memoId, workspaceId);
  if (!existing) throw new Error('Note not found');

  deleteMemo(context.dbCtx, memoId, workspaceId, permanent);
  revokeGrantsForMemo(context.dbCtx, memoId);
  emitWorkspaceChange(context, { action: permanent ? 'permanent_delete_note' : 'trash_note', memoId });

  return {
    ok: true,
    memoId,
    title: existing.title,
    status: permanent ? 'permanently_deleted' : 'moved_to_trash',
  };
}

async function executeRestoreNote(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
  const memoId = String(args.memoId ?? '').trim();
  if (!memoId) throw new Error('memoId is required');

  const restored = restoreMemo(context.dbCtx, memoId, workspaceId);
  emitWorkspaceChange(context, { action: 'restore_note', memoId: restored.id });

  return { ok: true, memoId: restored.id, title: restored.title, status: 'restored' };
}

async function executeEmptyTrash(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
  if (args.confirm !== true) {
    throw new Error('Set confirm=true to permanently empty the Trash.');
  }

  const purged = emptyTrash(context.dbCtx, workspaceId);
  for (const filePath of purged.attachmentPaths) {
    try {
      await fs.unlink(filePath);
    } catch {
      // ignore missing files
    }
  }
  emitWorkspaceChange(context, { action: 'empty_trash', deletedCount: purged.deletedCount });

  return { ok: true, deletedCount: purged.deletedCount, status: 'trash_emptied' };
}

async function executeSetReminder(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);

  const memoId = typeof args.memoId === 'string' && args.memoId.trim() ? args.memoId.trim() : null;
  const clear = Boolean(args.clear);
  const reminderTime = clear ? null : parseOptionalTimestamp(args.reminderTime, 'reminderTime');
  const dueDateInput = clear ? null : parseOptionalTimestamp(args.dueDate, 'dueDate');
  const dueDate = dueDateInput !== undefined ? dueDateInput : (reminderTime !== undefined ? reminderTime : undefined);
  const reminderLocation = clear
    ? null
    : args.reminderLocation === null
      ? null
      : typeof args.reminderLocation === 'string'
        ? args.reminderLocation.slice(0, 500)
        : undefined;

  if (!clear && reminderTime === undefined && dueDate === undefined) {
    throw new Error('Provide reminderTime and/or dueDate (or set clear=true).');
  }

  if (memoId) {
    const updated = updateMemo(
      context.dbCtx,
      memoId,
      workspaceId,
      {
        dueDate,
        reminderTime,
        reminderLocation,
        priority: typeof args.priority === 'string' && (VALID_PRIORITIES as readonly string[]).includes(args.priority)
          ? (args.priority as MemoPriority)
          : undefined,
        tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
      },
      context.userId
    );
    emitWorkspaceChange(context, { action: 'set_reminder', memoId: updated.id });
    return {
      ok: true,
      status: clear ? 'reminder_cleared' : 'reminder_set',
      memoId: updated.id,
      title: updated.title,
      reminderTime: updated.reminderTime,
      dueDate: updated.dueDate,
      reminderLocation: updated.reminderLocation,
    };
  }

  const title = String(args.title ?? '').trim().slice(0, 200);
  if (!title) {
    throw new Error('Provide either memoId to update an existing note or title to create a new reminder.');
  }
  const content = typeof args.content === 'string' && args.content.trim()
    ? args.content.slice(0, 200_000)
    : `Scheduled reminder: ${title}`;

  const created = createMemo(
    context.dbCtx,
    {
      workspaceId,
      title,
      content,
      dueDate: dueDate ?? null,
      reminderTime: reminderTime ?? null,
      reminderLocation: reminderLocation ?? null,
      priority: typeof args.priority === 'string' && (VALID_PRIORITIES as readonly string[]).includes(args.priority)
        ? (args.priority as MemoPriority)
        : 'medium',
      tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
    },
    context.userId
  );

  context.onNoteCreated?.({ id: created.id, title: created.title });
  context.emitUiEvent?.('note_saved', { memoId: created.id, title: created.title, autoApproved: true });
  emitWorkspaceChange(context, { action: 'create_reminder', memoId: created.id });

  return {
    ok: true,
    status: 'reminder_created',
    memoId: created.id,
    title: created.title,
    reminderTime: created.reminderTime,
    dueDate: created.dueDate,
    reminderLocation: created.reminderLocation,
  };
}

async function executeGetCalendarSchedule(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);

  const startMs = parseOptionalTimestamp(args.startDate, 'startDate') ?? undefined;
  const endMs = parseOptionalTimestamp(args.endDate, 'endDate') ?? undefined;

  const listed = listMemos(context.dbCtx, {
    workspaceId,
    hasReminder: true,
    isArchived: false,
    limit: 100,
  });

  const events = listed.memos
    .map((m) => {
      const blocked = getNoteAiAccess(context.dbCtx, m.id, workspaceId) === 'blocked';
      const at = m.reminderTime ?? m.dueDate;
      return {
        memoId: m.id,
        title: blocked ? '[Blocked Note]' : scanAndRedactSecrets(m.title || 'Untitled').text,
        dueDate: m.dueDate,
        dueDateIso: m.dueDate ? new Date(m.dueDate).toISOString() : null,
        reminderTime: m.reminderTime,
        reminderTimeIso: m.reminderTime ? new Date(m.reminderTime).toISOString() : null,
        reminderLocation: blocked ? null : m.reminderLocation,
        priority: m.priority,
        status: m.status,
        sortAt: at ?? 0,
      };
    })
    .filter((ev) => {
      if (startMs !== undefined && ev.sortAt < startMs) return false;
      if (endMs !== undefined && ev.sortAt > endMs) return false;
      return true;
    })
    .sort((a, b) => a.sortAt - b.sortAt)
    .map(({ sortAt: _ignored, ...rest }) => rest);

  const notifRes = listNotifications(context.dbCtx, context.userId, { includeRead: false, limit: 20 });

  return {
    nowIso: new Date().toISOString(),
    scheduledCount: events.length,
    events,
    unreadNotifications: notifRes.unread,
    notifications: notifRes.notifications,
  };
}

async function executeListNotifications(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const includeRead = typeof args.includeRead === 'boolean' ? args.includeRead : true;
  const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 25;
  return listNotifications(context.dbCtx, context.userId, { includeRead, limit });
}

async function executeMarkNotificationsRead(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  if (args.all === true || !args.notificationId) {
    const marked = markAllNotificationsRead(context.dbCtx, context.userId);
    context.emitUiEvent?.('notifications_changed', { all: true, marked });
    return { ok: true, markedAll: true, count: marked };
  }
  const ok = markNotificationRead(context.dbCtx, context.userId, String(args.notificationId));
  if (!ok) throw new Error('Notification not found');
  context.emitUiEvent?.('notifications_changed', { notificationId: String(args.notificationId) });
  return { ok: true, notificationId: String(args.notificationId) };
}

function formatStorageSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

async function executeManageWorkspaces(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const action = String(args.action ?? 'list');

  if (action === 'list') {
    const rows = context.dbCtx.sqlite
      .prepare(
        `SELECT w.id, w.name, w.slug, w.description, wm.role
         FROM workspaces w
         JOIN workspace_members wm ON w.id = wm.workspace_id
         WHERE wm.user_id = ?
         ORDER BY w.created_at ASC`
      )
      .all(context.userId) as Array<{ id: string; name: string; slug: string; description: string | null; role: string }>;
    return { activeWorkspaceId: context.workspaceId, workspaces: rows };
  }

  if (action === 'create') {
    const name = String(args.name ?? '').trim();
    if (!name) throw new Error('Workspace name is required');
    const slug = typeof args.slug === 'string' && args.slug.trim() ? args.slug.trim() : undefined;
    const workspace = createWorkspace(context.dbCtx.db, context.userId, { name, slug });
    emitWorkspaceChange(context, { action: 'create_workspace', workspaceId: workspace.id });
    return { ok: true, workspace };
  }

  const workspaceId = resolveTargetWorkspace(args, context);

  if (action === 'rename') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, ['owner', 'admin']);
    const name = String(args.name ?? '').trim();
    if (!name) throw new Error('Workspace name is required');
    const now = Date.now();
    context.dbCtx.sqlite
      .prepare('UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?')
      .run(name.slice(0, 120), now, workspaceId);
    const updated = context.dbCtx.sqlite
      .prepare('SELECT id, name, slug FROM workspaces WHERE id = ?')
      .get(workspaceId);
    emitWorkspaceChange(context, { action: 'rename_workspace', workspaceId });
    return { ok: true, workspace: updated };
  }

  if (action === 'storage') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    const attRow = context.dbCtx.sqlite
      .prepare('SELECT COALESCE(SUM(file_size), 0) AS total FROM attachments WHERE workspace_id = ?')
      .get(workspaceId) as { total: number } | undefined;
    const memoRow = context.dbCtx.sqlite
      .prepare('SELECT COALESCE(SUM(LENGTH(CAST(title AS BLOB)) + LENGTH(CAST(content AS BLOB))), 0) AS total FROM memos WHERE workspace_id = ? AND deleted_at IS NULL')
      .get(workspaceId) as { total: number } | undefined;
    const totalBytes = Number(attRow?.total || 0) + Number(memoRow?.total || 0);
    const maxBytes = config.storageQuotaBytes;
    const percentUsed = Math.min(100, Math.max(totalBytes > 0 ? 0.1 : 0, Number((totalBytes / maxBytes * 100).toFixed(1))));
    return {
      workspaceId,
      totalBytes,
      usedFormatted: formatStorageSize(totalBytes),
      maxBytes,
      maxFormatted: `${(maxBytes / (1024 * 1024 * 1024)).toFixed(0)} GB`,
      percentUsed,
    };
  }

  if (action === 'members') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    const members = context.dbCtx.sqlite
      .prepare(
        `SELECT wm.id, wm.role, wm.created_at as joinedAt, u.id as userId, u.name, u.email
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ?
         ORDER BY wm.created_at ASC`
      )
      .all(workspaceId);
    return { workspaceId, members };
  }

  if (action === 'activities') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    const memoEvents = context.dbCtx.sqlite
      .prepare(
        `SELECT mv.id as id, 'note_edited' as type, mv.title as detail, mv.created_at as timestamp,
                u.name as userName, m.id as targetId
         FROM memo_versions mv
         JOIN memos m ON m.id = mv.memo_id
         JOIN users u ON u.id = mv.changed_by
         WHERE m.workspace_id = ?
         ORDER BY mv.created_at DESC
         LIMIT 25`
      )
      .all(workspaceId) as Array<{ id: string; type: string; detail: string; timestamp: number; userName: string; targetId: string }>;
    const memberEvents = context.dbCtx.sqlite
      .prepare(
        `SELECT wm.id as id, 'member_joined' as type, wm.role as detail, wm.created_at as timestamp,
                u.name as userName, u.id as targetId
         FROM workspace_members wm
         JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ?
         ORDER BY wm.created_at DESC
         LIMIT 25`
      )
      .all(workspaceId) as Array<{ id: string; type: string; detail: string; timestamp: number; userName: string; targetId: string }>;
    const noteCreations = context.dbCtx.sqlite
      .prepare(
        `SELECT m.id as id, 'note_created' as type, m.title as detail, m.created_at as timestamp,
                u.name as userName, m.id as targetId
         FROM memos m
         JOIN users u ON u.id = m.created_by
         WHERE m.workspace_id = ?
         ORDER BY m.created_at DESC
         LIMIT 25`
      )
      .all(workspaceId) as Array<{ id: string; type: string; detail: string; timestamp: number; userName: string; targetId: string }>;

    const activities = [...memoEvents, ...memberEvents, ...noteCreations]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 40)
      .map((ev) => {
        if (ev.type === 'note_edited' || ev.type === 'note_created') {
          const blocked = getNoteAiAccess(context.dbCtx, ev.targetId, workspaceId) === 'blocked';
          return {
            ...ev,
            detail: blocked ? '[Blocked Note]' : scanAndRedactSecrets(ev.detail || 'Untitled').text,
          };
        }
        return ev;
      });
    return { workspaceId, activities };
  }

  if (action === 'leave') {
    leaveWorkspace(context.dbCtx.db, context.userId, workspaceId);
    emitWorkspaceChange(context, { action: 'leave_workspace', workspaceId });
    return { ok: true, workspaceId, status: 'left' };
  }

  if (action === 'change_role') {
    const targetUserId = String(args.targetUserId ?? '').trim();
    const role = String(args.role ?? '').trim();
    if (!targetUserId || !role) throw new Error('targetUserId and role are required');
    const member = changeMemberRole(context.dbCtx.db, context.userId, workspaceId, targetUserId, role);
    emitWorkspaceChange(context, { action: 'change_member_role', workspaceId, targetUserId, role });
    return { ok: true, workspaceId, member };
  }

  if (action === 'remove_member') {
    const targetUserId = String(args.targetUserId ?? '').trim();
    if (!targetUserId) throw new Error('targetUserId is required');
    removeWorkspaceMember(context.dbCtx.db, context.userId, workspaceId, targetUserId);
    emitWorkspaceChange(context, { action: 'remove_member', workspaceId, targetUserId });
    return { ok: true, workspaceId, removedUserId: targetUserId };
  }

  if (action === 'transfer_ownership') {
    const targetUserId = String(args.targetUserId ?? '').trim();
    if (!targetUserId) throw new Error('targetUserId is required');
    const transferred = transferWorkspaceOwnership(context.dbCtx.db, context.userId, workspaceId, targetUserId);
    emitWorkspaceChange(context, { action: 'transfer_ownership', workspaceId, newOwnerId: transferred.newOwnerId });
    return { ok: true, ...transferred };
  }

  throw new Error(`Unsupported workspace action: ${action}`);
}

async function executeManageInvites(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const action = String(args.action ?? 'list');
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, ['owner', 'admin']);

  if (action === 'list') {
    return { workspaceId, invites: listInvites(context.dbCtx, workspaceId) };
  }

  if (action === 'create') {
    const email = String(args.email ?? '').trim();
    const role = typeof args.role === 'string' && ['viewer', 'editor', 'admin'].includes(args.role) ? args.role : 'editor';
    const created = createInvite(context.dbCtx, {
      workspaceId,
      email,
      role,
      invitedByUserId: context.userId,
      appUrl: resolveAppUrl(),
    });
    emitWorkspaceChange(context, { action: 'create_invite', workspaceId, inviteId: created.invite.id });
    return {
      ok: true,
      workspaceId,
      inviteId: created.invite.id,
      email: created.invite.email,
      role: created.invite.role,
      status: created.invite.status,
      expiresAt: created.invite.expiresAt,
      inviteUrl: created.inviteUrl,
    };
  }

  if (action === 'revoke') {
    const inviteId = String(args.inviteId ?? '').trim();
    if (!inviteId) throw new Error('inviteId is required');
    const revoked = revokeInvite(context.dbCtx, workspaceId, inviteId);
    if (!revoked) throw new Error('Pending invitation not found');
    emitWorkspaceChange(context, { action: 'revoke_invite', workspaceId, inviteId });
    return { ok: true, workspaceId, revokedInviteId: inviteId };
  }

  throw new Error(`Unsupported invite action: ${action}`);
}

async function fetchSafeLinkPreview(url: string): Promise<{
  url: string;
  title: string;
  description?: string;
  imageUrl?: string;
  faviconUrl: string;
}> {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('Valid http or https URL is required');
  }
  const parsed = new URL(url);
  const fallback = {
    url,
    title: parsed.hostname,
    faviconUrl: `${parsed.origin}/favicon.ico`,
  };

  await assertPublicHttpUrl(url);
  let res = await guardedFetch(url, { timeoutMs: 4000, maxBytes: 256 * 1024 });
  let redirects = 0;
  while (res.status >= 300 && res.status < 400) {
    const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
    if (!location || redirects++ >= 3) return fallback;
    const nextUrl = new URL(location, res.url);
    res = await guardedFetch(nextUrl, { timeoutMs: 4000, maxBytes: 256 * 1024 });
  }
  if (res.status < 200 || res.status >= 300) return fallback;

  const html = res.body;
  const getMeta = (prop: string) => {
    const m = html.match(new RegExp(`<meta\\s+[^>]*(?:property|name)=["'](?:og:)?${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))
      || html.match(new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:)?${prop}["']`, 'i'));
    return m ? m[1].trim() : undefined;
  };
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = getMeta('title') || (titleMatch ? titleMatch[1].trim() : parsed.hostname);
  const description = getMeta('description');
  let imageUrl = getMeta('image');
  if (imageUrl && !imageUrl.startsWith('http')) {
    try {
      imageUrl = new URL(imageUrl, parsed.origin).href;
    } catch {
      imageUrl = undefined;
    }
  }
  return {
    url,
    title: title || parsed.hostname,
    description,
    imageUrl,
    faviconUrl: `${parsed.origin}/favicon.ico`,
  };
}

async function executeManageNoteExtras(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const action = String(args.action ?? 'versions');
  const workspaceId = resolveTargetWorkspace(args, context);

  if (action === 'versions') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    const memoId = String(args.memoId ?? '').trim();
    if (!memoId) throw new Error('memoId is required');
    if (getNoteAiAccess(context.dbCtx, memoId, workspaceId) === 'blocked') {
      audit(context.dbCtx, context.userId, workspaceId, 'send_blocked', memoId, context.provider ?? null, 0);
      throw new Error('This note is marked "never share with AI" and its revision history cannot be read.');
    }
    const versions = getMemoVersions(context.dbCtx, memoId, workspaceId).map((v) => {
      const protectedRes = redactProtectedSections(context.dbCtx, memoId, v.content || '');
      return {
        id: v.id,
        memoId: v.memoId,
        versionNumber: v.versionNumber,
        title: scanAndRedactSecrets(v.title || 'Untitled').text,
        content: scanAndRedactSecrets(protectedRes.text).text.slice(0, 10_000),
        changedBy: v.changedBy,
        createdAt: v.createdAt,
      };
    });
    return { workspaceId, memoId, versions };
  }

  if (action === 'reorder') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
    const memoIds = Array.isArray(args.memoIds)
      ? args.memoIds.map((id) => String(id).trim()).filter(Boolean)
      : [];
    if (memoIds.length === 0) throw new Error('memoIds array is required');
    reorderMemos(context.dbCtx, workspaceId, memoIds);
    emitWorkspaceChange(context, { action: 'reorder_memos', workspaceId, count: memoIds.length });
    return { ok: true, workspaceId, reorderedCount: memoIds.length, memoIds };
  }

  if (action === 'link_preview') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    const url = String(args.url ?? '').trim();
    const preview = await fetchSafeLinkPreview(url);
    const attachToMemo = Boolean(args.attachToMemo);
    const memoId = typeof args.memoId === 'string' && args.memoId.trim() ? args.memoId.trim() : null;
    if (attachToMemo) {
      verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
      if (!memoId) throw new Error('memoId is required when attachToMemo is true');
      const existing = getMemoById(context.dbCtx, memoId, workspaceId);
      if (!existing) throw new Error('Note not found');
      const merged = [...existing.linkPreviews.filter((p) => p.url !== preview.url), preview].slice(-20);
      updateMemo(context.dbCtx, memoId, workspaceId, { linkPreviews: merged }, context.userId);
      emitWorkspaceChange(context, { action: 'attach_link_preview', workspaceId, memoId });
    }
    return { ok: true, workspaceId, preview, attachedToMemoId: attachToMemo ? memoId : null };
  }

  throw new Error(`Unsupported note extras action: ${action}`);
}

async function executeManageAttachments(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const action = String(args.action ?? 'list');
  const workspaceId = resolveTargetWorkspace(args, context);

  if (action === 'list') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    const memoId = typeof args.memoId === 'string' && args.memoId.trim() ? args.memoId.trim() : null;
    if (memoId && getNoteAiAccess(context.dbCtx, memoId, workspaceId) === 'blocked') {
      audit(context.dbCtx, context.userId, workspaceId, 'send_blocked', memoId, context.provider ?? null, 0);
      throw new Error('This note is marked "never share with AI" and its attachments cannot be listed.');
    }

    const rows = (memoId
      ? context.dbCtx.sqlite
          .prepare(
            `SELECT id, memo_id as memoId, file_name as fileName, file_size as fileSize, mime_type as mimeType, created_at as createdAt
             FROM attachments WHERE workspace_id = ? AND memo_id = ? ORDER BY created_at DESC`
          )
          .all(workspaceId, memoId)
      : context.dbCtx.sqlite
          .prepare(
            `SELECT id, memo_id as memoId, file_name as fileName, file_size as fileSize, mime_type as mimeType, created_at as createdAt
             FROM attachments WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100`
          )
          .all(workspaceId)
    ) as Array<{ id: string; memoId: string; fileName: string; fileSize: number; mimeType: string; createdAt: number }>;

    const attachments = rows.filter((r) => getNoteAiAccess(context.dbCtx, r.memoId, workspaceId) !== 'blocked');
    return { workspaceId, attachments };
  }

  if (action === 'delete') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
    const attachmentId = String(args.attachmentId ?? '').trim();
    if (!attachmentId) throw new Error('attachmentId is required');
    const row = context.dbCtx.sqlite
      .prepare('SELECT id, memo_id as memoId, file_name as fileName, storage_path as storagePath FROM attachments WHERE id = ? AND workspace_id = ?')
      .get(attachmentId, workspaceId) as { id: string; memoId: string; fileName: string; storagePath: string } | undefined;
    if (!row) throw new Error('Attachment not found');

    context.dbCtx.sqlite.prepare('DELETE FROM attachments WHERE id = ? AND workspace_id = ?').run(row.id, workspaceId);
    try {
      await fs.unlink(row.storagePath);
    } catch {
      // ignore missing file
    }
    emitWorkspaceChange(context, { action: 'delete_attachment', workspaceId, memoId: row.memoId, attachmentId: row.id });
    return { ok: true, workspaceId, deletedAttachmentId: row.id, fileName: row.fileName };
  }

  throw new Error(`Unsupported attachment action: ${action}`);
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function formatIcsUtcTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function executeExportData(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const format = String(args.format ?? 'workspace_json');
  const workspaceId = resolveTargetWorkspace(args, context);
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);

  const includeArchived = Boolean(args.includeArchived);
  const includeDeleted = Boolean(args.includeDeleted);
  const exported = exportWorkspaceData(context.dbCtx, workspaceId);

  let omittedBlockedCount = 0;
  const safeMemos = [];
  for (const memo of exported.memos) {
    if (!includeDeleted && memo.deletedAt) continue;
    if (!includeArchived && memo.isArchived) continue;
    if (getNoteAiAccess(context.dbCtx, memo.id, workspaceId) === 'blocked') {
      omittedBlockedCount++;
      continue;
    }
    const protectedText = redactProtectedSections(context.dbCtx, memo.id, memo.content || '');
    safeMemos.push({
      id: memo.id,
      title: scanAndRedactSecrets(memo.title || 'Untitled').text,
      content: scanAndRedactSecrets(protectedText.text).text.slice(0, 10_000),
      noteType: memo.noteType,
      checklistData: (memo.checklistData as ChecklistItem[]).map((c: ChecklistItem) => ({
        ...c,
        text: scanAndRedactSecrets(c.text).text,
      })),
      tags: memo.tags,
      folderId: memo.folderId,
      categoryId: memo.categoryId,
      priority: memo.priority,
      status: memo.status,
      dueDate: memo.dueDate,
      reminderTime: memo.reminderTime,
      reminderLocation: memo.reminderLocation,
      isPinned: memo.isPinned,
      isFavorite: memo.isFavorite,
      isArchived: memo.isArchived,
      deletedAt: memo.deletedAt,
      updatedAt: memo.updatedAt,
    });
  }

  if (format === 'calendar_ics') {
    const dtStamp = formatIcsUtcTimestamp(Date.now());
    const scheduled = safeMemos.filter((m) => !m.deletedAt && (m.reminderTime || m.dueDate));
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Pocket Diary//Calendar Export//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
    ];
    for (const m of scheduled) {
      const startMs = m.reminderTime ?? m.dueDate!;
      const endMs = startMs + 30 * 60 * 1000;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${m.id}@pocket-diary`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${formatIcsUtcTimestamp(startMs)}`,
        `DTEND:${formatIcsUtcTimestamp(endMs)}`,
        `SUMMARY:${escapeIcsText(m.title)}`,
      );
      if (m.content.trim()) {
        lines.push(`DESCRIPTION:${escapeIcsText(m.content.slice(0, 500))}`);
      }
      if (m.reminderLocation) {
        lines.push(`LOCATION:${escapeIcsText(m.reminderLocation)}`);
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');

    return {
      ok: true,
      workspaceId,
      format: 'calendar_ics',
      filename: `pocket-diary-${workspaceId.slice(0, 8)}.ics`,
      eventCount: scheduled.length,
      omittedBlockedCount,
      icsContent: lines.join('\r\n'),
    };
  }

  if (format === 'workspace_json') {
    return {
      ok: true,
      workspaceId,
      format: 'workspace_json',
      exportedAt: exported.exportedAt,
      omittedBlockedCount,
      categories: exported.categories,
      tags: exported.tags,
      folders: exported.folders,
      memos: safeMemos,
    };
  }

  throw new Error(`Unsupported export format: ${format}`);
}

async function executeManageFolders(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const action = String(args.action ?? 'list');
  const workspaceId = resolveTargetWorkspace(args, context);

  if (action === 'list') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    return { folders: listFolders(context.dbCtx, workspaceId) };
  }
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
  if (action === 'create') {
    const folder = createFolder(context.dbCtx, workspaceId, {
      name: String(args.name ?? ''),
      parentId: args.parentId === null ? null : typeof args.parentId === 'string' ? args.parentId : undefined,
    });
    emitWorkspaceChange(context, { action: 'create_folder', folderId: folder.id });
    return { ok: true, folder };
  }
  if (action === 'update') {
    const folderId = String(args.folderId ?? '').trim();
    if (!folderId) throw new Error('folderId is required');
    const folder = updateFolder(context.dbCtx, folderId, workspaceId, {
      name: typeof args.name === 'string' ? args.name : undefined,
      parentId: args.parentId === null ? null : typeof args.parentId === 'string' ? args.parentId : undefined,
    });
    emitWorkspaceChange(context, { action: 'update_folder', folderId: folder.id });
    return { ok: true, folder };
  }
  if (action === 'delete') {
    const folderId = String(args.folderId ?? '').trim();
    if (!folderId) throw new Error('folderId is required');
    deleteFolder(context.dbCtx, folderId, workspaceId);
    emitWorkspaceChange(context, { action: 'delete_folder', folderId });
    return { ok: true, deletedFolderId: folderId };
  }
  throw new Error(`Unsupported folder action: ${action}`);
}

async function executeManageCategories(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const action = String(args.action ?? 'list');
  const workspaceId = resolveTargetWorkspace(args, context);

  if (action === 'list') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    return { categories: listCategories(context.dbCtx, workspaceId) };
  }
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
  if (action === 'create') {
    const category = createCategory(context.dbCtx, workspaceId, {
      name: String(args.name ?? ''),
      color: args.color === null ? null : typeof args.color === 'string' ? args.color : undefined,
      icon: args.icon === null ? null : typeof args.icon === 'string' ? args.icon : undefined,
    });
    emitWorkspaceChange(context, { action: 'create_category', categoryId: category.id });
    return { ok: true, category };
  }
  if (action === 'update') {
    const categoryId = String(args.categoryId ?? '').trim();
    if (!categoryId) throw new Error('categoryId is required');
    const category = updateCategory(context.dbCtx, categoryId, workspaceId, {
      name: typeof args.name === 'string' ? args.name : undefined,
      color: args.color === null ? null : typeof args.color === 'string' ? args.color : undefined,
      icon: args.icon === null ? null : typeof args.icon === 'string' ? args.icon : undefined,
    });
    emitWorkspaceChange(context, { action: 'update_category', categoryId: category.id });
    return { ok: true, category };
  }
  if (action === 'delete') {
    const categoryId = String(args.categoryId ?? '').trim();
    if (!categoryId) throw new Error('categoryId is required');
    deleteCategory(context.dbCtx, categoryId, workspaceId);
    emitWorkspaceChange(context, { action: 'delete_category', categoryId });
    return { ok: true, deletedCategoryId: categoryId };
  }
  throw new Error(`Unsupported category action: ${action}`);
}

async function executeManageTags(args: Record<string, unknown>, context: ToolContext): Promise<unknown> {
  const action = String(args.action ?? 'list');
  const workspaceId = resolveTargetWorkspace(args, context);

  if (action === 'list') {
    verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId);
    return { tags: listTags(context.dbCtx, workspaceId) };
  }
  verifyWorkspaceMembership(context.dbCtx.db, context.userId, workspaceId, WRITE_ROLES);
  if (action === 'create') {
    const tag = createTag(context.dbCtx, workspaceId, String(args.name ?? ''));
    emitWorkspaceChange(context, { action: 'create_tag', tagId: tag.id });
    return { ok: true, tag };
  }
  if (action === 'rename') {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) throw new Error('tagId is required');
    const tag = renameTag(context.dbCtx, tagId, workspaceId, String(args.name ?? ''));
    emitWorkspaceChange(context, { action: 'rename_tag', tagId: tag.id });
    return { ok: true, tag };
  }
  if (action === 'delete') {
    const tagId = String(args.tagId ?? '').trim();
    if (!tagId) throw new Error('tagId is required');
    deleteTag(context.dbCtx, tagId, workspaceId);
    emitWorkspaceChange(context, { action: 'delete_tag', tagId });
    return { ok: true, deletedTagId: tagId };
  }
  throw new Error(`Unsupported tag action: ${action}`);
}

/** Get tool definitions exposed to providers. */
export function getToolDefinitions(): ToolDefinition[] {
  return BUILTIN_TOOLS;
}
