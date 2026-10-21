/**
 * OpenAPI (Swagger) documentation support.
 *
 * The API reference is generated from the Fastify route schemas by
 * @fastify/swagger and served as Swagger UI at `/docs`. Two properties of
 * this setup are deliberate:
 *
 * 1. **Runtime behaviour is untouched.** Fastify only acts on the
 *    `body` / `querystring` / `params` / `headers` / `response` keys of a
 *    route schema. OpenAPI-only metadata — response and parameter
 *    documentation — travels under the custom `openapi` extension key and is
 *    merged into the spec by the `transform` hook registered in `app.ts`.
 *    That keeps serialization and validation exactly as before (an incorrect
 *    response schema can never strip or mangle a live payload), while the
 *    published documentation is still complete and verified against real
 *    responses by `backend/test/docs.test.ts`.
 *
 * 2. **No secrets in the spec.** The generated document contains only route
 *    shapes and descriptions. Secrets (cookie secret, SMTP credentials,
 *    VAPID keys) are never part of any schema, and a regression test asserts
 *    that configured secret values do not appear in the rendered spec.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Route-schema extension carrying OpenAPI-only documentation. Fastify ignores
 * unknown schema keys at runtime; the `transform` hook in `app.ts` merges
 * these into the generated spec without ever activating validation or
 * serialization for them.
 */
declare module 'fastify' {
  interface FastifySchema {
    openapi?: {
      /** Documented path parameters for routes that predate params validation. */
      params?: object;
      /** Documented query parameters for routes without a runtime querystring schema. */
      querystring?: object;
      /** Documented request body for routes without a runtime body schema,
       * rendered via `body` + `consumes` (see multipartBody). */
      requestBody?: { body: object; consumes: string[] };
      /** Documented responses, keyed by HTTP status code. */
      responses?: Record<string, object>;
    };
  }
}

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };

export const API_TITLE = 'Pocket Diary SaaS API';
export const API_VERSION: string = pkg.version || '1.0.0';

/**
 * Name of the OpenAPI security scheme describing the session cookie.
 * Every authenticated route references it via `security: [{ sessionCookie: [] }]`.
 */
export const SESSION_SECURITY = [{ sessionCookie: [] }] as const;
/** Routes callable without signing in declare `security: []` explicitly. */
export const PUBLIC_SECURITY: Array<Record<string, never>> = [];

// ---------------------------------------------------------------------------
// Reference + response helpers
// ---------------------------------------------------------------------------

/** `$ref` to one of the component schemas declared in `componentSchemas`. */
export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** `$ref` array wrapper. */
export const refArray = (name: string) => ({ type: 'array', items: ref(name) });

/** Wrap a JSON schema as a documented response body. */
export const jsonResponse = (schema: object, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

/**
 * Documented multipart/form-data request body (used by the attachment
 * upload route, which has no JSON body schema). Expressed as a plain body
 * schema plus a `consumes` hint, which @fastify/swagger renders as a
 * multipart requestBody in the spec. Spec-only; Fastify never validates it.
 */
export const multipartBody = (properties: Record<string, object>, required: string[], description: string) => ({
  body: { type: 'object', required, properties, additionalProperties: false, description },
  consumes: ['multipart/form-data'],
});

/**
 * Documented path/query parameters for routes that predate schema validation
 * (spec-only; Fastify keeps accepting exactly what it accepted before).
 */
export const openapiParams = (properties: Record<string, object>, required: string[]) => ({
  params: { type: 'object', required, properties, additionalProperties: false },
});

/** Reusable parameter schema for a UUID-ish identifier path segment. */
export const idParam = (name: string, description: string) => ({
  type: 'string',
  minLength: 1,
  maxLength: 64,
  description,
});

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Malformed or invalid input (validation error, or a semantic check failed).',
  401: 'Authentication required — the `memo_session` cookie is missing, expired, or revoked.',
  403: 'Signed in, but not allowed (role too low, or the action targets another tenant).',
  404: 'The resource does not exist — or exists in a workspace you are not a member of (existence is never leaked cross-tenant).',
  409: 'Conflict with current server state (duplicate, expired token, or optimistic-concurrency version mismatch).',
  413: 'Payload too large (per-file or workspace storage quota).',
  415: 'Unsupported media type (e.g. an upload whose declared type is not allowed, or whose contents do not match it).',
  429: 'Too many requests — the per-IP or per-account rate limit was hit.',
  500: 'Internal server error.',
};

/**
 * Standard error response documentation. Codes map to the shared `Error`
 * component; extra per-route responses (e.g. the version field on a memo
 * 409) can be passed via `extra`.
 */
export const errorResponses = (codes: number[], extra: Record<number, object> = {}) => {
  const responses: Record<string, object> = {};
  for (const code of codes) {
    const merged = {
      ...jsonResponse(ref('Error'), ERROR_DESCRIPTIONS[code] ?? 'Request failed.'),
      ...(extra[code] ?? {}),
    };
    responses[String(code)] = merged;
  }
  return responses;
};

// ---------------------------------------------------------------------------
// Component schemas (referenced as #/components/schemas/<name>)
// ---------------------------------------------------------------------------

const nullableString = { type: ['string', 'null'] as Array<'string' | 'null'> };
const nullableInteger = { type: ['integer', 'null'] as Array<'integer' | 'null'> };

const errorSchema = {
  type: 'object',
  description: 'Error envelope used by every non-2xx response.',
  required: ['error', 'message'],
  properties: {
    error: { type: 'string', description: 'Short, stable error class (e.g. "Bad Request").' },
    message: { type: 'string', description: 'Human-readable explanation; safe to show to end users.' },
  },
};

const simpleSuccessSchema = {
  type: 'object',
  required: ['success'],
  properties: { success: { type: 'boolean', description: 'Always `true`.' } },
};

const userSchema = {
  type: 'object',
  description: 'The signed-in user. `timezone` is returned by profile updates; `isInstanceAdmin` only by GET /auth/me.',
  required: ['id', 'email', 'name', 'createdAt'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    timezone: { type: 'string', description: 'IANA timezone, e.g. `Asia/Tokyo` (audit M-16).' },
    isInstanceAdmin: { type: 'boolean', description: 'Instance-admin flag (first registered account on an instance).' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
  },
};

const workspaceSchema = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string', description: 'URL-safe identifier; omitted by login responses.' },
    role: { type: 'string', enum: ['owner', 'admin', 'editor', 'viewer'], description: 'Your role in this workspace; present on list/create responses.' },
  },
};

const memberSchema = {
  type: 'object',
  description: 'A workspace member.',
  required: ['id', 'userId', 'name', 'email', 'role', 'joinedAt'],
  properties: {
    id: { type: 'string', description: 'Membership row id (not the user id).' },
    userId: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['owner', 'admin', 'editor', 'viewer'] },
    joinedAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
  },
};

const inviteSchema = {
  type: 'object',
  description: 'Workspace invitation. `token` (raw, single-use) is returned only at creation; `emailSentAt` on list responses.',
  required: ['id', 'email', 'role', 'status', 'expiresAt', 'createdAt'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
    status: { type: 'string', enum: ['pending', 'accepted', 'revoked', 'expired'] },
    token: { type: 'string', description: 'Raw invite token — shown exactly once at creation; only a hash is stored.' },
    expiresAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    emailSent: { type: 'boolean', description: 'Whether the invite email was delivered (creation response).' },
    emailSentAt: { type: 'integer', nullable: true, description: 'Unix epoch milliseconds, or null if never sent (list response).' },
  },
};

const attachmentSchema = {
  type: 'object',
  description: 'Metadata about an uploaded note attachment (files are served from `url`).',
  required: ['id', 'memoId', 'fileName', 'fileSize', 'mimeType', 'createdAt', 'url'],
  properties: {
    id: { type: 'string' },
    memoId: { type: 'string' },
    fileName: { type: 'string' },
    fileSize: { type: 'integer', description: 'Bytes on disk.' },
    mimeType: { type: 'string' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    url: { type: 'string', description: 'Download/inline URL (same origin, session required).' },
  },
};

const memoSchema = {
  type: 'object',
  description: 'A note. All list/create/update/get/restore endpoints return this fully hydrated shape.',
  required: [
    'id', 'workspaceId', 'folderId', 'title', 'content', 'color', 'theme', 'priority', 'status',
    'isFavorite', 'isPinned', 'isArchived', 'noteType', 'sortOrder', 'dueDate', 'reminderTime',
    'reminderLocation', 'collaborators', 'checklistData', 'linkPreviews', 'attachments',
    'categoryId', 'category', 'tags', 'version', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt',
  ],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    folderId: { ...nullableString, description: 'Containing folder, or null.' },
    title: { type: 'string' },
    content: { type: 'string', description: 'Plain text or Markdown; data-URI images allowed for imports.' },
    color: { type: 'string', description: 'Palette color id (e.g. `default`, `blue`).' },
    theme: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: { type: 'string', enum: ['draft', 'pending', 'in_progress', 'completed', 'archived'] },
    isFavorite: { type: 'boolean' },
    isPinned: { type: 'boolean' },
    isArchived: { type: 'boolean' },
    noteType: { type: 'string', enum: ['text', 'checklist'] },
    sortOrder: { type: 'integer', description: 'Manual card order (drag & drop).' },
    dueDate: { ...nullableInteger, description: 'Unix epoch milliseconds, or null.' },
    reminderTime: { ...nullableInteger, description: 'Unix epoch milliseconds, or null.' },
    reminderLocation: { ...nullableString },
    collaborators: { type: 'array', items: { type: 'object' }, description: 'Legacy collaborator entries kept for imports.' },
    checklistData: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          checked: { type: 'boolean' },
          completed: { type: 'boolean' },
          sortOrder: { type: 'integer' },
        },
      },
    },
    linkPreviews: {
      type: 'array',
      description: 'OpenGraph previews attached to links in the note (sanitized server-side, audit L-5).',
      items: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          imageUrl: { type: 'string' },
          image: { type: 'string' },
          faviconUrl: { type: 'string' },
        },
      },
    },
    attachments: { type: 'array', items: ref('Attachment') },
    categoryId: { ...nullableString },
    category: {
      type: ['object', 'null'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        color: { ...nullableString },
        icon: { ...nullableString },
      },
    },
    tags: { type: 'array', items: { type: 'string' }, description: 'Tag names, case-insensitively unique (audit M-3).' },
    clientId: { ...nullableString, description: 'Idempotency key supplied at create time by offline-first clients (mobile-apps); null otherwise. Not editable via PATCH.' },
    version: { type: 'integer', description: 'Optimistic-concurrency counter. PATCH may send it; a stale value yields 409.' },
    createdBy: { type: 'string', description: 'User id of the author (reassigned if the author deletes their account).' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    updatedAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    deletedAt: { type: 'integer', nullable: true, description: 'Set when the note is in the trash, else null.' },
  },
};

const memoVersionSchema = {
  type: 'object',
  required: ['id', 'memoId', 'versionNumber', 'title', 'content', 'changedBy', 'createdAt'],
  properties: {
    id: { type: 'string' },
    memoId: { type: 'string' },
    versionNumber: { type: 'integer' },
    title: { type: 'string' },
    content: { type: 'string' },
    changedBy: { type: 'string', description: 'User id of the author of this revision.' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
  },
};

const folderSchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'name', 'parentId', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    name: { type: 'string' },
    parentId: { ...nullableString, description: 'Parent folder, or null for a root. Cycles are rejected (audit M-4).' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    updatedAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
  },
};

const categorySchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'name', 'color', 'icon', 'createdAt'],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    name: { type: 'string' },
    color: { ...nullableString },
    icon: { ...nullableString },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
  },
};

const tagSchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'name', 'createdAt'],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
  },
};

const notificationSchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'memoId', 'type', 'title', 'body', 'reminderTime', 'readAt', 'createdAt'],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    memoId: { type: 'string' },
    type: { type: 'string', enum: ['reminder'] },
    title: { type: 'string' },
    body: { type: 'string', nullable: true },
    reminderTime: { type: 'integer', nullable: true, description: 'The reminder instant this notification was generated from.' },
    readAt: { type: 'integer', nullable: true, description: 'Read timestamp, or null while unread.' },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
  },
};

const sessionSchema = {
  type: 'object',
  description: 'An active signed-in device. `id` is an opaque per-device identifier (audit L-8) — never the token or its hash.',
  required: ['id', 'current', 'ipAddress', 'userAgent', 'createdAt', 'expiresAt'],
  properties: {
    id: { type: 'string' },
    current: { type: 'boolean', description: 'Whether this is the device making the request.' },
    ipAddress: { ...nullableString },
    userAgent: { ...nullableString },
    createdAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    expiresAt: { type: 'integer', description: 'Unix epoch milliseconds. Slides forward while the session stays active (audit L-7).' },
  },
};

const storageUsageSchema = {
  type: 'object',
  description: 'Byte-accurate workspace storage usage (audit L-10).',
  required: ['totalBytes', 'usedFormatted', 'maxBytes', 'maxFormatted', 'percentUsed'],
  properties: {
    totalBytes: { type: 'integer' },
    usedFormatted: { type: 'string', description: 'Human-readable usage, e.g. "12.34 MB".' },
    maxBytes: { type: 'integer', description: 'Quota — configurable via the STORAGE_QUOTA_GB environment variable.' },
    maxFormatted: { type: 'string' },
    percentUsed: { type: 'number', description: '0–100 (fractional percent, minimum 0.1 when non-empty).' },
  },
};

const activitySchema = {
  type: 'object',
  description: 'Workspace activity feed entry.',
  required: ['id', 'type', 'detail', 'timestamp', 'userName', 'userEmail', 'targetId'],
  properties: {
    id: { type: 'string' },
    type: { type: 'string', enum: ['note_edited', 'note_created', 'member_joined'] },
    detail: { type: 'string', description: 'Note title for note events; the role for member events.' },
    timestamp: { type: 'integer', description: 'Unix epoch milliseconds.' },
    userName: { type: 'string' },
    userEmail: { type: 'string' },
    targetId: { type: 'string', description: 'Id of the note or membership row the event refers to.' },
  },
};

const linkPreviewSchema = {
  type: 'object',
  description: 'OpenGraph preview for a URL (fetched with SSRF protection; audit M-11).',
  required: ['url', 'title', 'faviconUrl'],
  properties: {
    url: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string', nullable: true },
    imageUrl: { type: 'string', nullable: true },
    faviconUrl: { type: 'string' },
  },
};

const backupStatusSchema = {
  type: 'object',
  description: 'Local and off-host backup snapshot status (instance admin only).',
  required: [
    'localConfigured', 'localDirectory', 'localSnapshots', 'lastBackupAt',
    'replicationConfigured', 'replicationDirectory', 'replicationSnapshots', 'lastReplicatedAt',
  ],
  properties: {
    localConfigured: { type: 'boolean' },
    localDirectory: { type: 'string', description: 'Server-side directory holding local snapshots.' },
    localSnapshots: { type: 'integer' },
    lastBackupAt: { type: 'number', nullable: true, description: 'mtime of the newest snapshot, or null.' },
    replicationConfigured: { type: 'boolean' },
    replicationDirectory: { ...nullableString },
    replicationSnapshots: { type: 'integer' },
    lastReplicatedAt: { type: 'number', nullable: true },
  },
};

const exportedWorkspaceSchema = {
  type: 'object',
  description: 'Full workspace export (import-compatible with POST /migration/import-local; includes trashed notes).',
  required: ['workspaceId', 'exportedAt', 'categories', 'tags', 'folders', 'memos'],
  properties: {
    workspaceId: { type: 'string' },
    exportedAt: { type: 'integer', description: 'Unix epoch milliseconds.' },
    categories: { type: 'array', items: ref('Category') },
    tags: { type: 'array', items: ref('Tag') },
    folders: { type: 'array', items: ref('Folder') },
    memos: { type: 'array', items: ref('Memo'), description: 'Fully hydrated memos, including trashed ones.' },
  },
};

const importResultSchema = {
  type: 'object',
  description: 'Result of a legacy/Keep import.',
  required: ['success', 'importedMemos', 'importedCategories', 'importedTags'],
  properties: {
    success: { type: 'boolean' },
    importedMemos: { type: 'integer' },
    importedCategories: { type: 'integer' },
    importedTags: { type: 'integer' },
  },
};

const accountDeletionSchema = {
  type: 'object',
  required: ['success', 'deletedWorkspaces', 'reassignedMemos'],
  properties: {
    success: { type: 'boolean' },
    deletedWorkspaces: { type: 'integer', description: 'Solo workspaces removed with the account.' },
    reassignedMemos: { type: 'integer', description: 'Notes you authored in other people\'s workspaces, reassigned to their owners.' },
  },
};

/** All component schemas published under `#/components/schemas`. */
export const componentSchemas: Record<string, object> = {
  Error: errorSchema,
  SimpleSuccess: simpleSuccessSchema,
  User: userSchema,
  Workspace: workspaceSchema,
  Member: memberSchema,
  Invite: inviteSchema,
  Memo: memoSchema,
  MemoVersion: memoVersionSchema,
  Folder: folderSchema,
  Category: categorySchema,
  Tag: tagSchema,
  Notification: notificationSchema,
  Session: sessionSchema,
  Attachment: attachmentSchema,
  StorageUsage: storageUsageSchema,
  Activity: activitySchema,
  LinkPreview: linkPreviewSchema,
  BackupStatus: backupStatusSchema,
  ExportedWorkspace: exportedWorkspaceSchema,
  ImportResult: importResultSchema,
  AccountDeletion: accountDeletionSchema,
};

// ---------------------------------------------------------------------------
// Tag registry (renders as the ordered tag list in Swagger UI)
// ---------------------------------------------------------------------------

export const apiTags: Array<{ name: string; description: string }> = [
  { name: 'System', description: 'Liveness and instance status.' },
  { name: 'Auth', description: 'Registration, sign-in, sessions, profile and account lifecycle. Sessions are cookie-based (`memo_session`).' },
  { name: 'Workspaces', description: 'Workspace CRUD, members, roles, invitations and storage usage.' },
  { name: 'Memos', description: 'Notes: create, list, search, update (optimistic concurrency), trash, versions, reordering and link previews.' },
  { name: 'Categories', description: 'Note categories (labels with color/icon).' },
  { name: 'Tags', description: 'Workspace tag registry; notes reference tags by name.' },
  { name: 'Folders', description: 'Hierarchical note folders (nesting, no cycles).' },
  { name: 'Attachments', description: 'Server-backed note attachments (images and documents).' },
  { name: 'Notifications', description: 'In-app reminder notifications for the signed-in user.' },
  { name: 'Push', description: 'Web Push (VAPID) subscription management.' },
  { name: 'Invites', description: 'Public invitation lookup and authenticated acceptance.' },
  { name: 'Migration', description: 'Legacy import and full workspace export.' },
];
