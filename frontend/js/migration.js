/**
 * Local Data Migration & Backup Controller
 * Import legacy localStorage data, JSON files, and export workspace backups
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast, openModal, closeModal } from './utils.js';

let detectedMigrationPayload = null;
let parsedMigrationPayload = null;
let onRefreshWorkspaceCallback = null;

export function initMigrationModal(callbacks = {}) {
  onRefreshWorkspaceCallback = callbacks.onRefresh;

  const openBtn = document.getElementById('sidebar-migration-btn');
  const closeBtn = document.getElementById('modal-migration-close-btn');
  const cancelBtn = document.getElementById('modal-migration-cancel-btn');
  const tabImportBtn = document.getElementById('mig-tab-import-btn');
  const tabExportBtn = document.getElementById('mig-tab-export-btn');
  const tabImportContent = document.getElementById('mig-tab-import-content');
  const tabExportContent = document.getElementById('mig-tab-export-content');
  const modalFooter = document.getElementById('migration-modal-footer');
  const importDetectedBtn = document.getElementById('mig-import-detected-btn');
  const importSubmitBtn = document.getElementById('modal-migration-import-btn');
  const dropzone = document.getElementById('migration-dropzone');
  const fileInput = document.getElementById('migration-file-input');
  const browseBtn = document.getElementById('mig-browse-file-btn');
  const jsonTextarea = document.getElementById('mig-json-textarea');
  const clearJsonBtn = document.getElementById('mig-clear-json-btn');
  const downloadExportBtn = document.getElementById('migration-export-download-btn');

  openBtn?.addEventListener('click', () => {
    checkLocalStorageForLegacyData();
    openModal('modal-migration');
  });

  closeBtn?.addEventListener('click', () => closeModal('modal-migration'));
  cancelBtn?.addEventListener('click', () => closeModal('modal-migration'));

  tabImportBtn?.addEventListener('click', () => {
    tabImportBtn.classList.add('active');
    tabExportBtn?.classList.remove('active');
    if (tabImportContent) tabImportContent.style.display = 'block';
    if (tabExportContent) tabExportContent.style.display = 'none';
    if (modalFooter) modalFooter.style.display = 'flex';
  });

  tabExportBtn?.addEventListener('click', () => {
    tabExportBtn.classList.add('active');
    tabImportBtn?.classList.remove('active');
    if (tabImportContent) tabImportContent.style.display = 'none';
    if (tabExportContent) tabExportContent.style.display = 'block';
    if (modalFooter) modalFooter.style.display = 'none';
  });

  // LocalStorage Detection
  importDetectedBtn?.addEventListener('click', async () => {
    if (!detectedMigrationPayload) return;
    await executeMigrationImport(detectedMigrationPayload);
  });

  // Drag and Drop
  dropzone?.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone?.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone?.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files?.[0];
    if (file) handleJsonFile(file);
  });

  browseBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) handleJsonFile(file);
  });

  // Textarea input parsing
  jsonTextarea?.addEventListener('input', (e) => {
    const text = e.target.value.trim();
    if (!text) {
      updateMigrationPreview(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      updateMigrationPreview(parsed);
    } catch {
      updateMigrationPreview(null);
    }
  });

  clearJsonBtn?.addEventListener('click', () => {
    if (jsonTextarea) jsonTextarea.value = '';
    updateMigrationPreview(null);
  });

  // Submit button
  importSubmitBtn?.addEventListener('click', async () => {
    if (!parsedMigrationPayload) return;
    await executeMigrationImport(parsedMigrationPayload);
  });

  // Export button
  downloadExportBtn?.addEventListener('click', async () => {
    const activeWs = state.get('activeWorkspace');
    if (!activeWs || !activeWs.id) {
      showToast('Select a workspace to export', 'error');
      return;
    }

    try {
      showToast('Generating workspace backup...', 'info', 1500);
      const data = await api.exportWorkspace(activeWs.id);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `notes-backup-${(activeWs.name || 'workspace').toLowerCase()}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Backup downloaded successfully', 'success', 3000);
    } catch (err) {
      console.error('Export error:', err);
      showToast('Failed to export workspace backup', 'error');
    }
  });
}

export function checkLocalStorageForLegacyData() {
  const card = document.getElementById('migration-detected-card');
  const title = document.getElementById('mig-detected-title');
  const desc = document.getElementById('mig-detected-desc');
  const importBtn = document.getElementById('mig-import-detected-btn');
  if (!card) return;

  const candidateKeys = ['memos', 'memo_items', 'memo_manager_memos', 'legacy_memos', 'notes'];
  let foundMemos = [];

  for (const key of candidateKeys) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          foundMemos = parsed;
          break;
        } else if (parsed && Array.isArray(parsed.memos) && parsed.memos.length > 0) {
          foundMemos = parsed.memos;
          break;
        }
      }
    } catch {}
  }

  if (foundMemos.length > 0) {
    detectedMigrationPayload = { memos: foundMemos };
    card.style.display = 'block';
    if (title) title.textContent = `Found ${foundMemos.length} local notes in this browser!`;
    if (desc) desc.textContent = 'Migrate your notes into your cloud account to sync across devices.';
    if (importBtn) importBtn.style.display = 'inline-block';
  } else {
    detectedMigrationPayload = null;
    card.style.display = 'none';
  }
}

export function handleJsonFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const jsonTextarea = document.getElementById('mig-json-textarea');
      if (jsonTextarea) jsonTextarea.value = JSON.stringify(parsed, null, 2);
      updateMigrationPreview(parsed);
      showToast(`Loaded ${file.name}`, 'info', 2000);
    } catch {
      showToast('Invalid JSON file format', 'error');
      updateMigrationPreview(null);
    }
  };
  reader.readAsText(file);
}

export function updateMigrationPreview(payload) {
  const previewBox = document.getElementById('migration-preview-container');
  const statMemos = document.getElementById('mig-stat-memos');
  const statCats = document.getElementById('mig-stat-categories');
  const statTags = document.getElementById('mig-stat-tags');
  const submitBtn = document.getElementById('modal-migration-import-btn');

  if (!payload) {
    parsedMigrationPayload = null;
    if (previewBox) previewBox.style.display = 'none';
    if (submitBtn) submitBtn.disabled = true;
    return;
  }

  let memos = [];
  let categories = [];
  let tags = [];

  if (Array.isArray(payload)) {
    memos = payload;
  } else if (typeof payload === 'object') {
    memos = payload.memos || [];
    categories = payload.categories || [];
    tags = payload.tags || [];
  }

  parsedMigrationPayload = { memos, categories, tags };

  if (statMemos) statMemos.textContent = memos.length;
  if (statCats) statCats.textContent = categories.length;
  if (statTags) statTags.textContent = tags.length;

  if (previewBox) previewBox.style.display = 'block';
  if (submitBtn) submitBtn.disabled = memos.length === 0;
}

export async function executeMigrationImport(payload) {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs || !activeWs.id) {
    showToast('Select an active workspace to import into', 'error');
    return;
  }

  const importBtn = document.getElementById('modal-migration-import-btn');
  const alertEl = document.getElementById('migration-alert');
  if (importBtn) importBtn.disabled = true;

  try {
    const importPayload = {
      workspaceId: activeWs.id,
      memos: payload.memos || [],
      categories: payload.categories || [],
      tags: payload.tags || [],
    };

    const res = await api.importLocal(importPayload);

    if (alertEl) {
      alertEl.className = 'auth-alert success active';
      alertEl.textContent = `Success! Imported ${res.importedMemos} memos, ${res.importedCategories} categories, and ${res.importedTags} tags.`;
    }

    showToast(`Successfully imported ${res.importedMemos} memos`, 'success', 3000);
    if (typeof onRefreshWorkspaceCallback === 'function') {
      await onRefreshWorkspaceCallback();
    }

    setTimeout(() => {
      closeModal('modal-migration');
      if (alertEl) alertEl.className = 'auth-alert';
    }, 1500);
  } catch (err) {
    console.error('Migration import error:', err);
    if (alertEl) {
      alertEl.className = 'auth-alert error active';
      alertEl.textContent = err.message || 'Migration import failed.';
    }
    showToast('Migration import failed', 'error');
  } finally {
    if (importBtn) importBtn.disabled = false;
  }
}
