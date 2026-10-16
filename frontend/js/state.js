/**
 * Memo Manager SaaS - Centralized Application State Store
 */

class AppState {
  constructor() {
    this.listeners = new Map();

    // Default state
    this.data = {
      user: null,
      isAuthenticated: false,
      workspaces: [],
      activeWorkspace: null,
      currentView: 'landing', // 'landing' | 'auth' | 'dashboard' | 'editor'
      authMode: 'login',      // 'login' | 'register'
      theme: localStorage.getItem('memo_theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
      viewMode: localStorage.getItem('memo_view_mode') || 'grid', // 'grid' | 'list'
      activeFilter: { type: 'all', value: null }, // 'all' | 'favorites' | 'pinned' | 'dueSoon' | 'trash' | 'category' | 'tag'
      searchQuery: '',
      editorMode: 'write', // 'write' | 'preview' | 'split'
      memos: [],
      allWorkspaceMemos: [],
      categories: [],
      tags: [],
      folders: [],
      kpis: {
        total: 0,
        favorites: 0,
        pending: 0,
        completed: 0,
      },
      activeMemo: null,
      isLoadingMemos: false,
      apiStatus: 'online', // 'online' | 'offline' | 'checking'
      // Global dirty flag: true while the editor / keep modal / quick capture
      // holds edits that have not been persisted yet. Guarded by the global
      // beforeunload handler so a closing tab warns before losing work (DATA-03).
      hasUnsavedChanges: false,
    };
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    const oldValue = this.data[key];
    this.data[key] = value;
    this.emit(key, value, oldValue);
    this.emit('*', { key, value, oldValue });
  }

  update(patch) {
    for (const [key, value] of Object.entries(patch)) {
      this.set(key, value);
    }
  }

  on(key, callback) {
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key).add(callback);
    return () => this.listeners.get(key).delete(callback);
  }

  emit(key, ...args) {
    if (this.listeners.has(key)) {
      this.listeners.get(key).forEach((cb) => {
        try {
          cb(...args);
        } catch (err) {
          console.error(`Error in state listener for ${key}:`, err);
        }
      });
    }
  }

  setUser(user, workspaces = [], activeWorkspace = null) {
    this.set('user', user);
    this.set('isAuthenticated', !!user);
    if (workspaces && workspaces.length) {
      this.set('workspaces', workspaces);
    }
    if (activeWorkspace) {
      this.set('activeWorkspace', activeWorkspace);
    } else if (workspaces && workspaces.length > 0) {
      this.set('activeWorkspace', workspaces[0]);
    }
  }

  clearUser() {
    this.set('user', null);
    this.set('isAuthenticated', false);
    this.set('workspaces', []);
    this.set('activeWorkspace', null);
    this.set('memos', []);
    this.set('allWorkspaceMemos', []);
    this.set('categories', []);
    this.set('tags', []);
    this.set('folders', []);
    this.set('kpis', { total: 0, favorites: 0, pending: 0, completed: 0 });
  }

  updateKpisFromMemos(memos = this.data.allWorkspaceMemos || this.data.memos) {
    const list = memos || [];
    const active = list.filter(m => !m.deletedAt);
    const kpis = {
      total: active.length,
      favorites: active.filter(m => m.isFavorite).length,
      pending: active.filter(m => (m.status || '').toLowerCase() === 'pending' || (m.status || '').toLowerCase() === 'draft').length,
      completed: active.filter(m => (m.status || '').toLowerCase() === 'completed').length,
    };
    this.set('kpis', kpis);
    return kpis;
  }
}

export const state = new AppState();
