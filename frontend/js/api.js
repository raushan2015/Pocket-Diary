/**
 * Memo Manager SaaS - API Client Layer
 * Strictly implements API contract from system-design.md §4.2, §4.3, §4.4, §4.6
 */

// The frontend server proxies /api/* to Fastify. Use same-origin requests so
// sessions work from localhost, LAN hosts, reverse proxies, and production domains.
import { broadcastSync } from './keep-sync.js';

const API_BASE = window.__API_BASE__ !== undefined ? window.__API_BASE__ : '';

/**
 * ARCH-01 remediation: every successful memo mutation is broadcast to sibling
 * tabs so their lists, versions and card states stay in sync in real time.
 * (The read-only link-preview endpoint is intentionally excluded.)
 */
const MEMO_MUTATION_ENDPOINT = /^\/api\/v1\/memos(\/[^/?]+)?\/?$/;

function broadcastMemoMutation(endpoint, method) {
  if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') return;
  const path = String(endpoint).split('?')[0].replace(/\/+$/, '');
  if (!MEMO_MUTATION_ENDPOINT.test(path)) return;
  if (path === '/api/v1/memos/link-preview') return;
  broadcastSync('memos_changed');
}

class ApiClient {
  constructor(baseUrl = API_BASE) {
    this.baseUrl = baseUrl;
  }

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const defaultHeaders = {
      'Accept': 'application/json',
    };

    if (options.body !== undefined && !(options.body instanceof FormData)) {
      defaultHeaders['Content-Type'] = 'application/json';
    }

    const config = {
      ...options,
      credentials: 'include', // Ensures HTTP-only cookie 'memo_session' is transmitted
      cache: 'no-store', // API responses are session-scoped; never serve stale cache
      headers: {
        ...defaultHeaders,
        ...(options.headers || {}),
      },
    };

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      config.body = JSON.stringify(options.body);
    }

    try {
      const response = await fetch(url, config);
      const isJson = response.headers.get('content-type')?.includes('application/json');
      const data = isJson ? await response.json() : await response.text();

      if (!response.ok) {
        const error = new Error(
          (data && (data.message || data.error)) || `Request failed with status ${response.status}`
        );
        error.status = response.status;
        error.data = data;
        throw error;
      }

      // Keep open sibling tabs in sync after any memo change (ARCH-01).
      broadcastMemoMutation(endpoint, options.method);

      return data;
    } catch (err) {
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        // Network connection refused or server offline
        const networkError = new Error('Unable to connect to backend server. Please verify the API is running.');
        networkError.status = 0;
        networkError.isNetworkError = true;
        throw networkError;
      }
      throw err;
    }
  }

  // ==========================================
  // Auth & Session Endpoints (§4.2)
  // ==========================================

  /**
   * Register new user account. When registering through a workspace invitation
   * link, `inviteToken` auto-joins the invited workspace at account creation.
   * POST /api/v1/auth/register
   */
  async register({ email, password, name, inviteToken }) {
    return this.request('/api/v1/auth/register', {
      method: 'POST',
      body: inviteToken ? { email, password, name, inviteToken } : { email, password, name },
    });
  }

  /**
   * Log in user
   * POST /api/v1/auth/login
   */
  async login({ email, password, rememberMe }) {
    return this.request('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password, rememberMe },
    });
  }

  /**
   * Request password recovery
   * POST /api/v1/auth/forgot-password
   */
  async forgotPassword(email) {
    return this.request('/api/v1/auth/forgot-password', {
      method: 'POST',
      body: { email },
    });
  }

  /**
   * Complete password recovery with a one-time reset token
   * POST /api/v1/auth/reset-password
   */
  async resetPassword(token, newPassword) {
    return this.request('/api/v1/auth/reset-password', {
      method: 'POST',
      body: { token, newPassword },
    });
  }

  /**
   * Update current user profile
   * PATCH /api/v1/auth/profile
   */
  async updateProfile(data) {
    return this.request('/api/v1/auth/profile', {
      method: 'PATCH',
      body: data,
    });
  }

  /**
   * Log out active session
   * POST /api/v1/auth/logout
   */
  async logout() {
    return this.request('/api/v1/auth/logout', {
      method: 'POST',
    });
  }

  /**
   * Retrieve current authenticated user and workspaces
   * GET /api/v1/auth/me
   */
  async getMe() {
    return this.request('/api/v1/auth/me', {
      method: 'GET',
    });
  }

  /** List active sessions for the current user. */
  async listSessions() {
    return this.request('/api/v1/auth/sessions', { method: 'GET' });
  }

  /** Sign out every session except the current one. */
  async revokeOtherSessions() {
    return this.request('/api/v1/auth/sessions/revoke', { method: 'POST' });
  }

  // ==========================================
  // Server-side Reminder Notifications (§ Web Push)
  // ==========================================

  /** List the signed-in user's reminder notifications. */
  async listNotifications(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/api/v1/notifications${query ? `?${query}` : ''}`, { method: 'GET' });
  }

  /** Mark one notification read. */
  async markNotificationRead(id) {
    return this.request(`/api/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
  }

  /** Mark every notification read. */
  async markAllNotificationsRead() {
    return this.request('/api/v1/notifications/read-all', { method: 'POST' });
  }

  /** Get the VAPID public key (enabled:false when push is unconfigured). */
  async getPushPublicKey() {
    return this.request('/api/v1/push/public-key', { method: 'GET' });
  }

  /** Register this browser for push notifications. */
  async pushSubscribe(subscription) {
    return this.request('/api/v1/push/subscribe', {
      method: 'POST',
      body: subscription,
    });
  }

  /** Remove a push subscription (e.g. on pushsubscriptionchange). */
  async pushUnsubscribe(endpoint) {
    return this.request('/api/v1/push/unsubscribe', {
      method: 'POST',
      body: { endpoint },
    });
  }

  // ==========================================
  // Workspace Endpoints (§4.3)
  // ==========================================

  /**
   * List workspaces accessible to current user
   * GET /api/v1/workspaces
   */
  async listWorkspaces() {
    return this.request('/api/v1/workspaces', {
      method: 'GET',
    });
  }

  /**
   * Create new workspace
   * POST /api/v1/workspaces
   */
  async createWorkspace({ name, slug }) {
    return this.request('/api/v1/workspaces', {
      method: 'POST',
      body: { name, slug },
    });
  }

  /**
   * Update workspace name
   * PATCH /api/v1/workspaces/:id
   */
  async updateWorkspace(workspaceId, { name }) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
      method: 'PATCH',
      body: { name },
    });
  }

  /**
   * Get workspace storage quota
   * GET /api/v1/workspaces/:id/storage
   */
  async getStorageQuota(workspaceId) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/storage`, {
      method: 'GET',
    });
  }

  /**
   * List workspace members
   * GET /api/v1/workspaces/:id/members
   */
  async getWorkspaceMembers(workspaceId) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`, {
      method: 'GET',
    });
  }

  /**
   * Add / invite workspace member
   *
   * Removed (audit H-3): direct member insertion bypassed invitation consent
   * and allowed account enumeration. All additions now go through
   * createWorkspaceInvite(), which returns an identical response whether or
   * not the email has an account.
   */

  /** Remove a member from a workspace. */
  async removeWorkspaceMember(workspaceId, userId) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
  }

  /** Change a member's role. */
  async changeMemberRole(workspaceId, userId, role) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { role },
    });
  }

  /**
   * Workspace invitations
   */
  async createWorkspaceInvite(workspaceId, { email, role }) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invites`, {
      method: 'POST',
      body: { email, role },
    });
  }

  async listWorkspaceInvites(workspaceId) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invites`, { method: 'GET' });
  }

  async revokeWorkspaceInvite(workspaceId, inviteId) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`, {
      method: 'DELETE',
    });
  }

  /** Public lookup: invite context for the auth screen. */
  async lookupInvite(token) {
    return this.request(`/api/v1/invites/${encodeURIComponent(token)}`, { method: 'GET' });
  }

  /** Accept an invitation as the signed-in user. */
  async acceptInvite(token) {
    return this.request(`/api/v1/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' });
  }

  /** Self-hosted backup snapshot status. */
  async getBackupStatus() {
    return this.request('/api/v1/system/backup-status', { method: 'GET' });
  }

  /**
   * Get workspace activity audit trail
   * GET /api/v1/workspaces/:id/activities
   */
  async getWorkspaceActivities(workspaceId) {
    return this.request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/activities`, {
      method: 'GET',
    });
  }

  // ==========================================
  // Memo Management Endpoints (§4.4)
  // ==========================================

  /**
   * List memos for a workspace
   * GET /api/v1/memos?workspaceId=...
   */
  async listMemos(params = {}) {
    const query = new URLSearchParams(params).toString();
    return this.request(`/api/v1/memos${query ? `?${query}` : ''}`, {
      method: 'GET',
    });
  }

  /**
   * Create memo
   * POST /api/v1/memos
   */
  async createMemo(memoData) {
    return this.request('/api/v1/memos', {
      method: 'POST',
      body: memoData,
    });
  }

  /**
   * Get single memo
   * GET /api/v1/memos/:id
   */
  async getMemo(id) {
    return this.request(`/api/v1/memos/${encodeURIComponent(id)}`, {
      method: 'GET',
    });
  }

  /**
   * Update memo with optimistic concurrency
   * PATCH /api/v1/memos/:id
   */
  async updateMemo(id, updateData) {
    return this.request(`/api/v1/memos/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: updateData,
    });
  }

  /**
   * Delete memo (soft or permanent)
   * DELETE /api/v1/memos/:id
   */
  async deleteMemo(id, permanent = false) {
    return this.request(`/api/v1/memos/${encodeURIComponent(id)}${permanent ? '?permanent=true' : ''}`, {
      method: 'DELETE',
    });
  }

  /**
   * Restore soft-deleted memo
   * POST /api/v1/memos/:id/restore
   */
  async restoreMemo(id) {
    return this.request(`/api/v1/memos/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
    });
  }

  /**
   * Permanently delete every soft-deleted memo (Empty Trash)
   * DELETE /api/v1/memos/trash?workspaceId=...
   */
  async emptyTrash(workspaceId) {
    return this.request(`/api/v1/memos/trash?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Get revision history versions for a memo
   * GET /api/v1/memos/:id/versions
   */
  async getMemoVersions(id) {
    return this.request(`/api/v1/memos/${encodeURIComponent(id)}/versions`, {
      method: 'GET',
    });
  }

  /**
   * Batch update memo sort order (Google Keep drag & drop)
   * POST /api/v1/memos/reorder
   */
  async reorderMemos(workspaceId, memoIds) {
    return this.request('/api/v1/memos/reorder', {
      method: 'POST',
      body: { workspaceId, memoIds },
    });
  }

  /**
   * Fetch link preview metadata
   * POST /api/v1/memos/link-preview
   */
  async getLinkPreview(url) {
    return this.request('/api/v1/memos/link-preview', {
      method: 'POST',
      body: { url },
    });
  }

  // ==========================================
  // Server-backed memo attachments
  // ==========================================

  async listAttachments(memoId) {
    return this.request(`/api/v1/attachments/memo/${encodeURIComponent(memoId)}`, { method: 'GET' });
  }

  async uploadAttachment(memoId, file) {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.request(`/api/v1/attachments/memo/${encodeURIComponent(memoId)}`, { method: 'POST', body: form });
  }

  async deleteAttachment(id) {
    return this.request(`/api/v1/attachments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // Categories Endpoints (§4.5)
  // ==========================================

  /**
   * List categories for workspace
   * GET /api/v1/categories?workspaceId=...
   */
  async listCategories(workspaceId) {
    return this.request(`/api/v1/categories?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'GET',
    });
  }

  /**
   * Create category
   * POST /api/v1/categories
   */
  async createCategory(categoryData) {
    return this.request('/api/v1/categories', {
      method: 'POST',
      body: categoryData,
    });
  }

  /**
   * Update category
   * PATCH /api/v1/categories/:id
   */
  async updateCategory(id, categoryData) {
    return this.request(`/api/v1/categories/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: categoryData,
    });
  }

  /**
   * Delete category
   * DELETE /api/v1/categories/:id?workspaceId=...
   */
  async deleteCategory(id, workspaceId) {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
    return this.request(`/api/v1/categories/${encodeURIComponent(id)}${query}`, {
      method: 'DELETE',
    });
  }

  // ==========================================
  // Tags Endpoints (§4.5)
  // ==========================================

  /**
   * List tags for workspace
   * GET /api/v1/tags?workspaceId=...
   */
  async listTags(workspaceId) {
    return this.request(`/api/v1/tags?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'GET',
    });
  }

  /**
   * Create tag
   * POST /api/v1/tags
   */
  async createTag(tagData) {
    return this.request('/api/v1/tags', {
      method: 'POST',
      body: tagData,
    });
  }

  /** Rename a workspace tag. */
  async updateTag(id, tagData) {
    return this.request(`/api/v1/tags/${encodeURIComponent(id)}`, { method: 'PATCH', body: tagData });
  }

  /** Delete a workspace tag. */
  async deleteTag(id, workspaceId) {
    const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
    return this.request(`/api/v1/tags/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
  }

  // ==========================================
  // Folders Endpoints
  // ==========================================

  /**
   * List folders for workspace
   * GET /api/v1/folders?workspaceId=...
   */
  async listFolders(workspaceId) {
    return this.request(`/api/v1/folders?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'GET',
    });
  }

  /**
   * Create folder
   * POST /api/v1/folders
   */
  async createFolder(folderData) {
    return this.request('/api/v1/folders', {
      method: 'POST',
      body: folderData,
    });
  }

  /** Update a folder within its workspace. */
  async updateFolder(id, folderData) {
    return this.request(`/api/v1/folders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: folderData,
    });
  }

  /** Delete a folder within its workspace. */
  async deleteFolder(id, workspaceId) {
    return this.request(`/api/v1/folders/${encodeURIComponent(id)}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
    });
  }

  // ==========================================
  // Migration Endpoints (§4.6)
  // ==========================================

  /**
   * Import legacy browser localStorage memos
   * POST /api/v1/migration/import-local
   */
  async importLocal(payload) {
    return this.request('/api/v1/migration/import-local', {
      method: 'POST',
      body: payload,
    });
  }

  /**
   * Export workspace data
   * GET /api/v1/migration/export?workspaceId=...
   */
  async exportWorkspace(workspaceId) {
    return this.request(`/api/v1/migration/export?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'GET',
    });
  }
}

export const api = new ApiClient();
