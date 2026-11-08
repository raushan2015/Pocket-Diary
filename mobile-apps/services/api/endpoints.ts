/**
 * Typed endpoint functions — one per backend route the app uses, each parsing
 * the response through its Zod contract. Shapes verified against
 * backend/src (see ARCHITECTURE.md §1).
 */
import type { ApiClient } from './client';
import { ApiError } from './transport';
import type { ZodTypeAny, z } from 'zod';
import * as S from './contracts';
import type { ApiMemo, ApiMemoList } from './contracts';

const parseOrThrow = <T extends ZodTypeAny>(schema: T, data: unknown, what: string): z.output<T> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError({
      kind: 'parse',
      message: `Unexpected ${what} response from server`,
    });
  }
  return result.data;
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export async function getHealth(api: ApiClient): Promise<{ status: 'ok'; timestamp: number }> {
  const { data } = await api.requestJson<'unknown'>('GET', '/health', { timeoutMs: 10_000 });
  return parseOrThrow(S.healthSchema, data, 'health');
}

export async function getSystemInfo(api: ApiClient): Promise<S.ApiSystemInfo> {
  const { data } = await api.requestJson('GET', '/api/v1/system/info', { timeoutMs: 10_000 });
  return parseOrThrow(S.systemInfoSchema, data, 'system info');
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthSession {
  user: S.ApiUser;
  token: string;
  activeWorkspace?: S.ApiWorkspace | null;
  workspaces?: S.ApiWorkspace[];
}

export async function login(api: ApiClient, input: { email: string; password: string; timezone?: string }): Promise<AuthSession> {
  const { data, headers } = await api.requestJson('POST', '/api/v1/auth/login', {
    body: { email: input.email, password: input.password, rememberMe: true, timezone: input.timezone },
    timeoutMs: 20_000,
  });
  const parsed = parseOrThrow(S.loginResponseSchema, data, 'login');
  const token = extractCookie(headers['set-cookie']);
  if (!token) {
    throw new ApiError({
      kind: 'parse',
      message:
        'The server did not return a session cookie the app can read. ' +
        'If you are behind a reverse proxy, make sure it forwards the Set-Cookie header without rewriting it.',
    });
  }
  return { user: parsed.user, token, activeWorkspace: parsed.activeWorkspace ?? null };
}

export async function register(
  api: ApiClient,
  input: { email: string; password: string; name: string; timezone?: string },
): Promise<{ user: S.ApiUser; token: string; workspace: S.ApiWorkspace }> {
  const { data, headers } = await api.requestJson('POST', '/api/v1/auth/register', {
    body: input,
    timeoutMs: 20_000,
  });
  const parsed = parseOrThrow(S.registerResponseSchema, data, 'register');
  const token = extractCookie(headers['set-cookie']);
  if (!token) {
    throw new ApiError({ kind: 'parse', message: 'The server did not return a session cookie the app can read.' });
  }
  return { user: parsed.user, token, workspace: parsed.workspace };
}

function extractCookie(setCookie: string | undefined): string | null {
  if (!setCookie) return null;
  for (const raw of setCookie.split('\n')) {
    const [pair] = raw.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === S.SESSION_COOKIE_NAME) {
      return pair.slice(eq + 1).trim();
    }
  }
  return null;
}

export async function logout(api: ApiClient): Promise<void> {
  try {
    await api.requestJson('POST', '/api/v1/auth/logout', { timeoutMs: 10_000 });
  } catch (err) {
    // Logout is best-effort: clearing the local session proceeds even when
    // the server is unreachable (the server session expires on its own).
    if (!(err instanceof ApiError) || !err.isRetryable) {
      // Non-retryable errors other than network issues are still swallowed:
      // an expired session means there is nothing to revoke.
    }
  }
}

export async function getMe(api: ApiClient): Promise<{ user: S.ApiUser; workspaces: S.ApiWorkspace[] }> {
  const { data } = await api.requestJson('GET', '/api/v1/auth/me');
  return parseOrThrow(S.meResponseSchema, data, 'profile');
}

export async function getWorkspaces(api: ApiClient): Promise<S.ApiWorkspace[]> {
  const { data } = await api.requestJson('GET', '/api/v1/workspaces/');
  return parseOrThrow(S.workspacesResponseSchema, data, 'workspaces').workspaces;
}

export async function createWorkspace(api: ApiClient, name: string): Promise<S.ApiWorkspace> {
  const { data } = await api.requestJson('POST', '/api/v1/workspaces/', { body: { name } });
  const workspace = (data as { workspace?: unknown }).workspace;
  if (!workspace) throw new ApiError({ kind: 'parse', message: 'Unexpected workspace creation response' });
  return parseOrThrow(S.workspaceSchema, workspace, 'workspace');
}

export async function updateProfile(
  api: ApiClient,
  input: { name?: string; timezone?: string; currentPassword?: string; newPassword?: string },
): Promise<S.ApiUser> {
  const { data } = await api.requestJson('PATCH', '/api/v1/auth/profile', { body: input });
  const parsed = parseOrThrow(S.meResponseSchema, { user: (data as { user?: unknown }).user }, 'profile update');
  return parsed.user;
}

export async function getSessions(api: ApiClient): Promise<S.ApiSession[]> {
  const { data } = await api.requestJson('GET', '/api/v1/auth/sessions');
  return parseOrThrow(S.sessionsResponseSchema, data, 'sessions').sessions;
}

export async function revokeSession(api: ApiClient, id: string): Promise<void> {
  await api.requestJson('DELETE', `/api/v1/auth/sessions/${encodeURIComponent(id)}`);
}

export async function revokeOtherSessions(api: ApiClient): Promise<number> {
  const { data } = await api.requestJson('POST', '/api/v1/auth/sessions/revoke');
  return (data as { revoked?: number }).revoked ?? 0;
}

export async function deleteAccount(api: ApiClient, currentPassword: string): Promise<void> {
  await api.requestJson('DELETE', '/api/v1/auth/account', { body: { currentPassword }, timeoutMs: 20_000 });
}

export async function forgotPassword(api: ApiClient, email: string): Promise<{ emailConfigured: boolean }> {
  const { data } = await api.requestJson('POST', '/api/v1/auth/forgot-password', {
    body: { email },
    timeoutMs: 15_000,
  });
  return { emailConfigured: Boolean((data as { emailConfigured?: boolean }).emailConfigured) };
}

export async function resetPassword(api: ApiClient, token: string, newPassword: string): Promise<void> {
  await api.requestJson('POST', '/api/v1/auth/reset-password', { body: { token, newPassword }, timeoutMs: 15_000 });
}

// ---------------------------------------------------------------------------
// Memos
// ---------------------------------------------------------------------------

export interface ListMemosQuery {
  workspaceId: string;
  page?: number;
  limit?: number;
  sortBy?: 'updatedAt' | 'createdAt' | 'title' | 'sortOrder';
  sortOrder?: 'asc' | 'desc';
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  search?: string;
  isArchived?: boolean;
  isFavorite?: boolean;
}

export async function listMemos(api: ApiClient, query: ListMemosQuery): Promise<ApiMemoList> {
  const { data } = await api.requestJson('GET', '/api/v1/memos/', {
    query: {
      workspaceId: query.workspaceId,
      page: query.page,
      limit: query.limit,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      includeDeleted: query.includeDeleted === undefined ? undefined : String(query.includeDeleted),
      deletedOnly: query.deletedOnly === undefined ? undefined : String(query.deletedOnly),
      search: query.search,
      isArchived: query.isArchived === undefined ? undefined : String(query.isArchived),
      isFavorite: query.isFavorite === undefined ? undefined : String(query.isFavorite),
    },
  });
  return parseOrThrow(S.memoListSchema, data, 'memo list');
}

export async function getMemo(api: ApiClient, id: string): Promise<ApiMemo> {
  const { data } = await api.requestJson('GET', `/api/v1/memos/${encodeURIComponent(id)}`);
  return parseOrThrow(S.memoSchema, (data as { memo: unknown }).memo, 'memo');
}

/** Body for POST /memos. `clientId` is the offline idempotency key. */
export interface CreateMemoBody {
  workspaceId: string;
  title?: string;
  content?: string;
  color?: string;
  theme?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  status?: 'draft' | 'pending' | 'in_progress' | 'completed' | 'archived';
  noteType?: 'text' | 'checklist';
  isFavorite?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  folderId?: string | null;
  categoryId?: string | null;
  dueDate?: number | null;
  reminderTime?: number | null;
  reminderLocation?: string | null;
  checklistData?: S.ApiChecklistItem[];
  tags?: string[];
  collaborators?: unknown[];
  linkPreviews?: unknown[];
  sortOrder?: number;
  clientId?: string;
}

export async function createMemo(api: ApiClient, body: CreateMemoBody): Promise<ApiMemo> {
  const { data } = await api.requestJson('POST', '/api/v1/memos/', { body, timeoutMs: 45_000 });
  return parseOrThrow(S.memoSchema, (data as { memo: unknown }).memo, 'memo create');
}

export async function updateMemo(
  api: ApiClient,
  id: string,
  patch: Record<string, unknown> & { version?: number },
): Promise<ApiMemo> {
  const { data } = await api.requestJson('PATCH', `/api/v1/memos/${encodeURIComponent(id)}`, {
    body: patch,
    timeoutMs: 45_000,
  });
  return parseOrThrow(S.memoSchema, (data as { memo: unknown }).memo, 'memo update');
}

export async function deleteMemo(api: ApiClient, id: string, opts?: { permanent?: boolean }): Promise<void> {
  await api.requestJson('DELETE', `/api/v1/memos/${encodeURIComponent(id)}`, {
    query: { permanent: opts?.permanent === undefined ? undefined : String(opts.permanent) },
  });
}

export async function restoreMemo(api: ApiClient, id: string): Promise<ApiMemo> {
  const { data } = await api.requestJson('POST', `/api/v1/memos/${encodeURIComponent(id)}/restore`);
  return parseOrThrow(S.memoSchema, (data as { memo: unknown }).memo, 'memo restore');
}

// ---------------------------------------------------------------------------
// Organization
// ---------------------------------------------------------------------------

export async function getFolders(api: ApiClient, workspaceId: string): Promise<S.ApiFolder[]> {
  const { data } = await api.requestJson('GET', '/api/v1/folders/', { query: { workspaceId } });
  return parseOrThrow(S.foldersResponseSchema, data, 'folders').folders;
}

export async function createFolder(api: ApiClient, workspaceId: string, name: string): Promise<S.ApiFolder> {
  const { data } = await api.requestJson('POST', '/api/v1/folders/', { body: { workspaceId, name } });
  return parseOrThrow(S.folderSchema, (data as { folder?: unknown }).folder, 'folder');
}

export async function getCategories(api: ApiClient, workspaceId: string): Promise<S.ApiCategory[]> {
  const { data } = await api.requestJson('GET', '/api/v1/categories/', { query: { workspaceId } });
  return parseOrThrow(S.categoriesResponseSchema, data, 'categories').categories;
}

export async function getTags(api: ApiClient, workspaceId: string): Promise<S.ApiTag[]> {
  const { data } = await api.requestJson('GET', '/api/v1/tags/', { query: { workspaceId } });
  return parseOrThrow(S.tagsResponseSchema, data, 'tags').tags;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function getNotifications(api: ApiClient, limit = 50): Promise<{ notifications: S.ApiNotification[]; unread: number }> {
  const { data } = await api.requestJson('GET', '/api/v1/notifications/', { query: { limit } });
  return parseOrThrow(S.notificationsResponseSchema, data, 'notifications');
}

export async function markNotificationRead(api: ApiClient, id: string): Promise<void> {
  await api.requestJson('POST', `/api/v1/notifications/${encodeURIComponent(id)}/read`);
}

export async function markAllNotificationsRead(api: ApiClient): Promise<number> {
  const { data } = await api.requestJson('POST', '/api/v1/notifications/read-all');
  return (data as { updated?: number }).updated ?? 0;
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

export async function getMemoAttachments(api: ApiClient, memoId: string): Promise<S.ApiAttachment[]> {
  const { data } = await api.requestJson('GET', `/api/v1/attachments/memo/${encodeURIComponent(memoId)}`);
  const parsed = parseOrThrow(S.attachmentsListSchema, data, 'attachments');
  return parsed.attachments;
}

/** Multipart upload. `form` carries a `file` part: RN `{uri,name,type}` or a Blob in tests. */
export async function uploadAttachment(api: ApiClient, memoId: string, form: FormData): Promise<S.ApiAttachment> {
  const res = await api.requestMultipart(`/api/v1/attachments/memo/${encodeURIComponent(memoId)}`, form);
  const text = await res.text();
  if (!res.ok) {
    let serverMessage: string | undefined;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      serverMessage = parsed.message ?? parsed.error;
    } catch {
      // non-JSON error body
    }
    throw new ApiError({
      kind: 'http',
      status: res.status,
      message: `Attachment upload failed with ${res.status}`,
      serverMessage,
    });
  }
  let parsed: unknown;
  try {
    parsed = text.length ? JSON.parse(text) : {};
  } catch {
    throw new ApiError({ kind: 'not-json', status: res.status, message: 'Invalid JSON from attachment upload' });
  }
  return parseOrThrow(S.attachmentSchema, (parsed as { attachment?: unknown }).attachment, 'attachment');
}

export async function deleteAttachment(api: ApiClient, id: string): Promise<void> {
  await api.requestJson('DELETE', `/api/v1/attachments/${encodeURIComponent(id)}`);
}

export function attachmentPath(id: string): string {
  return `/api/v1/attachments/${encodeURIComponent(id)}/file`;
}

// ---------------------------------------------------------------------------
// Pocket Diary AI assistant (all server-enforced; no keys stored on device)
// ---------------------------------------------------------------------------

const {
  aiProvidersResponseSchema,
  aiModelListSchema,
  aiProviderConfigResponseSchema,
  aiConversationCreateResponseSchema,
  aiRequestResponseSchema,
  aiGrantResponseSchema,
  aiProposalResponseSchema,
  aiConversationsResponseSchema,
  aiConversationDetailSchema,
  aiSendMessageResponseSchema,
  aiSearchResponseSchema,
  aiPrivacySchema,
} = S;

export async function listAiProviders(api: ApiClient) {
  const { data } = await api.requestJson('GET', '/api/v1/ai/providers');
  return parseOrThrow(aiProvidersResponseSchema, data, 'AI providers');
}

/** Fetch available model IDs with a transient key; no API key is stored on device. */
export async function previewAiModels(api: ApiClient, provider: string, apiKey: string) {
  const { data } = await api.requestJson('POST', '/api/v1/ai/providers/models-preview', {
    body: { provider, apiKey },
    timeoutMs: 25_000,
  });
  return parseOrThrow(aiModelListSchema, data, 'AI model catalog');
}

export async function createAiProvider(
  api: ApiClient,
  input: { provider: string; label: string; modelId: string; apiKey: string },
) {
  const { data } = await api.requestJson('POST', '/api/v1/ai/providers', { body: input, timeoutMs: 20_000 });
  return parseOrThrow(aiProviderConfigResponseSchema, data, 'AI provider create').config;
}

export async function testAiProvider(api: ApiClient, id: string): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
  const { data } = await api.requestJson('POST', `/api/v1/ai/providers/${encodeURIComponent(id)}/test`, { timeoutMs: 25_000 });
  return data as { ok: boolean; message: string; latencyMs?: number };
}

export async function deleteAiProvider(api: ApiClient, id: string): Promise<void> {
  await api.requestJson('DELETE', `/api/v1/ai/providers/${encodeURIComponent(id)}`);
}

export async function listAiConversations(api: ApiClient, workspaceId: string, limit = 20) {
  const { data } = await api.requestJson('GET', '/api/v1/ai/conversations', {
    query: { workspaceId, limit },
  });
  return parseOrThrow(aiConversationsResponseSchema, data, 'AI conversations');
}

export async function createAiConversation(api: ApiClient, workspaceId: string) {
  const { data } = await api.requestJson('POST', '/api/v1/ai/conversations', {
    body: { workspaceId },
    timeoutMs: 15_000,
  });
  const parsed = parseOrThrow(aiConversationCreateResponseSchema, data, 'AI conversation create');
  return parsed.conversation;
}

export async function getAiConversation(api: ApiClient, conversationId: string, messageLimit = 100) {
  const { data } = await api.requestJson('GET', `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}`, {
    query: { messageLimit },
  });
  return parseOrThrow(aiConversationDetailSchema, data, 'AI conversation detail');
}

export async function deleteAiConversation(api: ApiClient, conversationId: string): Promise<void> {
  await api.requestJson('DELETE', `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}`);
}

export async function sendAiMessage(
  api: ApiClient,
  conversationId: string,
  input: {
    content: string;
    clientMessageId: string;
    mode?: 'general' | 'note_task' | 'search' | 'search_read';
    currentNoteGrantId?: string | null;
    providerConfigId?: string | null;
  },
) {
  const { data } = await api.requestJson('POST', `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/messages`, {
    body: input,
    timeoutMs: 20_000,
  });
  return parseOrThrow(aiSendMessageResponseSchema, data, 'AI send message');
}

export async function getAiRequest(api: ApiClient, requestId: string) {
  const { data } = await api.requestJson('GET', `/api/v1/ai/requests/${encodeURIComponent(requestId)}`, {
    timeoutMs: 10_000,
  });
  return parseOrThrow(aiRequestResponseSchema, data, 'AI request status').request;
}

export async function cancelAiRequest(api: ApiClient, requestId: string): Promise<void> {
  await api.requestJson('POST', `/api/v1/ai/requests/${encodeURIComponent(requestId)}/cancel`, { timeoutMs: 10_000 });
}

export async function grantCurrentNoteToConversation(
  api: ApiClient,
  input: { workspaceId: string; memoId: string; conversationId: string; purpose?: string },
) {
  const { data } = await api.requestJson('POST', '/api/v1/ai/current-note/grant', { body: input, timeoutMs: 15_000 });
  return parseOrThrow(aiGrantResponseSchema, data, 'AI current-note grant').grant;
}

export async function getAiProposal(api: ApiClient, proposalId: string) {
  const { data } = await api.requestJson('GET', `/api/v1/ai/proposals/${encodeURIComponent(proposalId)}`);
  return parseOrThrow(aiProposalResponseSchema, data, 'AI proposal').proposal;
}

export async function approveAiProposal(api: ApiClient, proposalId: string): Promise<{ memoId: string | null }> {
  const { data } = await api.requestJson('POST', `/api/v1/ai/proposals/${encodeURIComponent(proposalId)}/approve`, { timeoutMs: 20_000 });
  const memo = (data as { memo?: { id?: string } }).memo;
  return { memoId: memo?.id ?? null };
}

export async function rejectAiProposal(api: ApiClient, proposalId: string): Promise<void> {
  await api.requestJson('POST', `/api/v1/ai/proposals/${encodeURIComponent(proposalId)}/reject`);
}

export async function aiSearchLocal(
  api: ApiClient,
  input: { workspaceId: string; query: string; limit?: number },
) {
  const { data } = await api.requestJson('POST', '/api/v1/ai/search', {
    body: { workspaceId: input.workspaceId, query: input.query, limit: input.limit ?? 25 },
    timeoutMs: 20_000,
  });
  return parseOrThrow(aiSearchResponseSchema, data, 'AI local search');
}

export async function getAiNotePrivacy(api: ApiClient, memoId: string, workspaceId: string) {
  const { data } = await api.requestJson('GET', `/api/v1/ai/memos/${encodeURIComponent(memoId)}/protected-sections`, {
    query: { workspaceId },
  });
  return parseOrThrow(aiPrivacySchema, data, 'AI note privacy');
}

export async function setAiNotePrivacy(
  api: ApiClient,
  memoId: string,
  workspaceId: string,
  aiAccess: 'blocked' | 'current_only' | 'search_allowed',
) {
  const { data } = await api.requestJson('PATCH', `/api/v1/ai/memos/${encodeURIComponent(memoId)}/privacy`, {
    body: { workspaceId, aiAccess },
  });
  return data as { memoId: string; aiAccess: string };
}
