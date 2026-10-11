/**
 * Application Events & UI Interactions Wiring
 * Connects top navigation, modals, sidebar controls, editor toolbars, and team management.
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml } from './markdown.js';
import { showToast, openModal, closeModal, toggleTheme } from './utils.js';
import { navigateTo } from './navigation.js';
import {
  setAuthMode,
  handleAuthSubmit,
  handleLogout,
  closeUserDropdown,
  toggleUserDropdown
} from './auth.js';
import { refreshWorkspaceMemos, updateDashboardDateBadge } from './workspace-data.js';
import { setFilter, filterAndRenderMemos } from './search-filter.js';
import {
  renderSidebarCategories,
  renderSidebarTags,
  renderSidebarFolders,
  renderWorkspacesList,
  updateSidebarBadges
} from './sidebar.js';
import {
  currentCalYear,
  currentCalMonth,
  setCalMonth,
  setCalYear,
  renderInteractiveCalendar
} from './calendar.js';
import {
  setupKeepQuickCapture,
  quickCaptureDraft,
  renderQuickCaptureAttachments
} from './keep-quick-capture.js';
import { setupKeepDrawingModal } from './keep-drawing.js';
import { setupKeepPopovers } from './keep-popovers.js';
import { setupKeepLightbox } from './keep-lightbox.js';
import { setupKeepSelection } from './keep-selection.js';
import { setupKeepLabelsModal, openKeepLabelsModal } from './keep-labels-modal.js';
import { setupKeepReminders } from './keep-reminders.js';
import { setupKeepKeyboardShortcuts } from './keep-shortcuts.js';
import { setupMultiTabSync } from './keep-sync.js';
import {
  setupKeepModalListeners,
  activeKeepModalMemo,
  renderKeepModalAttachments
} from './keep-modal.js';
import {
  setEditorRefreshCallback,
  flushEditorAutosave,
  editorHasUnsavedChanges,
  saveActiveMemo,
  setupFormattingToolbar,
  setEditorTab,
  renderEditorTags,
  syncMobileTagChips,
  populateFolderSelect
} from './editor.js';

export function setupEventListeners() {
  // Theme Toggle Buttons
  document.getElementById('theme-toggle-btn')?.addEventListener('click', toggleTheme);
  document.getElementById('dropdown-theme-btn')?.addEventListener('click', () => {
    toggleTheme();
    closeUserDropdown();
  });

  // Top Nav Brand & Auth
  document.getElementById('nav-brand-btn')?.addEventListener('click', () => {
    if (state.get('isAuthenticated')) {
      navigateTo('dashboard');
    } else {
      navigateTo('landing');
    }
  });

  document.getElementById('nav-login-btn')?.addEventListener('click', () => navigateTo('auth', { mode: 'login' }));
  document.getElementById('nav-register-btn')?.addEventListener('click', () => navigateTo('auth', { mode: 'register' }));
  document.getElementById('hero-get-started-btn')?.addEventListener('click', () => navigateTo('auth', { mode: 'register' }));
  document.getElementById('hero-live-demo-btn')?.addEventListener('click', () => {
    const demoUser = { id: 'demo-user-1', name: 'Alex Explorer', email: 'alex.demo@notesapp.internal' };
    const demoWorkspace = { id: 'demo-ws-1', name: 'Product Engineering Squad', slug: 'product-engineering', role: 'owner' };
    const now = Date.now();
    const demoMemos = [
      {
        id: 'demo-memo-1',
        title: 'Welcome to Notes ✨',
        content: '# Getting Started with Notes\n\nWelcome to your modern Google Keep workspace!\n\n- [x] Full-text search with SQLite FTS5\n- [x] 12 Keep Pastel Background Colors & Themes\n- [x] In-place elevated note editing modal\n- [x] Quick capture bar with 1-click list, draw, image, voice\n\nAll your notes save automatically as you type.',
        noteType: 'checklist',
        checklistData: [
          { id: 'c1', text: 'Full-text search with SQLite FTS5', checked: true },
          { id: 'c2', text: '12 Keep Pastel Background Colors & Themes', checked: true },
          { id: 'c3', text: 'In-place elevated note editing modal', checked: true },
          { id: 'c4', text: 'Quick capture bar with 1-click list, draw, image, voice', checked: false }
        ],
        color: 'yellow',
        theme: 'none',
        status: 'in_progress',
        priority: 'high',
        isPinned: true,
        isFavorite: true,
        dueDate: now + 2 * 86400000,
        createdAt: now - 3600000,
        updatedAt: now,
        workspaceId: 'demo-ws-1',
        tags: ['getting-started', 'welcome'],
        category: { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      },
      {
        id: 'demo-memo-2',
        title: 'Grocery Run 🛒',
        content: 'Almond milk, organic sourdough, fresh berries, Greek yogurt.',
        noteType: 'checklist',
        checklistData: [
          { id: 'g1', text: 'Almond milk', checked: true },
          { id: 'g2', text: 'Organic sourdough bread', checked: true },
          { id: 'g3', text: 'Fresh berries (strawberries & blueberries)', checked: false },
          { id: 'g4', text: 'Greek yogurt (plain 0%)', checked: false }
        ],
        color: 'teal',
        theme: 'grocery',
        status: 'pending',
        priority: 'medium',
        isPinned: false,
        isFavorite: true,
        dueDate: now + 4 * 86400000,
        createdAt: now - 7200000,
        updatedAt: now - 1800000,
        workspaceId: 'demo-ws-1',
        tags: ['shopping', 'home'],
        category: { id: 'cat-3', name: 'Personal', color: '#10b981' },
      },
      {
        id: 'demo-memo-3',
        title: 'Sprint Retrospective Notes 📋',
        content: 'Team retro points:\n1. Delivered Google Keep alternative note UX\n2. Streamlined categories and labels editing\n3. Responsive layouts on mobile and desktop',
        noteType: 'text',
        color: 'blue',
        theme: 'none',
        status: 'completed',
        priority: 'medium',
        isPinned: false,
        isFavorite: false,
        dueDate: now - 86400000,
        createdAt: now - 86400000,
        updatedAt: now - 3600000,
        workspaceId: 'demo-ws-1',
        tags: ['meeting', 'sprint'],
        category: { id: 'cat-2', name: 'Engineering', color: '#8b5cf6' },
      },
    ];

    state.setUser(demoUser, [demoWorkspace], demoWorkspace);
    state.set('allWorkspaceMemos', demoMemos);
    state.set('categories', [
      { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      { id: 'cat-2', name: 'Engineering', color: '#8b5cf6' },
      { id: 'cat-3', name: 'Personal', color: '#10b981' },
    ]);
    state.set('tags', [{ id: 't-1', name: 'getting-started' }, { id: 't-2', name: 'shopping' }, { id: 't-3', name: 'meeting' }]);
    state.set('folders', [{ id: 'f-1', name: 'Sprint Memos' }]);
    state.updateKpisFromMemos(demoMemos);

    renderSidebarCategories(state.get('categories'));
    renderSidebarTags(state.get('tags'));
    renderSidebarFolders(state.get('folders'));
    updateSidebarBadges();
    updateDashboardDateBadge();
    filterAndRenderMemos();

    navigateTo('dashboard');
    showToast('Loaded interactive demo workspace with sample Keep notes!', 'success', 3000);
  });
  document.getElementById('bottom-cta-btn')?.addEventListener('click', () => navigateTo('auth', { mode: 'register' }));

  document.getElementById('auth-switch-btn')?.addEventListener('click', () => {
    const currentMode = state.get('authMode') || 'login';
    setAuthMode(currentMode === 'login' ? 'register' : 'login');
  });

  document.getElementById('password-toggle-btn')?.addEventListener('click', () => {
    const pwdInput = document.getElementById('auth-password-input');
    if (!pwdInput) return;
    pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password';
  });

  document.getElementById('auth-form')?.addEventListener('submit', handleAuthSubmit);

  ['social-google-btn', 'social-apple-btn', 'social-github-btn'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', () => {
      showToast('OAuth providers require client credentials. Please use email/password or Live Demo.', 'info', 3500);
    });
  });

  document.getElementById('auth-forgot-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    setAuthMode('forgot');
  });

  document.getElementById('nav-notifications-btn')?.addEventListener('click', () => {
    const upcoming = (state.get('allWorkspaceMemos') || []).filter((memo) => !memo.deletedAt && memo.dueDate && (memo.status || '').toLowerCase() !== 'completed' && Number(memo.dueDate) <= Date.now() + 7 * 86400000);
    setFilter('dueSoon');
    if (!upcoming.length) showToast('No overdue or upcoming memos. Add a due date to a note to create a reminder.', 'info', 3500);
    else showToast(`${upcoming.length} overdue or upcoming note${upcoming.length === 1 ? '' : 's'} shown.`, 'info', 2500);
  });

  // User Profile Pill & Dropdown
  const userPill = document.getElementById('user-menu-pill');
  userPill?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleUserDropdown();
  });

  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('user-dropdown-menu');
    if (dropdown && !dropdown.contains(e.target) && !userPill?.contains(e.target)) {
      closeUserDropdown();
    }
  });

  document.getElementById('dropdown-logout-btn')?.addEventListener('click', handleLogout);
  document.getElementById('dropdown-dashboard-btn')?.addEventListener('click', () => {
    closeUserDropdown();
    navigateTo('dashboard');
  });

  document.getElementById('dropdown-profile-btn')?.addEventListener('click', () => {
    closeUserDropdown();
    const user = state.get('currentUser');
    const nameInput = document.getElementById('profile-name-input');
    const emailInput = document.getElementById('profile-email-input');
    if (nameInput && user) nameInput.value = user.name || '';
    if (emailInput && user) emailInput.value = user.email || '';
    openModal('modal-profile');
  });

  document.getElementById('dropdown-members-btn')?.addEventListener('click', async () => {
    closeUserDropdown();
    openModal('modal-members');
    await loadWorkspaceMembers();
  });

  // Sidebar Filter Links
  document.getElementById('side-nav-dashboard')?.addEventListener('click', () => setFilter('dashboard'));
  document.getElementById('side-nav-all')?.addEventListener('click', () => setFilter('all'));
  document.getElementById('side-nav-reminders')?.addEventListener('click', () => setFilter('reminders'));
  document.getElementById('side-nav-archive')?.addEventListener('click', () => setFilter('archive'));
  document.getElementById('side-nav-favorites')?.addEventListener('click', () => setFilter('favorites'));
  document.getElementById('side-nav-pinned')?.addEventListener('click', () => setFilter('pinned'));
  document.getElementById('side-nav-due-soon')?.addEventListener('click', () => setFilter('dueSoon'));
  document.getElementById('side-nav-calendar')?.addEventListener('click', () => {
    navigateTo('dashboard');
    document.querySelector('.calendar-widget-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const handleCalendarSelect = (range) => {
    setFilter('dueDate', range);
    document.getElementById('memos-view-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  document.getElementById('calendar-prev-btn')?.addEventListener('click', () => {
    let m = currentCalMonth - 1;
    let y = currentCalYear;
    if (m < 0) { m = 11; y--; }
    setCalMonth(m);
    setCalYear(y);
    renderInteractiveCalendar(currentCalYear, currentCalMonth, handleCalendarSelect);
  });
  document.getElementById('calendar-next-btn')?.addEventListener('click', () => {
    let m = currentCalMonth + 1;
    let y = currentCalYear;
    if (m > 11) { m = 0; y++; }
    setCalMonth(m);
    setCalYear(y);
    renderInteractiveCalendar(currentCalYear, currentCalMonth, handleCalendarSelect);
  });

  document.querySelector('.card-link[href="#reminders"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    setFilter('reminders');
    document.getElementById('memos-view-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.getElementById('side-nav-trash')?.addEventListener('click', () => setFilter('trash'));
  document.getElementById('recent-memos-view-all')?.addEventListener('click', () => setFilter('all'));

  document.getElementById('clear-filter-btn')?.addEventListener('click', () => setFilter('all'));

  document.getElementById('dashboard-refresh-btn')?.addEventListener('click', () => {
    showToast('Refreshing workspace notes...', 'info', 1000);
    refreshWorkspaceMemos();
  });

  document.getElementById('filter-status-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('filter-priority-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('filter-type-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('filter-color-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('sort-memos-select')?.addEventListener('change', () => filterAndRenderMemos());

  // View Mode Switcher (Grid vs List)
  const gridBtn = document.getElementById('view-mode-grid-btn');
  const listBtn = document.getElementById('view-mode-list-btn');
  state.set('viewMode', 'grid');
  localStorage.setItem('memo_view_mode', 'grid');

  gridBtn?.addEventListener('click', () => {
    state.set('viewMode', 'grid');
    localStorage.setItem('memo_view_mode', 'grid');
    gridBtn.classList.add('active');
    listBtn?.classList.remove('active');
    filterAndRenderMemos();
  });

  listBtn?.addEventListener('click', () => {
    state.set('viewMode', 'list');
    localStorage.setItem('memo_view_mode', 'list');
    listBtn.classList.add('active');
    gridBtn?.classList.remove('active');
    filterAndRenderMemos();
  });

  // Google Keep Modules Initialization & Wiring
  setupKeepQuickCapture({
    onNoteCreated: refreshWorkspaceMemos
  });

  setupKeepDrawingModal({
    onInsert: async (file, target) => {
      if (target === 'modal' && activeKeepModalMemo) {
        if (activeKeepModalMemo.id) {
          try {
            await api.uploadAttachment(activeKeepModalMemo.id, file);
            const res = await api.getMemo(activeKeepModalMemo.id);
            activeKeepModalMemo.attachments = res.memo?.attachments || [];
            renderKeepModalAttachments(activeKeepModalMemo);
            refreshWorkspaceMemos();
          } catch (err) {
            showToast('Failed to upload drawing', 'error');
          }
        }
      } else {
        const previewUrl = URL.createObjectURL(file);
        quickCaptureDraft.pendingFiles = quickCaptureDraft.pendingFiles || [];
        quickCaptureDraft.pendingFiles.push({ file, previewUrl });
        renderQuickCaptureAttachments();
        const form = document.getElementById('quick-capture-form');
        const collapsed = document.getElementById('quick-capture-collapsed');
        if (form && collapsed) {
          collapsed.style.display = 'none';
          form.style.display = 'block';
        }
      }
    }
  });

  setupKeepPopovers();
  setupKeepLightbox({
    onDeleted: () => refreshWorkspaceMemos()
  });
  setupKeepSelection({
    onDone: () => refreshWorkspaceMemos()
  });
  setupKeepLabelsModal({
    onChanged: async () => {
      await refreshWorkspaceMemos();
      const activeWs = state.get('activeWorkspace');
      if (activeWs?.id) {
        try {
          const res = await api.listTags(activeWs.id);
          state.set('tags', res.tags || []);
          renderSidebarTags(res.tags || []);
        } catch {}
      }
    }
  });
  setupKeepReminders();
  setupKeepKeyboardShortcuts({
    onRefresh: refreshWorkspaceMemos
  });
  setupMultiTabSync({
    onMemosChanged: () => {
      refreshWorkspaceMemos(false);
    },
    onLabelsChanged: () => {
      refreshWorkspaceMemos(false);
    }
  });

  document.getElementById('sidebar-edit-labels-btn')?.addEventListener('click', () => {
    openKeepLabelsModal();
  });

  setupKeepModalListeners({
    onRefresh: refreshWorkspaceMemos,
    onExpand: (memo) => navigateTo('editor', { memo })
  });

  setEditorRefreshCallback(refreshWorkspaceMemos);

  // Create New Memo Buttons
  const createNewMemoHandler = () => {
    const activeWs = state.get('activeWorkspace');
    const categories = state.get('categories') || [];
    const defaultCat = categories.length > 0 ? categories[0].id : null;
    const requestedFolderId = state.get('activeFilter')?.type === 'folder' ? state.get('activeFilter').value : null;
    const defaultFolderId = requestedFolderId || null;

    const newMemo = {
      title: '',
      content: '',
      categoryId: defaultCat,
      folderId: defaultFolderId,
      priority: 'medium',
      status: 'pending',
      dueDate: null,
      tags: [],
      isFavorite: false,
      isPinned: false,
    };
    navigateTo('editor', { memo: newMemo });
  };

  document.getElementById('dashboard-new-memo-btn')?.addEventListener('click', createNewMemoHandler);
  document.getElementById('empty-state-action-btn')?.addEventListener('click', createNewMemoHandler);
  document.getElementById('mob-nav-create')?.addEventListener('click', createNewMemoHandler);

  // Editor Actions
  document.getElementById('editor-back-btn')?.addEventListener('click', async () => {
    await flushEditorAutosave();
    if (!editorHasUnsavedChanges) await navigateTo('dashboard');
  });

  window.addEventListener('popstate', async () => {
    if (state.get('currentView') === 'editor') {
      await flushEditorAutosave();
      if (!editorHasUnsavedChanges) {
        try { window.history.replaceState({ memoManagerDashboard: true }, '', window.location.pathname); } catch {}
        await navigateTo('dashboard');
      } else {
        try { window.history.pushState({ memoManagerEditor: true }, '', '#editor'); } catch {}
        showToast('Note not saved yet. Check your connection and try again.', 'error', 5000);
      }
    }
  });

  document.getElementById('editor-save-btn')?.addEventListener('click', () => saveActiveMemo({ quiet: false }));

  document.getElementById('editor-share-btn')?.addEventListener('click', () => {
    const memo = state.get('activeMemo');
    if (!memo) return;
    openModal('modal-share');
    const titleEl = document.getElementById('share-modal-memo-title');
    const linkInput = document.getElementById('share-link-input');
    if (titleEl) titleEl.textContent = memo.title || 'Untitled Note';
    if (linkInput) linkInput.value = `${window.location.origin}/#memo=${memo.id || 'draft'}`;
  });

  document.getElementById('share-copy-link-btn')?.addEventListener('click', () => {
    const linkInput = document.getElementById('share-link-input');
    if (linkInput) {
      navigator.clipboard?.writeText(linkInput.value);
      showToast('Note link copied to clipboard!', 'success');
    }
  });

  document.getElementById('share-copy-markdown-btn')?.addEventListener('click', () => {
    const memo = state.get('activeMemo');
    const content = `# ${memo?.title || 'Untitled Note'}\n\n${memo?.content || ''}`;
    navigator.clipboard?.writeText(content);
    showToast('Markdown content copied to clipboard!', 'success');
  });

  document.getElementById('share-download-md-btn')?.addEventListener('click', () => {
    const memo = state.get('activeMemo');
    const content = `# ${memo?.title || 'Untitled Note'}\n\n${memo?.content || ''}`;
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(memo?.title || 'note').toLowerCase().replace(/[^a-z0-9_-]/g, '_')}.md`;
    link.click();
    URL.revokeObjectURL(url);
    showToast('Markdown file downloaded!', 'success');
  });

  document.getElementById('modal-share-close-btn')?.addEventListener('click', () => closeModal('modal-share'));
  document.getElementById('modal-share-cancel-btn')?.addEventListener('click', () => closeModal('modal-share'));

  // Upgrade Plan Modal Handlers
  document.getElementById('storage-upgrade-btn')?.addEventListener('click', () => openModal('modal-upgrade-plan'));
  document.getElementById('modal-plan-close-btn')?.addEventListener('click', () => closeModal('modal-upgrade-plan'));
  document.getElementById('modal-plan-close-footer-btn')?.addEventListener('click', () => closeModal('modal-upgrade-plan'));
  document.getElementById('choose-pro-plan-btn')?.addEventListener('click', () => {
    showToast('Upgraded to Pro plan! Your workspace storage is now 100 GB.', 'success');
    closeModal('modal-upgrade-plan');
  });
  document.getElementById('choose-team-plan-btn')?.addEventListener('click', () => {
    showToast('Upgraded to Team plan! Collaboration and 1 TB storage enabled.', 'success');
    closeModal('modal-upgrade-plan');
  });

  // Version History Modal Close Handlers
  document.getElementById('modal-history-close-btn')?.addEventListener('click', () => closeModal('modal-history'));
  document.getElementById('modal-history-cancel-btn')?.addEventListener('click', () => closeModal('modal-history'));

  // Account Profile Settings Modal Handlers
  document.getElementById('modal-profile-close-btn')?.addEventListener('click', () => closeModal('modal-profile'));
  document.getElementById('modal-profile-cancel-btn')?.addEventListener('click', () => closeModal('modal-profile'));
  document.getElementById('profile-settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('profile-name-input')?.value.trim();
    const currentPassword = document.getElementById('profile-current-pwd-input')?.value;
    const newPassword = document.getElementById('profile-new-pwd-input')?.value;
    try {
      const payload = { name };
      if (newPassword) {
        payload.currentPassword = currentPassword;
        payload.newPassword = newPassword;
      }
      const res = await api.updateProfile(payload);
      const user = res.user;
      state.set('currentUser', user);
      const namePill = document.getElementById('user-menu-name');
      const fullnameEl = document.getElementById('dropdown-user-fullname');
      if (namePill) namePill.textContent = (user.name || '').split(' ')[0];
      if (fullnameEl) fullnameEl.textContent = user.name || '';
      closeModal('modal-profile');
      showToast('Profile updated successfully', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to update profile', 'error');
    }
  });

  document.getElementById('modal-members-close-btn')?.addEventListener('click', () => closeModal('modal-members'));
  document.getElementById('modal-members-cancel-btn')?.addEventListener('click', () => closeModal('modal-members'));
  document.getElementById('invite-member-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const activeWs = state.get('activeWorkspace');
    const email = document.getElementById('invite-email-input')?.value.trim();
    const role = document.getElementById('invite-role-select')?.value;
    if (!email || !activeWs?.id) return;
    try {
      await api.addWorkspaceMember(activeWs.id, { email, role });
      showToast(`Invited ${email} as ${role}!`, 'success');
      document.getElementById('invite-email-input').value = '';
      await loadWorkspaceMembers();
    } catch (err) {
      showToast(err.message || 'Failed to add member', 'error');
    }
  });

  document.getElementById('editor-fav-btn')?.addEventListener('click', () => {
    const memo = state.get('activeMemo');
    if (!memo) return;
    memo.isFavorite = !memo.isFavorite;
    const btn = document.getElementById('editor-fav-btn');
    if (btn) {
      btn.classList.toggle('active', !!memo.isFavorite);
      btn.querySelector('svg')?.setAttribute('fill', memo.isFavorite ? 'currentColor' : 'none');
    }
  });

  document.getElementById('editor-pin-btn')?.addEventListener('click', () => {
    const memo = state.get('activeMemo');
    if (!memo) return;
    memo.isPinned = !memo.isPinned;
    const btn = document.getElementById('editor-pin-btn');
    if (btn) {
      btn.classList.toggle('pinned-active', !!memo.isPinned);
    }
  });

  document.getElementById('editor-delete-btn')?.addEventListener('click', async () => {
    const memo = state.get('activeMemo');
    if (!memo || !memo.id) {
      await flushEditorAutosave();
      if (!editorHasUnsavedChanges) await navigateTo('dashboard');
      return;
    }

    try {
      await flushEditorAutosave();
      if (editorHasUnsavedChanges) return;
      await api.deleteMemo(memo.id, false);
      showToast('Note moved to Trash', 'info', 2000);
      await refreshWorkspaceMemos();
      navigateTo('dashboard');
    } catch {
      showToast('Failed to delete note', 'error');
    }
  });

  document.getElementById('editor-conflict-reload-btn')?.addEventListener('click', async () => {
    const memo = state.get('activeMemo');
    if (!memo || !memo.id) return;
    try {
      const res = await api.getMemo(memo.id);
      if (res && res.memo) {
        loadMemoIntoEditor(res.memo);
        showToast('Loaded latest version of note', 'info');
      }
    } catch {
      showToast('Failed to reload note', 'error');
    }
  });

  setupFormattingToolbar();

  document.getElementById('tab-write-btn')?.addEventListener('click', () => setEditorTab('write'));
  document.getElementById('tab-preview-btn')?.addEventListener('click', () => setEditorTab('preview'));
  document.getElementById('tab-split-btn')?.addEventListener('click', () => setEditorTab('split'));

  document.getElementById('memo-due-date-clear-btn')?.addEventListener('click', () => {
    const input = document.getElementById('memo-due-date-input');
    const mobileInput = document.getElementById('mobile-memo-due-date-input');
    if (input) input.value = '';
    if (mobileInput) mobileInput.value = '';
  });

  const addTagHandler = () => {
    const input = document.getElementById('editor-new-tag-input');
    const tagName = input?.value.trim().toLowerCase().replace(/^[#\s]+/, '');
    if (!tagName) return;

    const memo = state.get('activeMemo');
    if (memo) {
      memo.tags = memo.tags || [];
      if (!memo.tags.includes(tagName)) {
        memo.tags.push(tagName);
        renderEditorTags(memo.tags);
        syncMobileTagChips();
      }
    }
    if (input) input.value = '';
  };

  document.getElementById('editor-add-tag-btn')?.addEventListener('click', addTagHandler);
  document.getElementById('editor-new-tag-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTagHandler();
    }
  });

  // Modal Triggers: Add Workspace, Add Category, Add Tag, Add Folder
  document.getElementById('add-workspace-btn')?.addEventListener('click', () => openModal('modal-workspace'));
  document.getElementById('modal-ws-close-btn')?.addEventListener('click', () => closeModal('modal-workspace'));
  document.getElementById('modal-ws-cancel-btn')?.addEventListener('click', () => closeModal('modal-workspace'));

  document.getElementById('create-workspace-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('ws-name-input');
    const slugInput = document.getElementById('ws-slug-input');
    const alertEl = document.getElementById('workspace-modal-alert');

    const name = nameInput?.value.trim();
    const slug = slugInput?.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');

    if (!name || !slug) return;

    try {
      const res = await api.createWorkspace({ name, slug });
      showToast(`Created workspace: ${res.workspace.name}`, 'success');
      closeModal('modal-workspace');
      nameInput.value = '';
      slugInput.value = '';

      const meData = await api.getMe();
      if (meData && meData.workspaces) {
        state.set('workspaces', meData.workspaces);
        state.set('activeWorkspace', res.workspace);
        await refreshWorkspaceMemos();
      }
    } catch (err) {
      if (alertEl) {
        alertEl.className = 'auth-alert error active';
        alertEl.textContent = err.message || 'Failed to create workspace';
      }
    }
  });

  document.getElementById('add-category-btn')?.addEventListener('click', () => openModal('modal-category'));
  document.getElementById('modal-cat-close-btn')?.addEventListener('click', () => closeModal('modal-category'));
  document.getElementById('modal-cat-cancel-btn')?.addEventListener('click', () => closeModal('modal-category'));

  document.getElementById('create-category-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const activeWs = state.get('activeWorkspace');
    if (!activeWs || !activeWs.id) return;

    const nameInput = document.getElementById('cat-name-input');
    const colorInput = document.querySelector('input[name="cat-color"]:checked');

    const name = nameInput?.value.trim();
    const color = colorInput?.value || '#3b82f6';

    if (!name) return;

    try {
      await api.createCategory({ workspaceId: activeWs.id, name, color });
      showToast(`Created category: ${name}`, 'success');
      closeModal('modal-category');
      nameInput.value = '';
      await refreshWorkspaceMemos();
    } catch (err) {
      showToast(err.message || 'Failed to create category', 'error');
    }
  });

  document.getElementById('add-tag-btn')?.addEventListener('click', () => openModal('modal-tag'));
  document.getElementById('modal-tag-close-btn')?.addEventListener('click', () => closeModal('modal-tag'));
  document.getElementById('modal-tag-cancel-btn')?.addEventListener('click', () => closeModal('modal-tag'));

  document.getElementById('create-tag-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const activeWs = state.get('activeWorkspace');
    if (!activeWs || !activeWs.id) return;

    const nameInput = document.getElementById('tag-name-input');
    const name = nameInput?.value.trim().toLowerCase().replace(/^[#\s]+/, '');

    if (!name) return;

    try {
      await api.createTag({ workspaceId: activeWs.id, name });
      showToast(`Created tag: #${name}`, 'success');
      closeModal('modal-tag');
      nameInput.value = '';
      await refreshWorkspaceMemos();
    } catch (err) {
      showToast(err.message || 'Failed to create tag', 'error');
    }
  });

  document.getElementById('add-folder-btn')?.addEventListener('click', () => openModal('modal-folder'));
  document.getElementById('modal-folder-close-btn')?.addEventListener('click', () => closeModal('modal-folder'));
  document.getElementById('modal-folder-cancel-btn')?.addEventListener('click', () => closeModal('modal-folder'));

  document.getElementById('create-folder-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const activeWs = state.get('activeWorkspace');
    const nameInput = document.getElementById('folder-name-input');
    const name = nameInput?.value.trim();
    if (!activeWs?.id || !name) return;

    try {
      const result = await api.createFolder({ workspaceId: activeWs.id, name });
      const folders = [...(state.get('folders') || []), result.folder];
      state.set('folders', folders);
      renderSidebarFolders(folders);
      populateFolderSelect(result.folder.id);
      closeModal('modal-folder');
      if (nameInput) nameInput.value = '';
      showToast(`Created folder: ${result.folder.name}`, 'success');
    } catch (error) {
      showToast(error.message || 'Failed to create folder', 'error');
    }
  });

  // Mobile Bottom Navigation Tabs
  document.getElementById('mob-nav-home')?.addEventListener('click', () => navigateTo('dashboard'));
  document.getElementById('mob-nav-calendar')?.addEventListener('click', () => {
    navigateTo('dashboard');
    document.querySelector('.calendar-widget-card')?.scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('mob-nav-tags')?.addEventListener('click', () => {
    navigateTo('dashboard');
    document.getElementById('sidebar-tags-group')?.scrollIntoView({ behavior: 'smooth' });
  });
  document.getElementById('mob-nav-profile')?.addEventListener('click', () => {
    if (state.get('isAuthenticated')) {
      toggleUserDropdown();
    } else {
      navigateTo('auth', { mode: 'login' });
    }
  });

  // Mobile Drawer Toggle
  const mobileToggle = document.getElementById('mobile-menu-toggle');
  const sidebar = document.getElementById('app-sidebar');
  const overlay = document.getElementById('sidebar-overlay');

  mobileToggle?.addEventListener('click', () => {
    const open = !sidebar?.classList.contains('open');
    sidebar?.classList.toggle('open', open);
    overlay?.classList.toggle('active', open);
    mobileToggle.setAttribute('aria-expanded', String(open));
  });

  overlay?.addEventListener('click', () => {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('active');
    mobileToggle?.setAttribute('aria-expanded', 'false');
  });

  // Keyboard Shortcuts: ⌘K or Ctrl+K for search, Esc to close modals
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      const searchInput = document.getElementById('global-search-input');
      if (searchInput && state.get('currentView') === 'dashboard') {
        searchInput.focus();
        searchInput.select();
      }
    }
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.active').forEach((modal) => {
        modal.classList.remove('active');
      });
      closeUserDropdown();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      if (state.get('currentView') === 'editor') {
        e.preventDefault();
        saveActiveMemo();
      }
    }
  });
}

export async function loadWorkspaceMembers() {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id) return;
  const listEl = document.getElementById('workspace-members-list');
  const actListEl = document.getElementById('workspace-activities-list');
  if (listEl) listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Loading members...</span>';
  if (actListEl) actListEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Loading activity...</span>';
  try {
    const [membersRes, actRes] = await Promise.allSettled([
      api.getWorkspaceMembers(activeWs.id),
      api.getWorkspaceActivities(activeWs.id),
    ]);
    const members = (membersRes.status === 'fulfilled' && membersRes.value?.members) || [];
    if (listEl) {
      if (!members.length) {
        listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No other members in this workspace yet.</span>';
      } else {
        listEl.innerHTML = members.map((m) => `
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 6px;">
            <div>
              <div style="font-weight: 500; font-size: 0.85rem;">${escapeHtml(m.name || 'Member')}</div>
              <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(m.email)}</div>
            </div>
            <span class="badge badge-sm badge-personal" style="text-transform: capitalize;">${escapeHtml(m.role)}</span>
          </div>
        `).join('');
      }
    }

    if (actListEl) {
      const activities = (actRes.status === 'fulfilled' && actRes.value?.activities) || [];
      if (!activities.length) {
        actListEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No recent activity in this workspace yet.</span>';
      } else {
        actListEl.innerHTML = activities.map((a) => {
          let actionLabel = 'Action';
          if (a.type === 'note_edited') actionLabel = `Edited note "${escapeHtml(a.detail || 'Untitled')}"`;
          else if (a.type === 'note_created') actionLabel = `Created note "${escapeHtml(a.detail || 'Untitled')}"`;
          else if (a.type === 'member_joined') actionLabel = `Joined as ${escapeHtml(a.detail || 'member')}`;
          const timeStr = a.timestamp ? new Date(a.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
          return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.6rem; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 6px; font-size: 0.8rem;">
              <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70%;">
                <span style="font-weight: 600; color: var(--text-primary);">${escapeHtml(a.userName || a.userEmail || 'User')}</span>
                <span style="color: var(--text-secondary); margin-left: 0.25rem;">${actionLabel}</span>
              </div>
              <span style="font-size: 0.7rem; color: var(--text-muted); white-space: nowrap;">${timeStr}</span>
            </div>
          `;
        }).join('');
      }
    }
  } catch {
    if (listEl) listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Members available on active workspace.</span>';
    if (actListEl) actListEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Activity log unavailable.</span>';
  }
}
