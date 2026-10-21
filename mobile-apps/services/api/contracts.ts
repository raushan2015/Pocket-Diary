/**
 * Zod contracts for the Pocket Diary API — derived from
 * backend/src/services/*.ts response shapes (see mobile-apps/ARCHITECTURE.md §1).
 *
 * Parsing is *forward-tolerant*: unknown fields are allowed (passthrough) so a
 * newer server never breaks an older app, but every field the app relies on
 * is strictly validated.
 */
import { z } from 'zod';

export const SESSION_COOKIE_NAME = 'memo_session';

export const userSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    createdAt: z.number(),
    isInstanceAdmin: z.boolean().optional(),
  })
  .passthrough();
export type ApiUser = z.infer<typeof userSchema>;

export const workspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();
export type ApiWorkspace = z.infer<typeof workspaceSchema>;

export const checklistItemSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    checked: z.boolean().optional(),
    completed: z.boolean().optional(),
    sortOrder: z.number().optional(),
  })
  .passthrough();
export type ApiChecklistItem = z.infer<typeof checklistItemSchema>;

export const attachmentSchema = z
  .object({
    id: z.string(),
    memoId: z.string(),
    fileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    createdAt: z.number(),
    url: z.string(),
  })
  .passthrough();
export type ApiAttachment = z.infer<typeof attachmentSchema>;

export const memoSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    folderId: z.string().nullable().optional(),
    title: z.string(),
    content: z.string(),
    color: z.string(),
    theme: z.string(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']),
    status: z.enum(['draft', 'pending', 'in_progress', 'completed', 'archived']),
    isFavorite: z.boolean(),
    isPinned: z.boolean(),
    isArchived: z.boolean(),
    noteType: z.string(),
    sortOrder: z.number(),
    dueDate: z.number().nullable(),
    reminderTime: z.number().nullable(),
    reminderLocation: z.string().nullable(),
    collaborators: z.array(z.unknown()).optional().default([]),
    checklistData: z.array(checklistItemSchema).optional().default([]),
    linkPreviews: z.array(z.unknown()).optional().default([]),
    attachments: z.array(attachmentSchema).optional().default([]),
    categoryId: z.string().nullable().optional(),
    category: z
      .object({ id: z.string(), name: z.string(), color: z.string().nullable().optional(), icon: z.string().nullable().optional() })
      .nullable()
      .optional(),
    tags: z.array(z.string()).optional().default([]),
    clientId: z.string().nullable().optional(),
    version: z.number(),
    createdBy: z.string(),
    createdAt: z.number(),
    updatedAt: z.number(),
    deletedAt: z.number().nullable(),
  })
  .passthrough();
export type ApiMemo = z.infer<typeof memoSchema>;

export const memoListSchema = z
  .object({
    memos: z.array(memoSchema),
    total: z.number(),
    page: z.number(),
    limit: z.number(),
  })
  .passthrough();
export type ApiMemoList = z.infer<typeof memoListSchema>;

export const loginResponseSchema = z
  .object({
    user: userSchema,
    activeWorkspace: workspaceSchema.nullable().optional(),
  })
  .passthrough();

export const registerResponseSchema = z
  .object({
    user: userSchema,
    workspace: workspaceSchema,
    joinedWorkspace: workspaceSchema.optional(),
    inviteWarning: z.string().optional(),
  })
  .passthrough();

export const meResponseSchema = z
  .object({
    user: userSchema,
    workspaces: z.array(workspaceSchema),
  })
  .passthrough();

export const workspacesResponseSchema = z
  .object({ workspaces: z.array(workspaceSchema) })
  .passthrough();

export const simpleSuccessSchema = z.object({ success: z.boolean() }).passthrough();

export const folderSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    parentId: z.string().nullable(),
  })
  .passthrough();
export type ApiFolder = z.infer<typeof folderSchema>;

export const foldersResponseSchema = z.object({ folders: z.array(folderSchema) }).passthrough();

export const categorySchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    name: z.string(),
    color: z.string().nullable(),
    icon: z.string().nullable(),
  })
  .passthrough();
export type ApiCategory = z.infer<typeof categorySchema>;

export const categoriesResponseSchema = z.object({ categories: z.array(categorySchema) }).passthrough();

export const tagSchema = z
  .object({ id: z.string(), workspaceId: z.string(), name: z.string() })
  .passthrough();
export type ApiTag = z.infer<typeof tagSchema>;

export const tagsResponseSchema = z.object({ tags: z.array(tagSchema) }).passthrough();

export const notificationSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    memoId: z.string(),
    type: z.string(),
    title: z.string(),
    body: z.string().nullable(),
    reminderTime: z.number().nullable(),
    readAt: z.number().nullable(),
    createdAt: z.number(),
  })
  .passthrough();
export type ApiNotification = z.infer<typeof notificationSchema>;

export const notificationsResponseSchema = z
  .object({ notifications: z.array(notificationSchema), unread: z.number() })
  .passthrough();

export const sessionSchema = z
  .object({
    id: z.string(),
    current: z.boolean(),
    ipAddress: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
    createdAt: z.number(),
    expiresAt: z.number(),
  })
  .passthrough();
export type ApiSession = z.infer<typeof sessionSchema>;

export const sessionsResponseSchema = z.object({ sessions: z.array(sessionSchema) }).passthrough();

export const attachmentsListSchema = z.object({ attachments: z.array(attachmentSchema) }).passthrough();

export const healthSchema = z
  .object({ status: z.literal('ok'), timestamp: z.number() })
  .passthrough();

export const systemInfoSchema = z
  .object({
    name: z.literal('pocket-diary'),
    version: z.string(),
    apiPrefix: z.string(),
    capabilities: z
      .object({
        memoClientId: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type ApiSystemInfo = z.infer<typeof systemInfoSchema>;

export const storageSchema = z
  .object({
    totalBytes: z.number(),
    usedFormatted: z.string(),
    maxBytes: z.number(),
    maxFormatted: z.string(),
    percentUsed: z.number(),
  })
  .passthrough();
