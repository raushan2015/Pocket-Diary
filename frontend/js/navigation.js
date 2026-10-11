/**
 * SPA View Navigation & Routing Controller
 * Handles view switching between landing, auth, dashboard, and editor views.
 */

import { state } from './state.js';
import { showToast } from './utils.js';
import { setAuthMode } from './auth.js';
import { refreshWorkspaceMemos } from './workspace-data.js';
import {
  loadMemoIntoEditor,
  syncMobileMetadataFromDesktop,
  setupEditorEnhancements,
  flushEditorAutosave,
  editorHasUnsavedChanges
} from './editor.js';

export async function navigateTo(viewName, params = {}) {
  const previousView = state.get('currentView');
  if (state.get('currentView') === 'editor' && viewName !== 'editor') {
    const activeMemo = state.get('activeMemo');
    if (activeMemo?.id && editorHasUnsavedChanges) {
      try {
        await flushEditorAutosave();
      } catch {
        showToast('Your changes could not be saved. Stay here and retry before leaving.', 'error', 5000);
        return;
      }
      if (editorHasUnsavedChanges) {
        showToast('Changes are still waiting to save. Please retry.', 'error', 4000);
        return;
      }
    } else if (!activeMemo?.id) {
      const hasDraft = !!document.getElementById('editor-title-input')?.value.trim()
        || !!document.getElementById('editor-body-textarea')?.value.trim();
      if (hasDraft) {
        showToast('Saving your new note before leaving…', 'info', 1500);
        try {
          await flushEditorAutosave();
        } catch {
          showToast('Your new note could not be saved. Stay here and retry.', 'error', 5000);
          return;
        }
        if (editorHasUnsavedChanges) return;
      }
    }
  }

  const views = ['landing', 'auth', 'dashboard', 'editor'];
  if (!views.includes(viewName)) return;

  views.forEach((v) => {
    const el = document.getElementById(`view-${v}`);
    if (el) {
      el.classList.toggle('active', v === viewName);
    }
  });

  state.set('currentView', viewName);

  // Navbar layout adjustment
  const navLandingLinks = document.getElementById('nav-landing-links');
  const navSearch = document.getElementById('navbar-search-container');

  if (viewName === 'landing') {
    if (navLandingLinks) navLandingLinks.style.display = 'flex';
    if (navSearch) navSearch.style.display = 'none';
  } else if (viewName === 'dashboard') {
    if (navLandingLinks) navLandingLinks.style.display = 'none';
    if (navSearch) navSearch.style.display = 'block';
    refreshWorkspaceMemos();
  } else {
    if (navLandingLinks) navLandingLinks.style.display = 'none';
    if (navSearch) navSearch.style.display = 'none';
  }

  if (viewName === 'auth') {
    const mode = params.mode || state.get('authMode') || 'login';
    setAuthMode(mode);
  }

  if (viewName === 'editor') {
    if (params.memo) {
      loadMemoIntoEditor(params.memo);
      syncMobileMetadataFromDesktop();
    }
    setupEditorEnhancements();
    if (previousView !== 'editor' && window.matchMedia('(max-width: 900px)').matches) {
      try { window.history.pushState({ memoManagerEditor: true }, '', '#editor'); } catch {}
    }
  }

  updateMobileNavState(viewName);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function updateMobileNavState(viewName) {
  const tabs = {
    landing: 'mob-nav-home',
    dashboard: 'mob-nav-home',
    editor: 'mob-nav-create',
  };

  document.querySelectorAll('.mobile-bottom-nav .mobile-nav-item').forEach((btn) => {
    btn.classList.remove('active');
  });

  const activeTabId = tabs[viewName];
  if (activeTabId) {
    const tabEl = document.getElementById(activeTabId);
    if (tabEl) tabEl.classList.add('active');
  }
}
