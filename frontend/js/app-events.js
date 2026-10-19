/**
 * Application Events & UI Interactions Wiring
 * Connects top navigation, modals, sidebar controls, editor toolbars, and team management.
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml } from './markdown.js';
import { showToast, openModal, closeModal, toggleTheme, showConfirmDialog } from './utils.js';
import { navigateTo } from './navigation.js';
import {
  setAuthMode,
  handleAuthSubmit,
  handleLogout,
  closeUserDropdown,
  toggleUserDropdown,
  renderStrengthMeter
} from './auth.js';
import { refreshWorkspaceMemos, updateDashboardDateBadge, loadMoreMemos } from './workspace-data.js';
import { setFilter, filterAndRenderMemos } from './search-filter.js';
import { renderUpcomingReminders } from './memo-renderer.js';
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
import { setupKeepPopovers, closeKeepPopovers } from './keep-popovers.js';
import { setupKeepLightbox } from './keep-lightbox.js';
import { setupKeepSelection } from './keep-selection.js';
import { setupKeepLabelsModal, openKeepLabelsModal } from './keep-labels-modal.js';
import { setupServerNotifications } from './notifications.js';
import { isTakeoutZipFile, buildPayloadFromTakeoutZip, buildPayloadFromLooseFiles, importIntoWorkspace } from './keep-import.js';
import { setupKeepKeyboardShortcuts } from './keep-shortcuts.js';
import { setupMultiTabSync } from './keep-sync.js';
import { setupVoiceNotes } from './voice-notes.js';
import {
  setupKeepModalListeners,
  activeKeepModalMemo,
  renderKeepModalAttachments,
  closeKeepNoteModal
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
  // Remote multi-tab sync broadcasts arrive in bursts; coalesce them so sibling
  // tabs trigger at most one workspace refetch per change (ARCH-01 companion).
  let remoteRefreshTimer = null;
  const debouncedRemoteRefresh = () => {
    clearTimeout(remoteRefreshTimer);
    remoteRefreshTimer = setTimeout(() => void refreshWorkspaceMemos(false), 150);
  };

  // Audit L-11: an expired session used to fail one action at a time. The
  // API client broadcasts this once on the first data-endpoint 401; here we
  // return the user to the sign-in screen instead.
  window.addEventListener('notes:session-expired', () => {
    if (!state.get('isAuthenticated')) return;
    state.clearUser();
    closeKeepPopovers?.();
    showToast('Your session has expired. Please sign in again.', 'warning', 5000);
    navigateTo('auth', { mode: 'login' });
  });

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
    const demoUser = { id: 'demo-user-1', name: 'Alex', email: 'alex.morgan@memomanager.local' };
    const demoWorkspaces = [
      { id: 'demo-ws-personal', name: 'Personal', slug: 'personal', role: 'owner' },
      { id: 'demo-ws-work', name: 'Work', slug: 'work', role: 'member' }
    ];
    const now = Date.now();
    const demoMemos = [
      {
        id: 'demo-memo-1',
        title: 'Project Planning',
        content: '# Q4 Project Planning\n\nThis is an important project for Q4. Need to focus on core features and prepare for launch.\n\n- [x] Complete inventory module\n- [x] Mobile app improvements\n- [x] Marketing website design\n- [ ] Prepare demo for client\n- [ ] Review security checklist\n\nWeekly cadence and design sprint sync scheduled with the engineering squad.',
        noteType: 'checklist',
        checklistData: [
          { id: 'c1', text: 'Complete inventory module', checked: true },
          { id: 'c2', text: 'Mobile app improvements', checked: true },
          { id: 'c3', text: 'Marketing website design', checked: true },
          { id: 'c4', text: 'Prepare demo for client', checked: false },
          { id: 'c5', text: 'Review security checklist', checked: false }
        ],
        color: 'yellow',
        theme: 'none',
        status: 'pending',
        priority: 'high',
        isPinned: true,
        isFavorite: true,
        dueDate: now + 5 * 86400000,
        createdAt: now - 7200000,
        updatedAt: now - 3600000,
        workspaceId: 'demo-ws-personal',
        tags: ['project', 'planning', 'q4'],
        category: { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      },
      {
        id: 'demo-memo-2',
        title: 'Study Notes - Japanese',
        content: '# JLPT N3 Grammar & Vocabulary\n\nGrammar points to review this week:\n- ～に対して (in contrast to / towards)\n- ～わけにはいかない (cannot afford to)\n- ～をはじめ (starting with / such as)\n\nPractice reading NHK News Web Easy articles daily for 20 minutes.',
        noteType: 'text',
        color: 'orange',
        theme: 'none',
        status: 'pending',
        priority: 'medium',
        isPinned: true,
        isFavorite: true,
        dueDate: now + 3 * 86400000,
        createdAt: now - 18000000,
        updatedAt: now - 7200000,
        workspaceId: 'demo-ws-personal',
        tags: ['study', 'japanese', 'jlpt'],
        category: { id: 'cat-4', name: 'Study', color: '#f97316' },
      },
      {
        id: 'demo-memo-3',
        title: 'Shopping List',
        content: 'Weekly groceries and pantry essentials:\n- [x] Almond milk (unsweetened)\n- [x] Organic sourdough bread\n- [x] Fresh blueberries & strawberries\n- [x] Greek yogurt (plain 0%)\n- [ ] Chia seeds\n- [ ] Olive oil extra virgin',
        noteType: 'checklist',
        checklistData: [
          { id: 'g1', text: 'Almond milk (unsweetened)', checked: true },
          { id: 'g2', text: 'Organic sourdough bread', checked: true },
          { id: 'g3', text: 'Fresh blueberries & strawberries', checked: true },
          { id: 'g4', text: 'Greek yogurt (plain 0%)', checked: true },
          { id: 'g5', text: 'Chia seeds', checked: false },
          { id: 'g6', text: 'Olive oil extra virgin', checked: false }
        ],
        color: 'teal',
        theme: 'grocery',
        status: 'completed',
        priority: 'medium',
        isPinned: false,
        isFavorite: false,
        dueDate: now - 3600000,
        createdAt: now - 86400000,
        updatedAt: now - 1800000,
        workspaceId: 'demo-ws-personal',
        tags: ['shopping', 'personal'],
        category: { id: 'cat-3', name: 'Personal', color: '#10b981' },
      },
      {
        id: 'demo-memo-4',
        title: 'Server Setup Guide',
        content: '# Ubuntu 24.04 Production Hardening\n\nKey configuration commands:\n```bash\nsudo ufw default deny incoming\nsudo ufw default allow outgoing\nsudo ufw allow ssh\nsudo ufw allow http\nsudo ufw allow https\nsudo ufw enable\n```\nConfigure unattended-upgrades and set up fail2ban.',
        noteType: 'text',
        color: 'blue',
        theme: 'none',
        status: 'completed',
        priority: 'high',
        isPinned: false,
        isFavorite: false,
        dueDate: now - 86400000,
        createdAt: now - 2 * 86400000,
        updatedAt: now - 86400000,
        workspaceId: 'demo-ws-personal',
        tags: ['devops', 'server', 'linux'],
        category: { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      },
      {
        id: 'demo-memo-5',
        title: 'Design Inspiration',
        content: 'UI/UX ideas for modern dashboards and card interactions:\n- Clean glassmorphism backdrop with subtle blur\n- Pastel badge tags with high contrast font colors\n- Fluid clamp scaling for hero visual mockups\n- Micro-interactions on button hover and tap states',
        noteType: 'text',
        color: 'purple',
        theme: 'none',
        status: 'pending',
        priority: 'low',
        isPinned: false,
        isFavorite: true,
        dueDate: null,
        createdAt: now - 3 * 86400000,
        updatedAt: now - 2 * 86400000,
        workspaceId: 'demo-ws-personal',
        tags: ['design', 'ui-ux', 'inspiration'],
        category: { id: 'cat-5', name: 'Design', color: '#ec4899' },
      },
      {
        id: 'demo-memo-6',
        title: 'Submit college assignment',
        content: 'Final project submission for Distributed Systems course.\nEnsure test coverage is 95%+, all docker-compose scripts run out of the box, and the architectural report is exported to PDF.',
        noteType: 'text',
        color: 'red',
        theme: 'none',
        status: 'pending',
        priority: 'high',
        isPinned: false,
        isFavorite: true,
        dueDate: now + 3600000 * 2,
        reminderTime: now + 3600000 * 2,
        createdAt: now - 12000000,
        updatedAt: now - 3600000,
        workspaceId: 'demo-ws-personal',
        tags: ['study', 'assignment', 'deadline'],
        category: { id: 'cat-4', name: 'Study', color: '#f97316' },
      },
      {
        id: 'demo-memo-7',
        title: 'Buy server SSD',
        content: 'Order replacement high-endurance 2TB NVMe PCIe 4.0 SSD for internal staging server.\nCompare Kingston KC3000 vs Samsung 990 Pro prices.',
        noteType: 'text',
        color: 'gray',
        theme: 'none',
        status: 'pending',
        priority: 'medium',
        isPinned: false,
        isFavorite: false,
        dueDate: now + 86400000,
        reminderTime: now + 86400000,
        createdAt: now - 18000000,
        updatedAt: now - 7200000,
        workspaceId: 'demo-ws-personal',
        tags: ['hardware', 'procurement', 'server'],
        category: { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      },
      {
        id: 'demo-memo-8',
        title: 'Japanese class',
        content: 'Live speaking session with Sensei Tanaka on Zoom.\nTopic: Describing software development workflows and agile sprint terminology in polite keigo.',
        noteType: 'text',
        color: 'pink',
        theme: 'none',
        status: 'pending',
        priority: 'high',
        isPinned: false,
        isFavorite: true,
        dueDate: now + 2 * 86400000,
        reminderTime: now + 2 * 86400000,
        createdAt: now - 24000000,
        updatedAt: now - 12000000,
        workspaceId: 'demo-ws-personal',
        tags: ['study', 'japanese'],
        category: { id: 'cat-4', name: 'Study', color: '#f97316' },
      },
      {
        id: 'demo-memo-9',
        title: 'Q4 Budget & Forecast',
        content: 'Review infrastructure cost estimates for Q4:\n- GCE / Cloud instances: $350/mo\n- S3 / Storage egress: $80/mo\n- Domain renewals & SSL certs: $45\n\nTotal allocated buffer: $2,500.',
        noteType: 'text',
        color: 'yellow',
        theme: 'none',
        status: 'completed',
        priority: 'high',
        isPinned: false,
        isFavorite: false,
        dueDate: now - 86400000 * 2,
        createdAt: now - 4 * 86400000,
        updatedAt: now - 86400000 * 2,
        workspaceId: 'demo-ws-personal',
        tags: ['finance', 'budget', 'q4'],
        category: { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      },
      {
        id: 'demo-memo-10',
        title: 'Book Reading List 2026',
        content: '- [x] Designing Data-Intensive Applications by Martin Kleppmann\n- [x] Understanding Distributed Systems by Roberto Vitillo\n- [ ] Database Internals by Alex Petrov\n- [ ] Staff Engineer by Will Larson',
        noteType: 'checklist',
        checklistData: [
          { id: 'b1', text: 'Designing Data-Intensive Applications by Martin Kleppmann', checked: true },
          { id: 'b2', text: 'Understanding Distributed Systems by Roberto Vitillo', checked: true },
          { id: 'b3', text: 'Database Internals by Alex Petrov', checked: false },
          { id: 'b4', text: 'Staff Engineer by Will Larson', checked: false }
        ],
        color: 'teal',
        theme: 'none',
        status: 'completed',
        priority: 'low',
        isPinned: false,
        isFavorite: false,
        dueDate: null,
        createdAt: now - 5 * 86400000,
        updatedAt: now - 2 * 86400000,
        workspaceId: 'demo-ws-personal',
        tags: ['books', 'learning', 'personal'],
        category: { id: 'cat-3', name: 'Personal', color: '#10b981' },
      },
      {
        id: 'demo-memo-11',
        title: 'Home Renovation Ideas',
        content: 'Smart workspace upgrade checklist:\n- [x] Height-adjustable dual-motor standing desk\n- [x] Monitor arm with cable conduit\n- [ ] Philips Hue smart ambient lightstrip\n- [ ] Acoustic foam panels for home office podcast corner',
        noteType: 'checklist',
        checklistData: [
          { id: 'h1', text: 'Height-adjustable dual-motor standing desk', checked: true },
          { id: 'h2', text: 'Monitor arm with cable conduit', checked: true },
          { id: 'h3', text: 'Philips Hue smart ambient lightstrip', checked: false },
          { id: 'h4', text: 'Acoustic foam panels for home office podcast corner', checked: false }
        ],
        color: 'brown',
        theme: 'none',
        status: 'pending',
        priority: 'medium',
        isPinned: false,
        isFavorite: false,
        dueDate: now + 7 * 86400000,
        createdAt: now - 3 * 86400000,
        updatedAt: now - 86400000,
        workspaceId: 'demo-ws-personal',
        tags: ['home', 'workspace', 'renovation'],
        category: { id: 'cat-3', name: 'Personal', color: '#10b981' },
      },
      {
        id: 'demo-memo-12',
        title: 'API Architecture Specs',
        content: '# Memo Manager Backend API\n\n- OpenAPI 3.1 Swagger docs reachable at `/docs`\n- Rate limiting at 300 req/min with trusted proxy evaluation\n- Content Security Policy locked to `default-src \'self\'`\n- SQLite WAL journaling with FTS5 search index',
        noteType: 'text',
        color: 'darkblue',
        theme: 'none',
        status: 'completed',
        priority: 'high',
        isPinned: false,
        isFavorite: false,
        dueDate: null,
        createdAt: now - 6 * 86400000,
        updatedAt: now - 3 * 86400000,
        workspaceId: 'demo-ws-personal',
        tags: ['api', 'architecture', 'backend'],
        category: { id: 'cat-2', name: 'Engineering', color: '#8b5cf6' },
      },
      {
        id: 'demo-memo-13',
        title: 'Workout Routine & Fitness',
        content: 'Weekly fitness milestones:\n- [x] Monday: 5km morning run + core stability\n- [x] Wednesday: Upper body push/pull compound lifts\n- [x] Friday: Leg day squats and lunges\n- [x] Sunday: 45 min recovery mobility & stretching',
        noteType: 'checklist',
        checklistData: [
          { id: 'w1', text: 'Monday: 5km morning run + core stability', checked: true },
          { id: 'w2', text: 'Wednesday: Upper body push/pull compound lifts', checked: true },
          { id: 'w3', text: 'Friday: Leg day squats and lunges', checked: true },
          { id: 'w4', text: 'Sunday: 45 min recovery mobility & stretching', checked: true }
        ],
        color: 'green',
        theme: 'none',
        status: 'completed',
        priority: 'medium',
        isPinned: false,
        isFavorite: false,
        dueDate: null,
        createdAt: now - 4 * 86400000,
        updatedAt: now - 86400000,
        workspaceId: 'demo-ws-personal',
        tags: ['fitness', 'health', 'workout'],
        category: { id: 'cat-3', name: 'Personal', color: '#10b981' },
      },
      {
        id: 'demo-memo-14',
        title: 'Customer Feedback Summary',
        content: 'User feedback highlights from 50 beta test sessions:\n1. Loved the pastel Google Keep aesthetic and fast search.\n2. Tablet drawer auto-close on backdrop tap received great praise.\n3. Mobile navigation is smooth and distraction-free.',
        noteType: 'text',
        color: 'yellow',
        theme: 'none',
        status: 'completed',
        priority: 'medium',
        isPinned: false,
        isFavorite: false,
        dueDate: null,
        createdAt: now - 5 * 86400000,
        updatedAt: now - 86400000,
        workspaceId: 'demo-ws-personal',
        tags: ['feedback', 'product', 'ux'],
        category: { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      },
    ];

    state.setUser(demoUser, demoWorkspaces, demoWorkspaces[0]);
    state.set('allWorkspaceMemos', demoMemos);
    state.set('categories', [
      { id: 'cat-1', name: 'Work', color: '#3b82f6' },
      { id: 'cat-2', name: 'Engineering', color: '#8b5cf6' },
      { id: 'cat-3', name: 'Personal', color: '#10b981' },
      { id: 'cat-4', name: 'Study', color: '#f97316' },
      { id: 'cat-5', name: 'Design', color: '#ec4899' },
    ]);
    state.set('tags', [
      { id: 't-1', name: 'project' },
      { id: 't-2', name: 'planning' },
      { id: 't-3', name: 'q4' },
      { id: 't-4', name: 'study' },
      { id: 't-5', name: 'japanese' },
      { id: 't-6', name: 'shopping' },
      { id: 't-7', name: 'devops' },
      { id: 't-8', name: 'design' },
      { id: 't-9', name: 'budget' }
    ]);
    state.set('folders', [
      { id: 'f-1', name: 'Projects' },
      { id: 'f-2', name: 'Personal' }
    ]);
    state.updateKpisFromMemos(demoMemos);

    renderSidebarCategories(state.get('categories'));
    renderSidebarTags(state.get('tags'));
    renderSidebarFolders(state.get('folders'));
    renderWorkspacesList(demoWorkspaces);
    updateSidebarBadges();
    updateDashboardDateBadge();
    setFilter('dashboard');
    renderInteractiveCalendar();
    renderUpcomingReminders();

    navigateTo('dashboard');
    showToast('Loaded interactive demo workspace with sample memos!', 'success', 3000);
  });
  document.getElementById('bottom-cta-btn')?.addEventListener('click', () => navigateTo('auth', { mode: 'register' }));

  // Landing navbar "Resources" dropdown (FAQ, API docs, GitHub).
  const resourcesToggle = document.getElementById('nav-resources-link');
  const resourcesMenu = document.getElementById('nav-resources-menu');
  if (resourcesToggle && resourcesMenu) {
    const setResourcesOpen = (open) => {
      resourcesMenu.hidden = !open;
      resourcesToggle.setAttribute('aria-expanded', String(open));
    };
    resourcesToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setResourcesOpen(resourcesMenu.hidden);
    });
    resourcesMenu.addEventListener('click', (e) => {
      if (e.target.closest('.nav-dropdown-item')) setResourcesOpen(false);
    });
    document.addEventListener('click', (e) => {
      if (!resourcesMenu.hidden && !e.target.closest('#nav-resources-dropdown')) setResourcesOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !resourcesMenu.hidden) {
        setResourcesOpen(false);
        resourcesToggle.focus();
      }
    });
  }

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

  // SOCIAL OAUTH (MOCK-04): the provider buttons were removed from the auth
  // screen — this app has no OAuth integration, and email/password,
  // invitations and the live demo are the supported sign-in paths.

  document.getElementById('auth-forgot-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    setAuthMode('forgot');
  });

  // DATA-03: warn before closing or refreshing the tab while edits are pending.
  window.addEventListener('beforeunload', (event) => {
    if (state.get('hasUnsavedChanges')) {
      // Standard API: preventDefault + returnValue trigger the browser's
      // "Changes you made may not be saved" confirmation dialog.
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // MOCK-01: landing page pricing CTAs now lead somewhere real.
  document.getElementById('pricing-free-cta')?.addEventListener('click', () => {
    navigateTo('auth', { mode: 'register' });
  });
  document.getElementById('pricing-pro-cta')?.addEventListener('click', () => {
    // Self-hosted edition: every Pro capability is already enabled.
    if (state.get('isAuthenticated')) {
      showToast('All Pro features are already enabled on your self-hosted instance.', 'info', 3500);
      navigateTo('dashboard');
    } else {
      navigateTo('auth', { mode: 'register' });
    }
  });
  document.getElementById('pricing-enterprise-cta')?.addEventListener('click', () => {
    document.getElementById('resources')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // The notification bell is wired by setupServerNotifications(): it opens the
  // server-backed reminders dropdown instead of a static due-soon filter.

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
    openAccountSettingsModal();
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

  // Empty Trash — permanently purge every soft-deleted note in the workspace.
  document.getElementById('empty-trash-btn')?.addEventListener('click', () => {
    const activeWs = state.get('activeWorkspace');
    if (!activeWs?.id) {
      showToast('Select a workspace first', 'error');
      return;
    }
    const trashCount = (state.get('trashMemos') || []).length;
    if (trashCount === 0) {
      showToast('Trash is already empty', 'info', 1800);
      return;
    }
    showConfirmDialog(
      'Empty Trash',
      `Permanently delete all ${trashCount} note${trashCount === 1 ? '' : 's'} in the Trash of "${activeWs.name || 'this workspace'}"? This cannot be undone.`,
      async () => {
        const btn = document.getElementById('empty-trash-btn');
        const labelSpan = btn?.querySelector('span');
        if (btn) btn.disabled = true;
        if (labelSpan) labelSpan.textContent = 'Emptying…';
        try {
          const res = await api.emptyTrash(activeWs.id);
          const deleted = res?.deletedCount ?? 0;
          showToast(
            deleted > 0
              ? `Trash emptied — ${deleted} note${deleted === 1 ? '' : 's'} permanently deleted`
              : 'Trash is already empty',
            'success',
            3000
          );
          state.set('trashMemos', []);
          await refreshWorkspaceMemos();
          await filterAndRenderMemos();
        } catch (err) {
          showToast(err.message || 'Failed to empty trash', 'error', 5000);
        } finally {
          // Re-sync the button state from the refreshed trash list — the render
          // pass may have already disabled it because the trash is now empty.
          if (btn) {
            btn.disabled = ((state.get('trashMemos') || []).length) === 0;
          }
          if (labelSpan) labelSpan.textContent = 'Empty Trash';
        }
      }
    );
  });

  document.getElementById('clear-filter-btn')?.addEventListener('click', () => setFilter('all'));

  document.getElementById('dashboard-refresh-btn')?.addEventListener('click', () => {
    showToast('Refreshing workspace notes...', 'info', 1000);
    refreshWorkspaceMemos();
  });

  // Pagination: append the next page of notes (stream or trash)
  document.getElementById('load-more-btn')?.addEventListener('click', () => void loadMoreMemos());

  document.getElementById('filter-status-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('filter-priority-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('filter-type-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('filter-color-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('sort-memos-select')?.addEventListener('change', () => filterAndRenderMemos());

  // View Mode Switcher (Grid vs List) — restore the user's saved preference.
  const gridBtn = document.getElementById('view-mode-grid-btn');
  const listBtn = document.getElementById('view-mode-list-btn');
  const savedViewMode = localStorage.getItem('memo_view_mode') === 'list' ? 'list' : 'grid';
  state.set('viewMode', savedViewMode);
  gridBtn?.classList.toggle('active', savedViewMode === 'grid');
  listBtn?.classList.toggle('active', savedViewMode === 'list');

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
  setupVoiceNotes();
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
  setupServerNotifications({
    onOpenMemo: () => navigateTo('dashboard'),
  });
  setupKeepKeyboardShortcuts({
    onRefresh: refreshWorkspaceMemos
  });
  setupMultiTabSync({
    onMemosChanged: debouncedRemoteRefresh,
    onLabelsChanged: debouncedRemoteRefresh,
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
    const requestedFolderId = state.get('activeFilter')?.type === 'folder' ? state.get('activeFilter').value : null;

    const newMemo = {
      title: '',
      content: '',
      categoryId: null,
      folderId: requestedFolderId || null,
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
  document.getElementById('hero-new-memo-btn')?.addEventListener('click', createNewMemoHandler);
  document.getElementById('empty-state-action-btn')?.addEventListener('click', createNewMemoHandler);
  document.getElementById('mob-nav-create')?.addEventListener('click', createNewMemoHandler);

  // Mobile quick filter tabs
  document.querySelectorAll('.mobile-filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const tabFilter = tab.getAttribute('data-mobile-filter');
      const statusSelect = document.getElementById('filter-status-select');
      if (tabFilter === 'favorite') {
        if (statusSelect) statusSelect.value = '';
        setFilter('favorites');
      } else if (tabFilter === 'pending') {
        if (statusSelect) statusSelect.value = 'pending';
        setFilter('all');
      } else {
        if (statusSelect) statusSelect.value = '';
        setFilter('all');
      }
    });
  });

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

  // Upgrade Plan Modal Handlers (MOCK-02: the dialog is now an informational
  // self-hosted notice — there is no billing backend, so no fake success toasts).
  document.getElementById('storage-upgrade-btn')?.addEventListener('click', () => openModal('modal-upgrade-plan'));
  document.getElementById('modal-plan-close-btn')?.addEventListener('click', () => closeModal('modal-upgrade-plan'));
  document.getElementById('modal-plan-close-footer-btn')?.addEventListener('click', () => closeModal('modal-upgrade-plan'));

  // Version History Modal Close Handlers
  document.getElementById('modal-history-close-btn')?.addEventListener('click', () => closeModal('modal-history'));
  document.getElementById('modal-history-cancel-btn')?.addEventListener('click', () => closeModal('modal-history'));

  // Account Profile Settings Modal Handlers
  document.getElementById('modal-profile-close-btn')?.addEventListener('click', () => closeModal('modal-profile'));
  document.getElementById('modal-profile-cancel-btn')?.addEventListener('click', () => closeModal('modal-profile'));

  // Live password strength + confirmation in the settings modal
  const profileNewPwdInput = document.getElementById('profile-new-pwd-input');
  profileNewPwdInput?.addEventListener('input', () => {
    renderStrengthMeter(
      document.getElementById('profile-strength-meter'),
      document.getElementById('profile-strength-label'),
      profileNewPwdInput.value
    );
    document.getElementById('profile-confirm-pwd-error')?.classList.remove('active');
  });
  document.getElementById('profile-confirm-pwd-input')?.addEventListener('input', () => {
    document.getElementById('profile-confirm-pwd-error')?.classList.remove('active');
  });

  document.getElementById('profile-revoke-sessions-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('profile-revoke-sessions-btn');
    btn.disabled = true;
    try {
      const res = await api.revokeOtherSessions();
      showToast(`Signed out of ${res.revoked} other session${res.revoked === 1 ? '' : 's'}`, 'success');
      await loadSessionsIntoSettings();
    } catch (err) {
      showToast(err.message || 'Failed to revoke sessions', 'error');
    } finally {
      btn.disabled = false;
    }
  });

  // Import & Export (Google Keep Takeout / JSON backups) in Account Settings
  let pendingImportPrepared = null;

  document.getElementById('settings-export-btn')?.addEventListener('click', async () => {
    const activeWs = state.get('activeWorkspace');
    if (!activeWs?.id) {
      showToast('Select a workspace to export', 'error');
      return;
    }
    try {
      showToast('Generating workspace backup…', 'info', 1500);
      const data = await api.exportWorkspace(activeWs.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `notes-backup-${(activeWs.name || 'workspace').toLowerCase()}-${Date.now()}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast('Backup downloaded', 'success');
    } catch (err) {
      showToast(err.message || 'Export failed', 'error');
    }
  });

  const importInput = document.getElementById('settings-import-file-input');
  document.getElementById('settings-import-browse-btn')?.addEventListener('click', () => importInput?.click());

  importInput?.addEventListener('change', async () => {
    const files = Array.from(importInput.files || []);
    importInput.value = '';
    if (!files.length) return;

    const selectionEl = document.getElementById('settings-import-selection');
    const previewEl = document.getElementById('settings-import-preview');
    const importBtn = document.getElementById('settings-import-btn');
    pendingImportPrepared = null;
    if (selectionEl) selectionEl.textContent = files.length === 1 ? files[0].name : `${files.length} files selected`;
    if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
    if (importBtn) importBtn.disabled = true;

    try {
      const prepared = files.length === 1 && isTakeoutZipFile(files[0])
        ? await buildPayloadFromTakeoutZip(files[0])
        : await buildPayloadFromLooseFiles(files);
      pendingImportPrepared = prepared;

      if (previewEl) {
        if (prepared.backupPayload) {
          previewEl.innerHTML = `Detected a <strong>Notes JSON backup</strong> with <strong>${(prepared.backupPayload.memos || []).length}</strong> note(s).`;
        } else {
          const checks = prepared.notes.filter((n) => n.noteType === 'checklist').length;
          if (prepared.source === 'markdown') {
            previewEl.innerHTML = `Detected a <strong>Markdown import</strong> with <strong>${prepared.notes.length}</strong> note(s) — each file is imported as a new note with all of its content.`;
            const tagNames = new Set();
            for (const note of prepared.notes) for (const tag of note.tags || []) tagNames.add(tag);
            if (tagNames.size) previewEl.innerHTML += ` <strong>${tagNames.size}</strong> label(s) from frontmatter.`;
          } else if (prepared.source === 'mixed') {
            previewEl.innerHTML = `Detected a <strong>mixed selection</strong> with <strong>${prepared.notes.length}</strong> note(s) from Google Keep exports and Markdown files, including <strong>${checks}</strong> checklist(s).`;
          } else {
            previewEl.innerHTML = `Detected a <strong>Google Keep export</strong> with <strong>${prepared.notes.length}</strong> note(s), `;
            previewEl.innerHTML += `<strong>${checks}</strong> checklist(s), <strong>${prepared.labels.length}</strong> label(s).`;
            if (prepared.embeddedImages) previewEl.innerHTML += ` ${prepared.embeddedImages} image(s) will be embedded.`;
            if (prepared.skippedImages) previewEl.innerHTML += ` ${prepared.skippedImages} image(s) skipped (too large).`;
            if (prepared.labels.length) previewEl.innerHTML += `<br><span style="color: var(--text-muted);">Google's export lists labels but not which note has which — labels are created so you can assign them.</span>`;
          }
        }
        previewEl.style.display = 'block';
      }
      if (importBtn) importBtn.disabled = false;
    } catch (err) {
      showToast(err.message || 'Could not read the selected file', 'error', 4000);
      if (selectionEl) selectionEl.textContent = 'No file selected';
    }
  });

  document.getElementById('settings-import-btn')?.addEventListener('click', async () => {
    if (!pendingImportPrepared) return;
    const importBtn = document.getElementById('settings-import-btn');
    importBtn.disabled = true;
    importBtn.textContent = 'Importing…';
    try {
      const result = await importIntoWorkspace(pendingImportPrepared);
      const labelPart = result.labels ? ` and ${result.labels} label(s)` : '';
      // Audit M-17: trashed Keep notes are intentionally skipped — say so.
      const trashedPart = pendingImportPrepared.trashedCount
        ? ` (${pendingImportPrepared.trashedCount} trashed note(s) skipped)`
        : '';
      showToast(`Imported ${result.memos} note(s)${labelPart}${trashedPart}`, 'success', 4500);
      pendingImportPrepared = null;
      const selectionEl = document.getElementById('settings-import-selection');
      const previewEl = document.getElementById('settings-import-preview');
      if (selectionEl) selectionEl.textContent = 'No file selected';
      if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
      closeModal('modal-profile');
      await refreshWorkspaceMemos();
    } catch (err) {
      showToast(err.message || 'Import failed', 'error', 5000);
      importBtn.disabled = false;
    } finally {
      importBtn.textContent = 'Import notes';
    }
  });

  document.getElementById('profile-settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('profile-name-input')?.value.trim();
    const currentPassword = document.getElementById('profile-current-pwd-input')?.value;
    const newPassword = document.getElementById('profile-new-pwd-input')?.value;
    const confirmPassword = document.getElementById('profile-confirm-pwd-input')?.value;
    const confirmError = document.getElementById('profile-confirm-pwd-error');

    if (newPassword && newPassword !== confirmPassword) {
      confirmError?.classList.add('active');
      return;
    }

    // Audit L-9: same policy as registration (the server enforces it too).
    if (newPassword && (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword))) {
      showToast('New password must be at least 8 characters and contain a letter and a number.', 'error', 4000);
      return;
    }

    try {
      const payload = { name };
      if (newPassword) {
        payload.currentPassword = currentPassword;
        payload.newPassword = newPassword;
      }
      const res = await api.updateProfile(payload);
      const user = res.user;
      state.set('user', { ...state.get('user'), ...user });
      const namePill = document.getElementById('user-menu-name');
      const fullnameEl = document.getElementById('dropdown-user-fullname');
      const avatarCircle = document.getElementById('user-avatar-circle');
      const profileAvatar = document.getElementById('profile-avatar-large');
      const profileNameLarge = document.getElementById('profile-name-large');
      if (namePill) namePill.textContent = (user.name || '').split(' ')[0];
      if (fullnameEl) fullnameEl.textContent = user.name || '';
      if (avatarCircle) avatarCircle.textContent = (user.name || 'U').charAt(0).toUpperCase();
      if (profileAvatar) profileAvatar.textContent = (user.name || 'U').charAt(0).toUpperCase();
      if (profileNameLarge) profileNameLarge.textContent = user.name || '';
      ['profile-current-pwd-input', 'profile-new-pwd-input', 'profile-confirm-pwd-input'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      renderStrengthMeter(document.getElementById('profile-strength-meter'), document.getElementById('profile-strength-label'), '');
      closeModal('modal-profile');
      showToast(newPassword ? 'Profile and password updated successfully' : 'Profile updated successfully', 'success');
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
    const alertEl = document.getElementById('invite-alert');
    if (!email || !activeWs?.id) return;

    alertEl.className = 'auth-alert';
    alertEl.textContent = '';

    try {
      const res = await api.createWorkspaceInvite(activeWs.id, { email, role });
      document.getElementById('invite-email-input').value = '';

      // Build the shareable link from this app's own origin (the backend's
      // APP_URL-based link is only used inside emails).
      const inviteLink = res.invite?.token
        ? `${window.location.origin}/#invite=${res.invite.token}`
        : res.inviteUrl;

      if (res.emailDelivery !== 'sent') {
        alertEl.className = 'auth-alert active';
        alertEl.innerHTML = res.emailDelivery === 'failed'
          ? `Invitation email could not be delivered — share this invite link: <strong>${escapeHtml(inviteLink)}</strong>`
          : `Email delivery is not configured on this server — share this invite link: <strong>${escapeHtml(inviteLink)}</strong>`;
        alertEl.innerHTML += ` <button type="button" class="btn btn-secondary btn-xs" data-copy-invite="${escapeHtml(inviteLink)}">Copy link</button>`;
      } else {
        alertEl.className = 'auth-alert success active';
        alertEl.textContent = `Invitation email sent to ${email}.`;
      }

      showToast(`Invitation created for ${email}`, 'success');
      await loadWorkspaceMembers();
    } catch (err) {
      alertEl.className = 'auth-alert error active';
      alertEl.textContent = err.message || 'Failed to create invitation';
    }
  });

  // Delegate: "Copy link" buttons inside the invite alert
  document.getElementById('invite-alert')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy-invite]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copyInvite);
      showToast('Invitation link copied — share it with your teammate', 'success');
    } catch {
      showToast('Could not copy automatically — select the link text manually', 'error');
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

  const closeMobileSidebar = () => {
    sidebar?.classList.remove('open');
    overlay?.classList.remove('active');
    mobileToggle?.setAttribute('aria-expanded', 'false');
  };
  window.__closeMobileSidebar = closeMobileSidebar; // exposed for other modules (e.g. search-filter)

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

  // UX-04: tapping any navigation or modal-triggering control inside the
  // mobile drawer closes it automatically, so menus never stack behind it.
  sidebar?.addEventListener('click', (e) => {
    if (e.target.closest('button, a, [role="button"]')) {
      closeMobileSidebar();
    }
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
      // Layered Escape handling: close only the topmost overlay.
      const drawingModal = document.getElementById('modal-keep-drawing');
      if (drawingModal?.classList.contains('active')) {
        closeModal('modal-keep-drawing');
        closeUserDropdown();
        return;
      }
      // The Keep in-place editor must save pending edits when closed via Escape.
      const keepEditorModal = document.getElementById('modal-keep-editor');
      if (keepEditorModal?.classList.contains('active')) {
        closeKeepNoteModal();
      } else {
        document.querySelectorAll('.modal-backdrop.active').forEach((modal) => {
          modal.classList.remove('active');
        });
        closeKeepPopovers();
      }
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
  const invitesEl = document.getElementById('workspace-invites-list');
  const actListEl = document.getElementById('workspace-activities-list');
  if (listEl) listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Loading members...</span>';
  if (invitesEl) invitesEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Loading invitations...</span>';
  if (actListEl) actListEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Loading activity...</span>';

  try {
    const [membersRes, actRes, invitesRes] = await Promise.allSettled([
      api.getWorkspaceMembers(activeWs.id),
      api.getWorkspaceActivities(activeWs.id),
      api.listWorkspaceInvites(activeWs.id),
    ]);
    const members = (membersRes.status === 'fulfilled' && membersRes.value?.members) || [];

    const currentUser = state.get('user');
    // Derive the viewer's role from the members response itself — state.workspaces
    // may not carry roles immediately after registration.
    const meMember = members.find((m) => m.userId === currentUser?.id);
    const canManage = meMember?.role === 'owner' || meMember?.role === 'admin';

    if (listEl) {
      if (!members.length) {
        listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No members found.</span>';
      } else {
        listEl.innerHTML = members.map((m) => `
          <div class="member-row" data-member-user-id="${escapeHtml(m.userId)}">
            <div class="member-main">
              <span class="member-avatar">${escapeHtml((m.name || 'M').charAt(0).toUpperCase())}</span>
              <div>
                <span class="member-name"></span>
                <span class="member-email"></span>
              </div>
            </div>
            <div class="member-actions">
              ${m.role === 'owner'
                ? '<span class="badge badge-sm badge-personal" style="text-transform: capitalize;">Owner</span>'
                : canManage
                  ? `<select class="filter-select member-role-select" data-member-user-id="${escapeHtml(m.userId)}" aria-label="Role for ${escapeHtml(m.name)}">
                      <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
                      <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Editor</option>
                      <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                    </select>
                    <button type="button" class="btn btn-ghost btn-xs" data-member-remove="${escapeHtml(m.userId)}" title="Remove member" style="color: var(--color-red);">×</button>`
                  : `<span class="badge badge-sm" style="background: var(--bg-hover); color: var(--text-secondary); text-transform: capitalize;">${escapeHtml(m.role)}</span>`
              }
            </div>
          </div>
        `).join('');

        // Text via textContent to avoid injection
        listEl.querySelectorAll('.member-row').forEach((row, idx) => {
          const m = members[idx];
          row.querySelector('.member-name').textContent = `${m.name || 'Member'}${m.userId === currentUser?.id ? ' (you)' : ''}`;
          row.querySelector('.member-email').textContent = m.email || '';
        });

        // Role change
        listEl.querySelectorAll('.member-role-select').forEach((select) => {
          select.addEventListener('change', async () => {
            const userId = select.dataset.memberUserId;
            try {
              await api.changeMemberRole(activeWs.id, userId, select.value);
              showToast(`Role updated to ${select.value}`, 'success', 1800);
              await loadWorkspaceMembers();
            } catch (err) {
              showToast(err.message || 'Failed to change role', 'error');
              await loadWorkspaceMembers();
            }
          });
        });

        // Remove member
        listEl.querySelectorAll('[data-member-remove]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const userId = btn.dataset.memberRemove;
            const member = members.find((m) => m.userId === userId);
            showConfirmDialog(
              'Remove Member',
              `Remove ${member?.name || 'this member'} from this workspace? They lose access to its notes immediately.`,
              async () => {
                try {
                  await api.removeWorkspaceMember(activeWs.id, userId);
                  showToast('Member removed', 'success', 2000);
                  await loadWorkspaceMembers();
                } catch (err) {
                  showToast(err.message || 'Failed to remove member', 'error');
                }
              }
            );
          });
        });
      }
    }

    // Pending invitations
    if (invitesEl) {
      const invites = (invitesRes.status === 'fulfilled' && invitesRes.value?.invites) || [];
      const pending = invites.filter((i) => i.status === 'pending' && i.expiresAt > Date.now());
      if (!pending.length) {
        invitesEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No pending invitations.</span>';
      } else {
        invitesEl.innerHTML = pending.map((i) => `
          <div class="invite-row" data-invite-id="${escapeHtml(i.id)}">
            <div class="invite-info">
              <span class="invite-email"></span>
              <span class="invite-meta"></span>
            </div>
            <div class="invite-actions">
              <button type="button" class="btn btn-secondary btn-xs" data-invite-copy-link="${escapeHtml(i.id)}">Copy link</button>
              ${canManage ? `<button type="button" class="btn btn-ghost btn-xs" data-invite-revoke="${escapeHtml(i.id)}" title="Revoke invitation" style="color: var(--color-red);">Revoke</button>` : ''}
            </div>
          </div>
        `).join('');

        invitesEl.querySelectorAll('.invite-row').forEach((row, idx) => {
          const i = pending[idx];
          row.querySelector('.invite-email').textContent = i.email;
          row.querySelector('.invite-meta').textContent = `${i.role} · expires ${new Date(i.expiresAt).toLocaleDateString()}`;
        });

        invitesEl.querySelectorAll('[data-invite-copy-link]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const inviteId = btn.dataset.inviteCopyLink;
            const activeWs2 = state.get('activeWorkspace');
            try {
              // Re-issuing returns the same pending invite; rebuild its shareable URL from this origin
              const inviteRow = pending.find((inv) => inv.id === inviteId);
              if (!inviteRow) return;
              const res = await api.createWorkspaceInvite(activeWs2.id, { email: inviteRow.email, role: inviteRow.role });
              const link = res.invite?.token ? `${window.location.origin}/#invite=${res.invite.token}` : res.inviteUrl;
              await navigator.clipboard.writeText(link);
              showToast('Invitation link copied', 'success', 2000);
            } catch (err) {
              showToast('Could not copy invitation link', 'error');
            }
          });
        });

        invitesEl.querySelectorAll('[data-invite-revoke]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            try {
              await api.revokeWorkspaceInvite(activeWs.id, btn.dataset.inviteRevoke);
              showToast('Invitation revoked', 'info', 2000);
              await loadWorkspaceMembers();
            } catch (err) {
              showToast(err.message || 'Failed to revoke invitation', 'error');
            }
          });
        });
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
    if (invitesEl) invitesEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Invitations unavailable.</span>';
    if (actListEl) actListEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">Activity log unavailable.</span>';
  }
}

/** Open the upgraded Account Settings modal with live identity, sessions and backup data. */
export async function openAccountSettingsModal() {
  const user = state.get('user');
  if (!user) return;

  const nameInput = document.getElementById('profile-name-input');
  const emailInput = document.getElementById('profile-email-input');
  const avatarEl = document.getElementById('profile-avatar-large');
  const nameLargeEl = document.getElementById('profile-name-large');
  const memberSinceEl = document.getElementById('profile-member-since');

  if (nameInput) nameInput.value = user.name || '';
  if (emailInput) emailInput.value = user.email || '';
  if (avatarEl) {
    const initial = (user.name || user.email || 'U').charAt(0).toUpperCase();
    avatarEl.textContent = initial;
    // Deterministic hue from the user id/email so it stays stable per user
    const seed = (user.id || user.email || 'u').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    avatarEl.style.background = `hsl(${seed % 360} 62% 45%)`;
  }
  if (nameLargeEl) nameLargeEl.textContent = user.name || user.email || 'User';
  if (memberSinceEl) {
    memberSinceEl.textContent = user.createdAt
      ? `Member since ${new Date(user.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })}`
      : '';
  }

  openModal('modal-profile');
  void loadSessionsIntoSettings();
  void loadBackupStatusIntoSettings();
}

async function loadSessionsIntoSettings() {
  const listEl = document.getElementById('profile-sessions-list');
  if (!listEl) return;
  try {
    const res = await api.listSessions();
    const sessions = res.sessions || [];
    if (!sessions.length) {
      listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.8rem;">No active sessions found.</span>';
      return;
    }
    listEl.innerHTML = sessions.map((s, idx) => `
      <div class="profile-session-item" data-session-idx="${idx}">
        <span class="session-meta"></span>
        ${s.current ? '<span class="badge badge-sm badge-personal">This device</span>' : '<span class="badge badge-sm" style="background: var(--bg-hover); color: var(--text-secondary);">Other device</span>'}
        ${s.current ? '' : '<button type="button" class="btn btn-ghost btn-xs" data-revoke-session="${escapeHtml(s.id)}" title="Sign out this device" style="color: var(--color-red);">Sign out</button>'}
      </div>
    `).join('');
    listEl.querySelectorAll('.profile-session-item').forEach((row, idx) => {
      const s = sessions[idx];
      const when = new Date(s.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const agent = (s.userAgent || 'unknown device').slice(0, 42);
      row.querySelector('.session-meta').textContent = `${s.current ? 'Current session' : 'Session'} · ${s.ipAddress || 'unknown IP'} · ${agent} · ${when}`;
    });
    // Audit L-8: revoke one other device without nuking every session.
    listEl.querySelectorAll('[data-revoke-session]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api.revokeSession(btn.getAttribute('data-revoke-session'));
          showToast('Device signed out', 'success');
          await loadSessionsIntoSettings();
        } catch (err) {
          btn.disabled = false;
          showToast(err.message || 'Could not sign out that device', 'error');
        }
      });
    });
  } catch (err) {
    listEl.innerHTML = '<span style="color: var(--text-muted); font-size: 0.8rem;">Session info unavailable.</span>';
  }
}

async function loadBackupStatusIntoSettings() {
  const el = document.getElementById('profile-backup-status');
  if (!el) return;
  try {
    const status = await api.getBackupStatus();
    const parts = [];
    if (status.lastBackupAt) {
      parts.push(`<span class="backup-ok">✓ Last local snapshot: ${new Date(status.lastBackupAt).toLocaleString()} (${status.localSnapshots} kept)</span>`);
    } else {
      parts.push('<span class="backup-warn">⚠ No local snapshot has been created yet.</span>');
    }
    if (status.replicationConfigured) {
      if (status.lastReplicatedAt) {
        parts.push(`<span class="backup-ok">✓ Off-host replication active: ${status.replicationSnapshots} snapshot(s) in ${escapeHtml(status.replicationDirectory)}</span>`);
      } else {
        parts.push(`<span class="backup-warn">⚠ Off-host replication is configured (${escapeHtml(status.replicationDirectory)}) but has not completed yet.</span>`);
      }
    } else {
      parts.push('<span class="backup-warn">⚠ Off-host replication is NOT configured. Set BACKUP_REPLICATION_DIR to a location outside the data volume to survive volume/host loss.</span>');
    }
    el.innerHTML = parts.join('');
  } catch (err) {
    // SEC-03: backup telemetry is restricted to instance administrators.
    if (err?.status === 403) {
      el.innerHTML = '<span style="color: var(--text-muted); font-size: 0.8rem;">Backup snapshots are managed by your instance administrator.</span>';
      return;
    }
    el.innerHTML = '<span style="color: var(--text-muted); font-size: 0.8rem;">Backup status unavailable.</span>';
  }
}
