/**
 * Google Keep Card Multi-Select & Bulk Actions Bar Controller
 * Select multiple notes to bulk pin, change color, archive, or delete
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast, showConfirmDialog } from './utils.js';
import { openPalettePopover } from './keep-popovers.js';

let selectedMemoIds = new Set();
let onBulkActionDoneCallback = null;

export function setupKeepSelection(callbacks = {}) {
  onBulkActionDoneCallback = callbacks.onDone;

  const bulkBar = document.getElementById('keep-bulk-bar');
  const clearBtn = document.getElementById('keep-bulk-clear-btn');
  const pinBtn = document.getElementById('keep-bulk-pin-btn');
  const colorBtn = document.getElementById('keep-bulk-color-btn');
  const archiveBtn = document.getElementById('keep-bulk-archive-btn');
  const trashBtn = document.getElementById('keep-bulk-trash-btn');

  if (!bulkBar) return;

  clearBtn?.addEventListener('click', () => {
    clearSelection();
  });

  pinBtn?.addEventListener('click', async () => {
    const ids = Array.from(selectedMemoIds);
    if (!ids.length) return;
    const allMemos = state.get('allWorkspaceMemos') || [];
    const memosToUpdate = allMemos.filter((m) => ids.includes(m.id));
    const anyUnpinned = memosToUpdate.some((m) => !m.isPinned);
    const newPinned = anyUnpinned;

    for (const memo of memosToUpdate) {
      try {
        await api.updateMemo(memo.id, { isPinned: newPinned, version: memo.version });
        memo.isPinned = newPinned;
        memo.version = (memo.version || 1) + 1;
      } catch (err) {
        console.error('Bulk pin error:', err);
      }
    }

    showToast(newPinned ? `${ids.length} notes pinned` : `${ids.length} notes unpinned`, 'info', 1800);
    clearSelection();
    if (typeof onBulkActionDoneCallback === 'function') onBulkActionDoneCallback();
  });

  colorBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const ids = Array.from(selectedMemoIds);
    if (!ids.length) return;
    const allMemos = state.get('allWorkspaceMemos') || [];
    const firstMemo = allMemos.find((m) => ids.includes(m.id));

    openPalettePopover(colorBtn, firstMemo || { id: null }, async (color, type) => {
      if (type !== 'color') return;
      for (const id of ids) {
        const memo = allMemos.find((m) => m.id === id);
        if (!memo) continue;
        try {
          await api.updateMemo(memo.id, { color, version: memo.version });
          memo.color = color;
          memo.version = (memo.version || 1) + 1;
        } catch (err) {
          console.error('Bulk color error:', err);
        }
      }
      showToast(`Color applied to ${ids.length} notes`, 'success', 1800);
      clearSelection();
      if (typeof onBulkActionDoneCallback === 'function') onBulkActionDoneCallback();
    });
  });

  archiveBtn?.addEventListener('click', async () => {
    const ids = Array.from(selectedMemoIds);
    if (!ids.length) return;
    const allMemos = state.get('allWorkspaceMemos') || [];
    const memosToUpdate = allMemos.filter((m) => ids.includes(m.id));
    const anyUnarchived = memosToUpdate.some((m) => !m.isArchived);
    const newArchived = anyUnarchived;

    for (const memo of memosToUpdate) {
      try {
        await api.updateMemo(memo.id, { isArchived: newArchived, version: memo.version });
        memo.isArchived = newArchived;
        memo.version = (memo.version || 1) + 1;
      } catch (err) {
        console.error('Bulk archive error:', err);
      }
    }

    showToast(newArchived ? `${ids.length} notes archived` : `${ids.length} notes unarchived`, 'info', 1800);
    clearSelection();
    if (typeof onBulkActionDoneCallback === 'function') onBulkActionDoneCallback();
  });

  trashBtn?.addEventListener('click', () => {
    const ids = Array.from(selectedMemoIds);
    if (!ids.length) return;

    showConfirmDialog(
      'Move Notes to Trash',
      `Move ${ids.length} selected note${ids.length === 1 ? '' : 's'} to trash?`,
      async () => {
        for (const id of ids) {
          try {
            await api.deleteMemo(id, false);
          } catch (err) {
            console.error('Bulk delete error:', err);
          }
        }
        showToast(`${ids.length} notes moved to Trash`, 'info', 2000);
        clearSelection();
        if (typeof onBulkActionDoneCallback === 'function') onBulkActionDoneCallback();
      }
    );
  });
}

export function isMemoSelected(memoId) {
  return selectedMemoIds.has(memoId);
}

export function toggleSelectMemo(memoId) {
  if (selectedMemoIds.has(memoId)) {
    selectedMemoIds.delete(memoId);
  } else {
    selectedMemoIds.add(memoId);
  }
  updateSelectionUi();
}

export function clearSelection() {
  selectedMemoIds.clear();
  updateSelectionUi();
}

export function getSelectedIds() {
  return Array.from(selectedMemoIds);
}

export function updateSelectionUi() {
  const bulkBar = document.getElementById('keep-bulk-bar');
  const countEl = document.getElementById('keep-bulk-count');
  const count = selectedMemoIds.size;

  if (bulkBar) {
    bulkBar.style.display = count > 0 ? 'flex' : 'none';
  }
  if (countEl) {
    countEl.textContent = `${count} selected`;
  }

  // Update selection class on cards in DOM
  document.querySelectorAll('.memo-card[data-memo-id]').forEach((card) => {
    const id = card.getAttribute('data-memo-id');
    const isSelected = selectedMemoIds.has(id);
    card.classList.toggle('is-selected', isSelected);
    const chk = card.querySelector('.keep-card-select-btn');
    if (chk) {
      chk.classList.toggle('active', isSelected);
      chk.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    }
  });
}
