/**
 * Google Keep Global Keyboard Shortcuts Controller
 * Matches Google Keep keyboard interaction model:
 * 'c' = Take note, '/' = Search, 'Esc' = Close, 'e' = Archive, '#' = Delete
 */

import { clearSelection, getSelectedIds } from './keep-selection.js';
import { activeKeepModalMemo, closeKeepNoteModal } from './keep-modal.js';
import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';

export function setupKeepKeyboardShortcuts(callbacks = {}) {
  window.addEventListener('keydown', async (e) => {
    // Ignore inside inputs, textareas, contenteditables
    const targetTag = e.target.tagName;
    const isEditing = targetTag === 'INPUT' || targetTag === 'TEXTAREA' || e.target.isContentEditable;

    if (e.key === 'Escape') {
      if (document.querySelector('.modal-backdrop.active')) {
        // Modal handles its own escape
        return;
      }
      if (getSelectedIds().length > 0) {
        clearSelection();
        return;
      }
      return;
    }

    if (isEditing) return;

    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      const collapsed = document.getElementById('quick-capture-collapsed');
      const form = document.getElementById('quick-capture-form');
      const textarea = document.getElementById('quick-capture-content');
      if (collapsed && form) {
        collapsed.style.display = 'none';
        form.style.display = 'block';
        textarea?.focus();
      }
      return;
    }

    if (e.key === '/') {
      e.preventDefault();
      const searchInput = document.getElementById('global-search-input') || document.querySelector('.navbar-search-input');
      searchInput?.focus();
      searchInput?.select();
      return;
    }

    if (e.key === 'e') {
      // Archive active modal note or selected notes
      if (activeKeepModalMemo) {
        e.preventDefault();
        const newArchived = !activeKeepModalMemo.isArchived;
        activeKeepModalMemo.isArchived = newArchived;
        await api.updateMemo(activeKeepModalMemo.id, { isArchived: newArchived, version: activeKeepModalMemo.version });
        activeKeepModalMemo.version = (activeKeepModalMemo.version || 1) + 1;
        showToast(newArchived ? 'Note archived' : 'Note unarchived', 'info', 1800);
        closeKeepNoteModal();
        if (typeof callbacks.onRefresh === 'function') callbacks.onRefresh();
      }
      return;
    }

    if (e.key === '#') {
      // Delete active modal note
      if (activeKeepModalMemo) {
        e.preventDefault();
        const id = activeKeepModalMemo.id;
        try {
          await api.deleteMemo(id, false);
          showToast('Note moved to Trash', 'info', 1800);
          closeKeepNoteModal();
          if (typeof callbacks.onRefresh === 'function') callbacks.onRefresh();
        } catch {
          showToast('Failed to delete note', 'error');
        }
      }
      return;
    }
  });
}
