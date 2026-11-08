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
  id: text('id').primaryKey(), // SHA-256 hash of the 256-bit cookie token (audit H-7)
  /**
   * Opaque identifier exposed through the API so users can revoke individual
   * devices (audit L-8) without ever revealing the token hash or making it
   * guessable.
   */
  publicId: text('public_id').notNull().default(''),
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
  index('idx_sessions_public_id').on(table.publicId),
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
  /**
   * Audit H-2: the user who set the effective reminder
   * (COALESCE(reminder_time, due_date)). Reminders notify exactly this
   * person — never the whole workspace.
   */
  reminderSetBy: text('reminder_set_by').references(() => users.id),
  collaborators: text('collaborators').notNull().default('[]'), // JSON array of collaborator emails
  checklistData: text('checklist_data').notNull().default('[]'), // JSON array of items: [{id, text, completed}]
  /**
   * AI privacy policy for this note (AI feature). Governs THIRD-PARTY AI
   * disclosure only — it never changes ordinary authorized manual search or
   * workspace read permissions.
   *  - blocked:       never expose content OR identifying metadata to an
   *                   external model (overrules every other setting).
   *  - current_only:  default. Content may be sent only for an explicit
   *                   user-initiated current-note task backed by a live grant.
   *  - search_allowed: user opted into potential AI search analysis; external
   *                   reading still requires per-task selection/consent.
   */
  aiAccess: text('ai_access').notNull().default('current_only'),
  linkPreviews: text('link_previews').notNull().default('[]'), // JSON array of {url, title, description, imageUrl, faviconUrl}
  /**
   * Optional idempotency key supplied by native/offline clients on create.
   * UNIQUE per workspace (idx_memos_client_id): replaying the same clientId
   * returns the original memo instead of duplicating it. Never editable.
   */
  clientId: text('client_id'),
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
  uniqueIndex('idx_memos_client_id').on(table.workspaceId, table.clientId),
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
// Stores the SHA-256 hash of the invitation token (audit H-7): the raw token
// is returned to the invader exactly once and never persisted.
export const workspaceInvites = sqliteTable('workspace_invites', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull().default('editor'), // viewer, editor, admin
  token: text('token').notNull().unique(), // sha256(raw token)
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

// 16. AI Provider Configurations (BYOK — user-supplied keys, encrypted at rest)
export const aiProviderConfigs = sqliteTable('ai_provider_configs', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** openai | gemini | deepseek | nvidia_nim */
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  modelId: text('model_id').notNull(),
  /** AES-256-GCM ciphertext (base64). Never returned by any API. */
  keyCiphertext: text('key_ciphertext').notNull(),
  keyNonce: text('key_nonce').notNull(),
  keyAuthTag: text('key_auth_tag').notNull(),
  encryptionKeyVersion: integer('encryption_key_version').notNull().default(1),
  /** Last 4 characters for masked UI display only. */
  keyLast4: text('key_last4').notNull().default(''),
  isDefault: integer('is_default').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => [
  index('idx_ai_provider_configs_user_id').on(table.userId),
]);

// 17. AI Conversations (server-persisted per user + workspace)
export const aiConversations = sqliteTable('ai_conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title').notNull().default('New chat'),
  lastProviderConfigId: text('last_provider_config_id'),
  /** Optional user preference: auto-save explicitly requested new notes without extra confirmation. */
  autoSaveNotes: integer('auto_save_notes').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
}, (table) => [
  index('idx_ai_conversations_user_workspace').on(table.userId, table.workspaceId, table.updatedAt),
]);

// 18. AI Messages (dialogue + safe provenance metadata only — never raw tool payloads)
export const aiMessages = sqliteTable('ai_messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => aiConversations.id, { onDelete: 'cascade' }),
  /** user | assistant */
  role: text('role').notNull(),
  content: text('content').notNull().default(''),
  /** pending | complete | failed | interrupted */
  status: text('status').notNull().default('complete'),
  provider: text('provider'),
  model: text('model'),
  /** Idempotency key supplied by the client (unique per conversation when present). */
  clientMessageId: text('client_message_id'),
  /** JSON array of safe source references: [{noteId, version, grantId, kind}] */
  sources: text('sources').notNull().default('[]'),
  /** Safe metadata JSON: {scope, usage:{inputTokens,outputTokens}, suggestions?: string[], proposalIds?: string[]} */
  meta: text('meta').notNull().default('{}'),
  /** Safe error category (never raw provider output). */
  errorCode: text('error_code'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_ai_messages_conversation').on(table.conversationId, table.createdAt),
  uniqueIndex('idx_ai_messages_client_idem').on(table.conversationId, table.clientMessageId),
]);

// 19. AI Requests (durable generation jobs — survive drawer hide/refresh/reconnect)
export const aiRequests = sqliteTable('ai_requests', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => aiConversations.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  messageId: text('message_id'),
  /** queued | running | complete | failed | interrupted | canceled */
  status: text('status').notNull().default('queued'),
  /** Safe error category: auth_error | rate_limited | network_error | provider_error | canceled | internal_error | context_error */
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  finishedAt: integer('finished_at'),
}, (table) => [
  index('idx_ai_requests_conversation').on(table.conversationId),
  index('idx_ai_requests_user_status').on(table.userId, table.status),
]);

// 20. AI Action Proposals (draft create/update actions — executed exactly once after explicit approval)
export const aiActionProposals = sqliteTable('ai_action_proposals', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id')
    .notNull()
    .references(() => aiConversations.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** create | update */
  action: text('action').notNull(),
  targetNoteId: text('target_note_id'),
  expectedNoteVersion: integer('expected_note_version'),
  /** Validated JSON payload (title/content/tags/checklistData…). */
  payload: text('payload').notNull(),
  /** pending | approved | rejected | expired | executed | conflict */
  status: text('status').notNull().default('pending'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  resultMemoId: text('result_memo_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, (table) => [
  index('idx_ai_proposals_conversation').on(table.conversationId),
  index('idx_ai_proposals_status').on(table.status, table.expiresAt),
]);

// 21. AI Note Grants (short-lived, task-scoped read authorizations)
export const aiNoteGrants = sqliteTable('ai_note_grants', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id'),
  memoId: text('memo_id')
    .notNull()
    .references(() => memos.id, { onDelete: 'cascade' }),
  /** Note version the grant was issued against. */
  noteVersion: integer('note_version').notNull(),
  /** current_note | search_excerpts */
  kind: text('kind').notNull(),
  purpose: text('purpose').notNull().default(''),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_ai_note_grants_user_memo').on(table.userId, table.memoId),
  index('idx_ai_note_grants_expires').on(table.expiresAt),
]);

// 22. AI Note Protected Sections (version-tied, hash-anchored "never share" passages)
export const aiNoteProtectedSections = sqliteTable('ai_note_protected_sections', {
  id: text('id').primaryKey(),
  memoId: text('memo_id')
    .notNull()
    .references(() => memos.id, { onDelete: 'cascade' }),
  noteVersion: integer('note_version').notNull(),
  /** sha256(salt + passage) — the passage text itself is NEVER stored. */
  passageHash: text('passage_hash').notNull(),
  /** Per-record random salt so hashes cannot be brute-forced from guesses. */
  salt: text('salt').notNull(),
  /** Length of the protected passage in characters (validation hint). */
  passageLength: integer('passage_length').notNull(),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_ai_protected_sections_memo').on(table.memoId),
]);

// 23. AI Access Audit (who authorized/sent which note IDs — no note text, no secrets)
export const aiAccessAudit = sqliteTable('ai_access_audit', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  workspaceId: text('workspace_id').notNull(),
  /** authorize | revoke | send | policy_change | protected_add | protected_remove */
  event: text('event').notNull(),
  memoId: text('memo_id'),
  provider: text('provider'),
  /** Number of redacted bytes removed before sending (metrics only). */
  redactedBytes: integer('redacted_bytes').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_ai_access_audit_user').on(table.userId, table.createdAt),
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

export type AiProviderConfig = typeof aiProviderConfigs.$inferSelect;
export type NewAiProviderConfig = typeof aiProviderConfigs.$inferInsert;

export type AiConversation = typeof aiConversations.$inferSelect;
export type NewAiConversation = typeof aiConversations.$inferInsert;

export type AiMessage = typeof aiMessages.$inferSelect;
export type NewAiMessage = typeof aiMessages.$inferInsert;

export type AiRequest = typeof aiRequests.$inferSelect;
export type NewAiRequest = typeof aiRequests.$inferInsert;

export type AiActionProposal = typeof aiActionProposals.$inferSelect;
export type NewAiActionProposal = typeof aiActionProposals.$inferInsert;

export type AiNoteGrant = typeof aiNoteGrants.$inferSelect;
export type NewAiNoteGrant = typeof aiNoteGrants.$inferInsert;

export type AiNoteProtectedSection = typeof aiNoteProtectedSections.$inferSelect;
export type NewAiNoteProtectedSection = typeof aiNoteProtectedSections.$inferInsert;

export type AiAccessAudit = typeof aiAccessAudit.$inferSelect;
export type NewAiAccessAudit = typeof aiAccessAudit.$inferInsert;
export type NewPasswordReset = typeof passwordResets.$inferInsert;
