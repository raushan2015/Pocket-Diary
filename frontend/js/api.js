/**
 * Memo Manager SaaS - API Client Layer
 * Strictly implements API contract from system-design.md §4.2, §4.3, §4.4, §4.6
 */

// The frontend server proxies /api/* to Fastify. Use same-origin requests so
// sessions work from localhost, LAN hosts, reverse proxies, and production domains.
const API_BASE = window.__API_BASE__ !== undefined ? window.__API_BASE__ : '';

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
   * Register new user account
   * POST /api/v1/auth/register
   */
  async register({ email, password, name }) {
    return this.request('/api/v1/auth/register', {
      method: 'POST',
      body: { email, password, name },
    });
  }

  /**
   * Log in user
   * POST /api/v1/auth/login
   */
  async login({ email, password }) {
    return this.request('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password },
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
   * Get revision history versions for a memo
   * GET /api/v1/memos/:id/versions
   */
  async getMemoVersions(id) {
    return this.request(`/api/v1/memos/${encodeURIComponent(id)}/versions`, {
      method: 'GET',
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
   * Delete category
   * DELETE /api/v1/categories/:id
   */
  async deleteCategory(id) {
    return this.request(`/api/v1/categories/${encodeURIComponent(id)}`, {
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
