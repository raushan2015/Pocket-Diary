/**
 * Note domain model shared by UI, repositories and the sync engine.
 */
import type { NoteColorId } from '@/theme/tokens';

export type SyncState = 'synced' | 'pending' | 'conflicted' | 'error';

export type NoteStatus = 'draft' | 'pending' | 'in_progress' | 'completed' | 'archived';
export type NotePriority = 'low' | 'medium' | 'high' | 'urgent';

export interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export interface NoteAttachment {
  id: string;
  memoId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: number;
  url?: string;
}

export interface Note {
  /** Stable LOCAL id (never changes; server identity is `serverId`). */
  id: string;
  serverId: string | null;
  clientId: string | null;
  workspaceId: string;
  folderId: string | null;
  categoryId: string | null;
  title: string;
  content: string;
  color: NoteColorId;
  theme: string;
  priority: NotePriority;
  status: NoteStatus;
  noteType: 'text' | 'checklist';
  sortOrder: number;
  isFavorite: boolean;
  isPinned: boolean;
  isArchived: boolean;
  dueDate: number | null;
  reminderTime: number | null;
  reminderLocation: string | null;
  checklist: ChecklistItem[];
  tags: string[];
  attachments: NoteAttachment[];
  collaborators: unknown[];
  linkPreviews: unknown[];
  category: { id: string; name: string; color: string | null; icon: string | null } | null;
  serverVersion: number;
  serverUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  syncState: SyncState;
}

/** Fields the editor can change; used for optimistic local updates + outbox patches. */
export interface NotePatch {
  title?: string;
  content?: string;
  color?: NoteColorId;
  theme?: string;
  priority?: NotePriority;
  status?: NoteStatus;
  noteType?: 'text' | 'checklist';
  sortOrder?: number;
  isFavorite?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  folderId?: string | null;
  categoryId?: string | null;
  dueDate?: number | null;
  reminderTime?: number | null;
  reminderLocation?: string | null;
  checklist?: ChecklistItem[];
  tags?: string[];
}

/** Server-side PATCH body derived from a NotePatch (field names = backend contract). */
export function toServerPatch(patch: NotePatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.content !== undefined) body.content = patch.content;
  if (patch.color !== undefined) body.color = patch.color;
  if (patch.theme !== undefined) body.theme = patch.theme;
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.status !== undefined) body.status = patch.status;
  if (patch.noteType !== undefined) body.noteType = patch.noteType;
  if (patch.sortOrder !== undefined) body.sortOrder = patch.sortOrder;
  if (patch.isFavorite !== undefined) body.isFavorite = patch.isFavorite;
  if (patch.isPinned !== undefined) body.isPinned = patch.isPinned;
  if (patch.isArchived !== undefined) body.isArchived = patch.isArchived;
  if (patch.folderId !== undefined) body.folderId = patch.folderId;
  if (patch.categoryId !== undefined) body.categoryId = patch.categoryId;
  if (patch.dueDate !== undefined) body.dueDate = patch.dueDate;
  if (patch.reminderTime !== undefined) body.reminderTime = patch.reminderTime;
  if (patch.reminderLocation !== undefined) body.reminderLocation = patch.reminderLocation;
  if (patch.checklist !== undefined) {
    body.checklistData = patch.checklist.map((item) => ({
      id: item.id,
      text: item.text,
      checked: item.checked,
      completed: item.checked,
      sortOrder: patch.checklist!.indexOf(item),
    }));
  }
  if (patch.tags !== undefined) body.tags = patch.tags;
  return body;
}

export type NotesView = 'active' | 'favorites' | 'archive' | 'trash';

export type NotesSort = 'updated' | 'created' | 'title' | 'due' | 'manual';

export interface ListNotesOptions {
  view?: NotesView;
  search?: string;
  sort?: NotesSort;
  tag?: string;
  limit?: number;
  offset?: number;
}
