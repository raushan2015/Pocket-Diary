/**
 * Notes SaaS - Main Application Bootstrap & Controller
 * Modular architecture wiring together Keep quick-capture, modals, popovers, canvas, dnd, and document editor.
 */

import { state } from './state.js';
import { initTheme } from './utils.js';
import { initMigrationModal } from './migration.js';
import { currentCalYear, currentCalMonth, renderInteractiveCalendar } from './calendar.js';
import { detectSession } from './auth.js';
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
      if (greetingTitle) greetingTitle.textContent = `Good Morning, ${name}! ☀️`;
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
// Application Bootstrap
// ==========================================================================
async function initApp() {
  initTheme();
  bindStateToUI();
  setupEventListeners();
  setupSearchInput();
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

  // Register PWA Service Worker for offline capability
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.debug('ServiceWorker registration skipped:', err);
      });
    });
  }

  console.log('Notes - Google Keep Alternative Web App initialized successfully.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
