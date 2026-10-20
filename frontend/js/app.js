/**
 * Pocket Diary SaaS - Main Application Bootstrap & Controller
 * Modular architecture wiring together Keep quick-capture, modals, popovers, canvas, dnd, and document editor.
 */

import { state } from './state.js';
import { initTheme, showToast } from './utils.js';
import { initMigrationModal } from './migration.js';
import { currentCalYear, currentCalMonth, renderInteractiveCalendar } from './calendar.js';
import {
  detectSession,
  consumeInviteFromUrl,
  loadInviteContext,
  setupAuthFormEnhancements,
  handleIncomingResetToken,
} from './auth.js';
import { api } from './api.js';
import { refreshWorkspaceMemos } from './workspace-data.js';
import { setupSearchInput, setFilter, filterAndRenderMemos } from './search-filter.js';
import { renderWorkspacesList } from './sidebar.js';
import { setupEventListeners } from './app-events.js';
import { navigateTo } from './navigation.js';

// Re-export key orchestrators for module consumers and backward compatibility
export { navigateTo } from './navigation.js';
export { setFilter, filterAndRenderMemos } from './search-filter.js';
export { refreshWorkspaceMemos } from './workspace-data.js';

// ==========================================================================
// UI & State Binding Sync
// ==========================================================================
function bindStateToUI() {
  state.on('isAuthenticated', (isAuth) => {
    const unauthGroup = document.getElementById('nav-unauth-actions');
    const authGroup = document.getElementById('nav-auth-actions');

    if (isAuth) {
      if (unauthGroup) unauthGroup.style.display = 'none';
      if (authGroup) authGroup.style.display = 'flex';
    } else {
      if (unauthGroup) unauthGroup.style.display = 'flex';
      if (authGroup) authGroup.style.display = 'none';
    }
  });

  state.on('user', (user) => {
    if (user) {
      const name = user.name || 'User';
      const initial = name.charAt(0).toUpperCase();

      const avatarCircle = document.getElementById('user-avatar-circle');
      const menuName = document.getElementById('user-menu-name');
      const fullnameEl = document.getElementById('dropdown-user-fullname');
      const emailEl = document.getElementById('dropdown-user-email');
      const greetingTitle = document.getElementById('dashboard-greeting-title');

      if (avatarCircle) avatarCircle.textContent = initial;
      if (menuName) menuName.textContent = name;
      if (fullnameEl) fullnameEl.textContent = user.name;
      if (emailEl) emailEl.textContent = user.email;
      if (greetingTitle) {
        const hour = new Date().getHours();
        let greeting = 'Good Morning';
        let emoji = '☀️';
        if (hour < 5) { greeting = 'Good Night'; emoji = '🌙'; }
        else if (hour < 12) { greeting = 'Good Morning'; emoji = '☀️'; }
        else if (hour < 17) { greeting = 'Good Afternoon'; emoji = '🌤️'; }
        else if (hour < 21) { greeting = 'Good Evening'; emoji = '🌆'; }
        else { greeting = 'Good Night'; emoji = '🌙'; }
        greetingTitle.textContent = `${greeting}, ${name}! ${emoji}`;
      }
    }
  });

  state.on('workspaces', (workspaces) => {
    renderWorkspacesList(workspaces);
  });

  state.on('kpis', (kpis) => {
    const kpiTotal = document.getElementById('kpi-total');
    const kpiFav = document.getElementById('kpi-favorites');
    const kpiPending = document.getElementById('kpi-pending');
    const kpiCompleted = document.getElementById('kpi-completed');

    if (kpiTotal) kpiTotal.textContent = kpis.total || 0;
    if (kpiFav) kpiFav.textContent = kpis.favorites || 0;
    if (kpiPending) kpiPending.textContent = kpis.pending || 0;
    if (kpiCompleted) kpiCompleted.textContent = kpis.completed || 0;
  });
}

// ==========================================================================
// Workspace invitation link flow (#invite=<token>)
// ==========================================================================
async function handleIncomingInvite() {
  const token = consumeInviteFromUrl();
  if (!token) return false;

  // Already signed in? Accept the invitation right away.
  if (state.get('isAuthenticated')) {
    try {
      const res = await api.acceptInvite(token);
      const meData = await api.getMe().catch(() => null);
      if (meData?.workspaces) state.set('workspaces', meData.workspaces);
      showToast(`You joined “${res.workspace.name}” as ${res.workspace.role}`, 'success', 4000);
      await refreshWorkspaceMemos();
      navigateTo('dashboard');
    } catch (err) {
      showToast(err.message || 'This invitation could not be accepted', 'warning', 4500);
    }
    return true;
  }

  // Signed out: show the invitation banner on the auth screen and prefill.
  await loadInviteContext(token);
  return true;
}

// ==========================================================================
// Application Bootstrap
// ==========================================================================
async function initApp() {
  initTheme();
  bindStateToUI();
  setupEventListeners();
  setupSearchInput();
  setupAuthFormEnhancements();
  initMigrationModal({ onRefresh: refreshWorkspaceMemos });

  renderInteractiveCalendar(currentCalYear, currentCalMonth, (range) => {
    setFilter('dueDate', range);
    document.getElementById('memos-view-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  const viewMode = state.get('viewMode') || 'grid';
  if (viewMode === 'grid') {
    document.getElementById('view-mode-grid-btn')?.classList.add('active');
    document.getElementById('view-mode-list-btn')?.classList.remove('active');
  } else {
    document.getElementById('view-mode-list-btn')?.classList.add('active');
    document.getElementById('view-mode-grid-btn')?.classList.remove('active');
  }

  await detectSession();

  // Handle a password recovery link (#reset=<token>) — presents the new
  // password form. Checked before invites since the two link types are
  // mutually exclusive.
  const handledReset = await handleIncomingResetToken();

  // Handle a workspace invitation link (#invite=<token>) for both signed-in
  // and signed-out visitors. detectSession runs first so signed-in users can
  // join immediately; signed-out users get the prefilled register screen.
  if (!handledReset) {
    await handleIncomingInvite();
  }

  // Register PWA Service Worker for offline capability + Web Push
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.debug('ServiceWorker registration skipped:', err);
      });
    });
  }

  console.log('Pocket Diary Web App initialized successfully.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
