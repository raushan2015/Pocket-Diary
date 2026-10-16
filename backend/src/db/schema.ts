import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

// 1. Users
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // UUID
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  timezone: text('timezone').notNull().default('UTC'),
  status: text('status').notNull().default('active'), // active, suspended, pending_verification
  /** Instance administrator flag — the first registered user on the instance. Admins can view system telemetry (backup status). */
  isInstanceAdmin: integer('is_instance_admin').notNull().default(0),
  createdAt: integer('created_at').notNull(), // Unix epoch ms
  updatedAt: integer('updated_at').notNull(),
});

// 2. Sessions
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(), // 256-bit crypto token
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_sessions_user_id').on(table.userId),
  index('idx_sessions_expires_at').on(table.expiresAt),
]);

// 3. Workspaces
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// 4. Workspace Members (RBAC)
export const workspaceMembers = sqliteTable('workspace_members', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('editor'), // owner, admin, editor, viewer
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_workspace_members_unique').on(table.workspaceId, table.userId),
  index('idx_workspace_members_user_id').on(table.userId),
]);

// 5. Folders
export const folders = sqliteTable('folders', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

// 6. Categories
export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color'),
  icon: text('icon'),
  createdAt: integer('created_at').notNull(),
});

// 7. Tags
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_tags_workspace_name').on(table.workspaceId, table.name),
]);

// 8. Memos (Core Entity)
export const memos = sqliteTable('memos', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),
  categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
  title: text('title').notNull().default(''),
  content: text('content').notNull().default(''),
  color: text('color').notNull().default('default'), // default, red, orange, yellow, green, teal, blue, darkblue, purple, pink, brown, gray
  theme: text('theme').notNull().default('default'), // default, grocery, food, music, recipes, notes, places, travel, celebration
  priority: text('priority').notNull().default('medium'), // low, medium, high, urgent
  status: text('status').notNull().default('pending'), // draft, pending, in_progress, completed, archived
  isFavorite: integer('is_favorite').notNull().default(0),
  isPinned: integer('is_pinned').notNull().default(0),
  isArchived: integer('is_archived').notNull().default(0),
  noteType: text('note_type').notNull().default('text'), // text, checklist
  sortOrder: integer('sort_order').notNull().default(0),
  dueDate: integer('due_date'), // Unix epoch ms
  reminderTime: integer('reminder_time'), // Unix epoch ms for specific alarm
  reminderLocation: text('reminder_location'), // Location string or geo description
  collaborators: text('collaborators').notNull().default('[]'), // JSON array of collaborator emails
  checklistData: text('checklist_data').notNull().default('[]'), // JSON array of items: [{id, text, completed}]
  linkPreviews: text('link_previews').notNull().default('[]'), // JSON array of {url, title, description, imageUrl, faviconUrl}
  version: integer('version').notNull().default(1), // Optimistic lock counter
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'), // Soft delete timestamp
}, (table) => [
  index('idx_memos_workspace_id').on(table.workspaceId),
  index('idx_memos_status').on(table.workspaceId, table.status),
  index('idx_memos_is_archived').on(table.workspaceId, table.isArchived),
  index('idx_memos_sort_order').on(table.workspaceId, table.sortOrder),
  index('idx_memos_due_date').on(table.workspaceId, table.dueDate),
  index('idx_memos_deleted_at').on(table.workspaceId, table.deletedAt),
]);

// 9. Memo Tags (Junction)
export const memoTags = sqliteTable('memo_tags', {
  memoId: text('memo_id')
    .notNull()
    .references(() => memos.id, { onDelete: 'cascade' }),
  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.memoId, table.tagId] }),
]);

// 10. Memo Versions (Revision History)
export const memoVersions = sqliteTable('memo_versions', {
  id: text('id').primaryKey(),
  memoId: text('memo_id')
    .notNull()
    .references(() => memos.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  changedBy: text('changed_by')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at').notNull(),
});

// 11. Attachments
export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  memoId: text('memo_id')
    .notNull()
    .references(() => memos.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  fileName: text('file_name').notNull(),
  fileSize: integer('file_size').notNull(),
  mimeType: text('mime_type').notNull(),
  storagePath: text('storage_path').notNull(),
  createdAt: integer('created_at').notNull(),
});

// 12. Server-side Reminder Notifications
export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  memoId: text('memo_id')
    .notNull()
    .references(() => memos.id, { onDelete: 'cascade' }),
  type: text('type').notNull().default('reminder'), // reminder
  title: text('title').notNull(),
  body: text('body'),
  reminderTime: integer('reminder_time'),
  emailSentAt: integer('email_sent_at'),
  pushSentAt: integer('push_sent_at'),
  readAt: integer('read_at'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_notifications_dedup').on(table.userId, table.memoId, table.reminderTime),
  index('idx_notifications_user_read').on(table.userId, table.readAt),
  index('idx_notifications_created_at').on(table.createdAt),
]);

// 13. Web Push Subscriptions (per user, per browser)
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_push_subscriptions_user_id').on(table.userId),
]);

// 14. Workspace Invitations
export const workspaceInvites = sqliteTable('workspace_invites', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull().default('editor'), // viewer, editor, admin
  token: text('token').notNull().unique(),
  status: text('status').notNull().default('pending'), // pending, accepted, revoked
  invitedBy: text('invited_by')
    .notNull()
    .references(() => users.id),
  emailSentAt: integer('email_sent_at'),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_workspace_invites_workspace').on(table.workspaceId, table.status),
  index('idx_workspace_invites_email').on(table.email),
]);

// 15. Password Reset Tokens
// Stores a SHA-256 hash of the one-time reset token emailed to the user;
// the raw token itself is never persisted.
export const passwordResets = sqliteTable('password_resets', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: integer('expires_at').notNull(),
  usedAt: integer('used_at'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_password_resets_user_id').on(table.userId),
]);

// Type definitions inferred from schema
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMember = typeof workspaceMembers.$inferInsert;

export type Memo = typeof memos.$inferSelect;
export type NewMemo = typeof memos.$inferInsert;

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

export type MemoTag = typeof memoTags.$inferSelect;
export type NewMemoTag = typeof memoTags.$inferInsert;

export type MemoVersion = typeof memoVersions.$inferSelect;
export type NewMemoVersion = typeof memoVersions.$inferInsert;

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

export type WorkspaceInvite = typeof workspaceInvites.$inferSelect;
export type NewWorkspaceInvite = typeof workspaceInvites.$inferInsert;

export type PasswordReset = typeof passwordResets.$inferSelect;
export type NewPasswordReset = typeof passwordResets.$inferInsert;
