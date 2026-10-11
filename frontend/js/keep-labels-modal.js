/**
 * Google Keep "Edit labels" Dialog Controller
 * Manages workspace labels (tags): create, inline rename, delete, and sidebar sync
 */

import { api } from './api.js';
import { state } from './state.js';
import { openModal, closeModal, showToast, escapeHtml } from './utils.js';

let onLabelsChangedCallback = null;

export function setupKeepLabelsModal(callbacks = {}) {
  onLabelsChangedCallback = callbacks.onChanged;

  const modal = document.getElementById('modal-keep-labels');
  const closeBtn = document.getElementById('keep-labels-close-btn');
  const doneBtn = document.getElementById('keep-labels-done-btn');
  const createInput = document.getElementById('keep-labels-new-input');
  const createBtn = document.getElementById('keep-labels-create-btn');

  if (!modal) return;

  const closeDialog = () => {
    closeModal('modal-keep-labels');
    if (createInput) createInput.value = '';
    if (typeof onLabelsChangedCallback === 'function') onLabelsChangedCallback();
  };

  closeBtn?.addEventListener('click', closeDialog);
  doneBtn?.addEventListener('click', closeDialog);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });

  const handleCreateLabel = async () => {
    const name = createInput?.value.trim().replace(/^#/, '');
    if (!name) return;
    const activeWs = state.get('activeWorkspace');
    if (!activeWs?.id) {
      showToast('Select a workspace first', 'error');
      return;
    }

    try {
      await api.createTag({ workspaceId: activeWs.id, name });
      createInput.value = '';
      showToast(`Label "${name}" created`, 'success', 1500);
      await refreshLabelsList();
      if (typeof onLabelsChangedCallback === 'function') onLabelsChangedCallback();
    } catch (err) {
      showToast(err.message || 'Failed to create label', 'error');
    }
  };

  createBtn?.addEventListener('click', handleCreateLabel);
  createInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCreateLabel();
    }
  });
}

export async function openKeepLabelsModal() {
  await refreshLabelsList();
  openModal('modal-keep-labels');
  document.getElementById('keep-labels-new-input')?.focus();
}

export async function refreshLabelsList() {
  const container = document.getElementById('keep-labels-list');
  if (!container) return;

  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id) return;

  let tags = [];
  try {
    const res = await api.listTags(activeWs.id);
    tags = res.tags || [];
    state.set('tags', tags);
  } catch {
    tags = state.get('tags') || [];
  }

  if (tags.length === 0) {
    container.innerHTML = '<div style="font-size:0.875rem; color:var(--text-muted); padding:1rem 0; text-align:center;">No labels created yet.</div>';
    return;
  }

  container.innerHTML = tags.map((t) => `
    <div class="keep-label-row" data-tag-id="${t.id}" data-tag-name="${escapeHtml(t.name)}">
      <button type="button" class="keep-label-btn-icon keep-label-trash-btn" title="Delete label" aria-label="Delete label">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
      <input type="text" class="keep-label-input" value="${escapeHtml(t.name)}" aria-label="Label name">
      <button type="button" class="keep-label-btn-icon keep-label-save-btn" title="Save rename" aria-label="Save label">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </button>
    </div>
  `).join('');

  container.querySelectorAll('.keep-label-row').forEach((row) => {
    const id = row.dataset.tagId;
    const oldName = row.dataset.tagName;
    const input = row.querySelector('.keep-label-input');
    const saveBtn = row.querySelector('.keep-label-save-btn');
    const trashBtn = row.querySelector('.keep-label-trash-btn');

    const saveRename = async () => {
      const newName = input.value.trim().replace(/^#/, '');
      if (!newName || newName === oldName) {
        input.value = oldName;
        return;
      }
      try {
        await api.updateTag(id, { name: newName });
        row.dataset.tagName = newName;
        showToast('Label renamed', 'success', 1500);
        if (typeof onLabelsChangedCallback === 'function') onLabelsChangedCallback();
      } catch (err) {
        showToast(err.message || 'Failed to rename label', 'error');
        input.value = oldName;
      }
    };

    saveBtn?.addEventListener('click', saveRename);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveRename();
      }
    });

    trashBtn?.addEventListener('click', async () => {
      try {
        await api.deleteTag(id, activeWs.id);
        row.remove();
        showToast(`Label "${oldName}" deleted`, 'info', 1800);
        if (typeof onLabelsChangedCallback === 'function') onLabelsChangedCallback();
      } catch (err) {
        showToast(err.message || 'Failed to delete label', 'error');
      }
    });
  });
}
