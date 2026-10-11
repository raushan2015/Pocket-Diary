/**
 * Document Editor Controller (System Design §4.4)
 * Markdown editing, live preview, formatting toolbar, version history, attachments, whiteboard, and autosave
 */

import { api } from './api.js';
import { state } from './state.js';
import { renderMarkdown, toggleChecklistItem, escapeHtml } from './markdown.js';
import { showToast, openModal, closeModal } from './utils.js';

let editorAutosaveTimer = null;
let editorSaveInFlight = null;
export let editorHasUnsavedChanges = false;
let editorIsHydrating = false;
let editorLastSavedSnapshot = '';
let whiteboardStrokes = [];
let whiteboardActiveStroke = null;
let onRefreshWorkspaceCallback = null;

export function setEditorRefreshCallback(cb) {
  onRefreshWorkspaceCallback = cb;
}

export function editorSnapshot() {
  const memo = state.get('activeMemo') || {};
  const get = (id) => document.getElementById(id);
  const isMobile = window.matchMedia('(max-width: 900px)').matches;
  const value = (desktopId, mobileId) => get(isMobile ? mobileId : desktopId)?.value;
  const date = value('memo-due-date-input', 'mobile-memo-due-date-input') || '';
  return JSON.stringify({
    id: memo.id || null, version: memo.version || 0,
    title: get('editor-title-input')?.value.trim() || 'Untitled Memo',
    content: get('editor-body-textarea')?.value || '',
    categoryId: value('memo-category-select', 'mobile-memo-category-select') || null,
    folderId: value('memo-folder-select', 'mobile-memo-folder-select') || null,
    priority: value('memo-priority-select', 'mobile-memo-priority-select') || 'medium',
    status: value('memo-status-select', 'mobile-memo-status-select') || 'pending',
    dueDate: date ? new Date(date).getTime() : null,
    tags: memo.tags || [], isFavorite: !!memo.isFavorite, isPinned: !!memo.isPinned,
  });
}

export function setEditorSaveState(message, kind = '') {
  const indicator = document.getElementById('editor-save-indicator');
  if (indicator) { indicator.textContent = message; indicator.dataset.saveState = kind; }
}

export function scheduleEditorAutosave(immediate = false) {
  if (editorIsHydrating || state.get('currentView') !== 'editor') return;
  const snapshot = editorSnapshot();
  if (snapshot === editorLastSavedSnapshot && state.get('activeMemo')?.id) {
    editorHasUnsavedChanges = false;
    setEditorSaveState(`Saved (v${state.get('activeMemo')?.version || 1})`, 'saved');
    clearTimeout(editorAutosaveTimer);
    return;
  }
  editorHasUnsavedChanges = true;
  setEditorSaveState('Saving changes…', 'dirty');
  clearTimeout(editorAutosaveTimer);
  editorAutosaveTimer = setTimeout(() => void saveActiveMemo({ quiet: true }), immediate ? 0 : 450);
}

export async function flushEditorAutosave() {
  clearTimeout(editorAutosaveTimer);
  if (state.get('currentView') !== 'editor') return;
  const memo = state.get('activeMemo') || {};
  const hasDraft = !!document.getElementById('editor-title-input')?.value.trim()
    || !!document.getElementById('editor-body-textarea')?.value.trim();
  if (hasDraft || memo.id) {
    if (editorSnapshot() !== editorLastSavedSnapshot) editorHasUnsavedChanges = true;
    if (editorHasUnsavedChanges) await saveActiveMemo({ quiet: true });
  }
  if (editorSaveInFlight) await editorSaveInFlight;
}

export function syncMobileMetadataFromDesktop() {
  const pairs = [
    ['memo-folder-select', 'mobile-memo-folder-select'],
    ['memo-category-select', 'mobile-memo-category-select'],
    ['memo-priority-select', 'mobile-memo-priority-select'],
    ['memo-status-select', 'mobile-memo-status-select'],
    ['memo-due-date-input', 'mobile-memo-due-date-input'],
  ];
  for (const [desktopId, mobileId] of pairs) {
    const desktop = document.getElementById(desktopId);
    const mobile = document.getElementById(mobileId);
    if (!desktop || !mobile) continue;
    mobile.innerHTML = desktop.tagName === 'SELECT' ? desktop.innerHTML : mobile.innerHTML;
    mobile.value = desktop.value;
    if (desktopId === 'memo-folder-select' && !mobile.value) mobile.value = state.get('activeMemo')?.folderId || '';
    if (desktopId === 'memo-category-select' && !mobile.value) mobile.value = state.get('activeMemo')?.categoryId || '';
    if (desktop.dataset.mobileSyncBound === 'true') continue;
    desktop.dataset.mobileSyncBound = 'true';
    const sync = (source, target) => { target.value = source.value; scheduleEditorAutosave(); };
    desktop.addEventListener('change', () => sync(desktop, mobile));
    mobile.addEventListener('change', () => sync(mobile, desktop));
  }
  syncMobileTagChips();
}

export function syncMobileTagChips() {
  const desktop = document.getElementById('editor-tags-chips');
  const mobile = document.getElementById('mobile-editor-tags-chips');
  if (desktop && mobile) mobile.innerHTML = desktop.innerHTML;
}

export function setupMobileTags() {
  const input = document.getElementById('mobile-editor-new-tag-input');
  const add = () => {
    const name = input?.value.trim().toLowerCase().replace(/^[#\s]+/, '');
    if (!name) return;
    const memo = state.get('activeMemo');
    if (!memo) return;
    memo.tags = Array.isArray(memo.tags) ? memo.tags : [];
    if (!memo.tags.includes(name)) memo.tags.push(name);
    renderEditorTags(memo.tags);
    syncMobileTagChips();
    if (input) input.value = '';
    scheduleEditorAutosave();
  };
  document.getElementById('mobile-editor-add-tag-btn')?.addEventListener('click', add);
  input?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } });
}

export async function showMemoHistory() {
  const memo = state.get('activeMemo');
  if (!memo?.id) { showToast('Save this note first to view its history', 'info'); return; }
  try {
    await flushEditorAutosave();
    openModal('modal-history');
    const container = document.getElementById('history-versions-list');
    if (container) container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Loading version history...</p>';

    const result = await api.getMemoVersions(memo.id);
    const versions = result.versions || [];

    if (!versions.length) {
      if (container) container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">No previous revisions found for this note.</p>';
      return;
    }

    if (container) {
      container.innerHTML = versions.map((v, i) => `
        <div style="padding: 0.85rem; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-surface);">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
            <strong style="font-size: 0.9rem;">Version ${v.versionNumber || (versions.length - i)}</strong>
            <span style="font-size: 0.75rem; color: var(--text-muted);">${new Date(v.createdAt).toLocaleString()}</span>
          </div>
          <div style="font-size: 0.85rem; font-weight: 600; margin-bottom: 0.35rem;">${escapeHtml(v.title || 'Untitled')}</div>
          <div style="font-size: 0.8rem; color: var(--text-secondary); max-height: 80px; overflow: hidden; text-overflow: ellipsis; white-space: pre-line; background: var(--bg-surface-hover); padding: 0.4rem; border-radius: 4px; margin-bottom: 0.5rem;">${escapeHtml((v.content || '').slice(0, 200))}${(v.content || '').length > 200 ? '...' : ''}</div>
          <button type="button" class="btn btn-outline btn-xs" data-restore-version="${i}">Restore This Version</button>
        </div>
      `).join('');

      container.querySelectorAll('[data-restore-version]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.restoreVersion, 10);
          const selected = versions[idx];
          if (!selected) return;
          const body = document.getElementById('editor-body-textarea');
          const titleInput = document.getElementById('editor-title-input');
          if (body) body.value = selected.content || '';
          if (titleInput) titleInput.value = selected.title || 'Untitled Memo';
          memo.content = selected.content || '';
          memo.title = selected.title || 'Untitled Memo';
          scheduleEditorAutosave();
          closeModal('modal-history');
          showToast(`Restored version from ${new Date(selected.createdAt).toLocaleDateString()}`, 'success');
        });
      });
    }
  } catch (error) { showToast(error.message || 'Unable to load history', 'error'); }
}

export function setupWhiteboard() {
  const canvas = document.getElementById('memo-whiteboard-canvas');
  if (!canvas || canvas.dataset.ready === 'true') return;
  canvas.dataset.ready = 'true';
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const getPoint = (event) => { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const drawStroke = (stroke) => {
    if (!stroke?.points?.length) return;
    ctx.strokeStyle = stroke.color; ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
    stroke.points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke();
  };
  const redraw = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(Math.max(rect.height, 320) * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, rect.width, Math.max(rect.height, 320));
    whiteboardStrokes.forEach(drawStroke);
  };
  canvas._redraw = redraw;
  canvas.addEventListener('pointerdown', (event) => {
    if (!document.getElementById('whiteboard-panel')?.classList.contains('active')) return;
    event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    whiteboardActiveStroke = { color: document.getElementById('whiteboard-color')?.value || '#222222', width: Number(document.getElementById('whiteboard-width')?.value || 3), points: [getPoint(event)] };
  });
  canvas.addEventListener('pointermove', (event) => { if (!whiteboardActiveStroke) return; whiteboardActiveStroke.points.push(getPoint(event)); redraw(); drawStroke(whiteboardActiveStroke); });
  const finish = () => { if (whiteboardActiveStroke) { whiteboardStrokes.push(whiteboardActiveStroke); whiteboardActiveStroke = null; } };
  canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
  window.addEventListener('resize', redraw); redraw();
}

export function toggleWhiteboard() {
  const panel = document.getElementById('whiteboard-panel');
  if (!panel) return;
  panel.classList.toggle('active');
  if (panel.classList.contains('active')) setTimeout(() => document.getElementById('memo-whiteboard-canvas')?._redraw?.(), 80);
}
export function clearWhiteboard() { whiteboardStrokes = []; document.getElementById('memo-whiteboard-canvas')?._redraw?.(); }
export function undoWhiteboardStroke() { whiteboardStrokes.pop(); document.getElementById('memo-whiteboard-canvas')?._redraw?.(); }

export function insertWhiteboardIntoMemo() {
  const canvas = document.getElementById('memo-whiteboard-canvas'); const textarea = document.getElementById('editor-body-textarea');
  if (!canvas || !textarea) return;
  const image = canvas.toDataURL('image/png');
  if (image.length > 1200000) { showToast('Drawing is too large. Clear or simplify it before inserting.', 'error'); return; }
  textarea.value += `${textarea.value ? '\n\n' : ''}![Whiteboard](${image})\n`;
  updateMarkdownLivePreview(); scheduleEditorAutosave(); toggleWhiteboard(); showToast('Whiteboard added to note', 'success');
}

export async function handleMemoImageFiles(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  if (!state.get('activeMemo')?.id) {
    await saveActiveMemo({ quiet: true });
  }
  const memo = state.get('activeMemo');
  if (!memo?.id) {
    showToast('Save the note before adding images, then try again.', 'error');
    return;
  }
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { showToast(`${file.name}: use PNG, JPEG, or WebP`, 'error'); continue; }
    if (file.size > 5 * 1024 * 1024) { showToast(`${file.name}: maximum image size is 5 MB`, 'error'); continue; }
    try {
      await api.uploadAttachment(memo.id, file);
    } catch (error) {
      showToast(error.message || `Unable to upload ${file.name}`, 'error', 5000);
    }
  }
  await renderMemoAttachments(memo.id);
}

export async function renderMemoAttachments(memoId) {
  const panel = document.getElementById('editor-attachments-panel');
  if (!panel || !memoId) return;
  try {
    const result = await api.listAttachments(memoId);
    const attachments = result.attachments || [];
    panel.replaceChildren();
    panel.hidden = attachments.length === 0;
    panel.setAttribute('aria-label', `Attached images (${attachments.length})`);
    if (!attachments.length) return;
    const heading = document.createElement('h3');
    heading.className = 'attachments-heading';
    heading.textContent = `Images (${attachments.length})`;
    panel.append(heading);
    for (const attachment of attachments) {
      const item = document.createElement('article');
      item.className = 'memo-attachment-item';
      const link = document.createElement('a');
      link.href = attachment.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'memo-attachment-preview-link';
      link.title = `Open ${attachment.fileName}`;
      const image = document.createElement('img');
      image.src = attachment.url;
      image.alt = attachment.fileName;
      image.loading = 'lazy';
      image.decoding = 'async';
      link.append(image);
      const meta = document.createElement('div');
      meta.className = 'memo-attachment-meta';
      const name = document.createElement('span');
      name.className = 'memo-attachment-name';
      name.textContent = attachment.fileName;
      const size = document.createElement('span');
      size.className = 'memo-attachment-size';
      size.textContent = `${(attachment.fileSize / 1024).toFixed(0)} KB`;
      meta.append(name, size);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-ghost btn-sm memo-attachment-remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${attachment.fileName}`);
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          await api.deleteAttachment(attachment.id);
          await renderMemoAttachments(memoId);
          showToast('Image removed', 'success');
        } catch (error) {
          remove.disabled = false;
          showToast(error.message || 'Unable to remove image', 'error');
        }
      });
      item.append(link, meta, remove);
      panel.append(item);
    }
  } catch (error) {
    panel.replaceChildren();
    panel.hidden = false;
    const message = document.createElement('p');
    message.className = 'attachments-error';
    message.textContent = error.message || 'Unable to load attachments';
    panel.append(message);
  }
}

export function setupEditorEnhancements() {
  const editor = document.getElementById('view-editor');
  if (!editor || editor.dataset.enhancementsReady === 'true') return;
  editor.dataset.enhancementsReady = 'true';
  const markDirty = () => scheduleEditorAutosave();
  ['editor-title-input', 'editor-body-textarea', 'memo-category-select', 'memo-folder-select', 'memo-priority-select', 'memo-status-select', 'memo-due-date-input', 'mobile-memo-category-select', 'mobile-memo-folder-select', 'mobile-memo-priority-select', 'mobile-memo-status-select', 'mobile-memo-due-date-input'].forEach((id) => {
    const el = document.getElementById(id); el?.addEventListener('input', markDirty); el?.addEventListener('change', markDirty);
  });
  document.getElementById('editor-fav-btn')?.addEventListener('click', markDirty);
  document.getElementById('editor-pin-btn')?.addEventListener('click', markDirty);
  document.getElementById('editor-history-btn-top')?.addEventListener('click', showMemoHistory);
  document.getElementById('editor-history-btn-side')?.addEventListener('click', showMemoHistory);
  document.getElementById('editor-whiteboard-btn')?.addEventListener('click', toggleWhiteboard);
  document.getElementById('whiteboard-close-btn')?.addEventListener('click', toggleWhiteboard);
  document.getElementById('whiteboard-clear-btn')?.addEventListener('click', clearWhiteboard);
  document.getElementById('whiteboard-undo-btn')?.addEventListener('click', undoWhiteboardStroke);
  document.getElementById('whiteboard-insert-btn')?.addEventListener('click', insertWhiteboardIntoMemo);
  document.getElementById('editor-attach-btn')?.addEventListener('click', () => document.getElementById('memo-image-input')?.click());
  document.getElementById('memo-image-input')?.addEventListener('change', handleMemoImageFiles);
  setupMobileTags(); setupWhiteboard();
  window.addEventListener('pagehide', () => { if (editorHasUnsavedChanges) { try { sessionStorage.setItem('memo-pending-editor-draft', editorSnapshot()); } catch {} } });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.getElementById('whiteboard-panel')?.classList.contains('active')) toggleWhiteboard();
  });
}

export function loadMemoIntoEditor(memo) {
  editorIsHydrating = true;
  editorHasUnsavedChanges = false;
  clearTimeout(editorAutosaveTimer);
  state.set('activeMemo', memo);

  const titleInput = document.getElementById('editor-title-input');
  const bodyTextarea = document.getElementById('editor-body-textarea');
  const categorySelect = document.getElementById('memo-category-select');
  const folderSelect = document.getElementById('memo-folder-select');
  const prioritySelect = document.getElementById('memo-priority-select');
  const statusSelect = document.getElementById('memo-status-select');
  const dueDateInput = document.getElementById('memo-due-date-input');
  const workspaceBadge = document.getElementById('editor-workspace-badge');
  const saveIndicator = document.getElementById('editor-save-indicator');
  const conflictAlert = document.getElementById('editor-conflict-alert');
  const favBtn = document.getElementById('editor-fav-btn');
  const pinBtn = document.getElementById('editor-pin-btn');

  if (conflictAlert) conflictAlert.classList.remove('active');

  if (titleInput) titleInput.value = memo.title || '';
  if (bodyTextarea) bodyTextarea.value = memo.content || '';

  populateCategorySelect(memo.categoryId || memo.category?.id || memo.category);
  populateFolderSelect(memo.folderId || memo.folder_id || '');

  if (prioritySelect) prioritySelect.value = (memo.priority || 'medium').toLowerCase();
  if (statusSelect) statusSelect.value = (memo.status || 'pending').toLowerCase();

  if (dueDateInput) {
    if (memo.dueDate || memo.due_date) {
      const d = new Date(memo.dueDate || memo.due_date);
      dueDateInput.value = d.toISOString().split('T')[0];
    } else {
      dueDateInput.value = '';
    }
  }

  const catName = memo.category?.name || memo.category || 'General';
  if (workspaceBadge) workspaceBadge.textContent = catName;
  if (saveIndicator) saveIndicator.textContent = memo.id ? `Saved (v${memo.version || 1})` : 'New Memo';

  if (favBtn) {
    favBtn.classList.toggle('active', !!memo.isFavorite);
    favBtn.querySelector('svg')?.setAttribute('fill', memo.isFavorite ? 'currentColor' : 'none');
  }
  if (pinBtn) {
    pinBtn.classList.toggle('pinned-active', !!memo.isPinned);
  }

  renderEditorTags(memo.tags || []);
  syncMobileMetadataFromDesktop();
  syncMobileTagChips();
  setEditorTab('write');
  updateMarkdownLivePreview();
  editorLastSavedSnapshot = editorSnapshot();
  editorIsHydrating = false;
  setEditorSaveState(memo.id ? `Saved (v${memo.version || 1})` : 'New note, saving automatically', 'saved');
}

export function populateCategorySelect(selectedCategoryId = '') {
  const select = document.getElementById('memo-category-select');
  if (!select) return;

  const categories = state.get('categories') || [];
  select.innerHTML = `
    <option value="">No Category</option>
    ${categories.map((c) => `
      <option value="${c.id}" ${selectedCategoryId === c.id || selectedCategoryId === c.name ? 'selected' : ''}>
        ${escapeHtml(c.name)}
      </option>
    `).join('')}
  `;
  const mobile = document.getElementById('mobile-memo-category-select');
  if (mobile) { mobile.innerHTML = select.innerHTML; mobile.value = selectedCategoryId || ''; }
}

export function populateFolderSelect(selectedFolderId = '') {
  const select = document.getElementById('memo-folder-select');
  if (!select) return;

  const folders = state.get('folders') || [];
  select.innerHTML = `
    <option value="">No Folder</option>
    ${folders.map((folder) => `
      <option value="${escapeHtml(folder.id)}" ${selectedFolderId === folder.id ? 'selected' : ''}>${escapeHtml(folder.name)}</option>
    `).join('')}
  `;
  const mobile = document.getElementById('mobile-memo-folder-select');
  if (mobile) { mobile.innerHTML = select.innerHTML; mobile.value = selectedFolderId || ''; }
}

export function setEditorTab(tabName) {
  state.set('editorMode', tabName);
  const layout = document.getElementById('editor-layout-container');
  if (!layout) return;

  layout.classList.remove('mode-write', 'mode-preview', 'mode-split');
  layout.classList.add(`mode-${tabName}`);

  document.querySelectorAll('#editor-tabs-group .editor-tab-btn').forEach((btn) => {
    btn.classList.remove('active');
  });

  const activeBtn = document.getElementById(`tab-${tabName}-btn`);
  if (activeBtn) activeBtn.classList.add('active');

  if (tabName === 'preview' || tabName === 'split') {
    updateMarkdownLivePreview();
  }
}

export function updateMarkdownLivePreview() {
  const bodyTextarea = document.getElementById('editor-body-textarea');
  const previewCanvas = document.getElementById('editor-preview-canvas');
  if (!bodyTextarea || !previewCanvas) return;

  const html = renderMarkdown(bodyTextarea.value);
  previewCanvas.innerHTML = html;
  previewCanvas.querySelectorAll('img').forEach((image) => {
    image.loading = 'lazy';
    image.decoding = 'async';
    image.style.maxWidth = '100%';
    image.style.height = 'auto';
    image.style.borderRadius = '10px';
  });

  previewCanvas.querySelectorAll('.md-interactive-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const idx = Number(checkbox.getAttribute('data-checklist-idx'));
      const updatedMarkdown = toggleChecklistItem(bodyTextarea.value, idx);
      bodyTextarea.value = updatedMarkdown;
      updateMarkdownLivePreview();
      scheduleEditorAutosave();
    });
  });
}

export function renderEditorTags(tags) {
  const container = document.getElementById('editor-tags-chips');
  if (!container) return;

  container.innerHTML = tags.map((t) => `
    <span class="tag-chip">${escapeHtml(t)} <span class="tag-chip-remove" role="button" data-tag="${escapeHtml(t)}">&times;</span></span>
  `).join('');

  container.querySelectorAll('.tag-chip-remove').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tagToRemove = btn.getAttribute('data-tag');
      const activeMemo = state.get('activeMemo');
      if (activeMemo) {
        activeMemo.tags = (activeMemo.tags || []).filter((t) => t !== tagToRemove);
        renderEditorTags(activeMemo.tags);
        syncMobileTagChips();
        scheduleEditorAutosave();
      }
    });
  });
}

export async function saveActiveMemo(options = {}) {
  const quiet = options.quiet === true;
  if (editorSaveInFlight) {
    await editorSaveInFlight;
    if (editorHasUnsavedChanges && editorSnapshot() !== editorLastSavedSnapshot) return saveActiveMemo(options);
    return;
  }
  const activeMemo = state.get('activeMemo') || {};
  const titleText = document.getElementById('editor-title-input')?.value.trim() || '';
  const bodyText = document.getElementById('editor-body-textarea')?.value.trim() || '';
  if (!activeMemo.id && !titleText && !bodyText) {
    editorHasUnsavedChanges = false;
    editorLastSavedSnapshot = editorSnapshot();
    setEditorSaveState('New note', 'saved');
    return;
  }
  const outgoingSnapshot = editorSnapshot();
  editorSaveInFlight = saveActiveMemoImpl({ quiet, outgoingSnapshot });
  try { await editorSaveInFlight; } finally { editorSaveInFlight = null; }
}

async function saveActiveMemoImpl({ quiet, outgoingSnapshot }) {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs || !activeWs.id) {
    showToast('Please select or create an active workspace first', 'error');
    return;
  }

  const titleInput = document.getElementById('editor-title-input');
  const bodyTextarea = document.getElementById('editor-body-textarea');
  const categorySelect = document.getElementById('memo-category-select');
  const folderSelect = document.getElementById('memo-folder-select');
  const prioritySelect = document.getElementById('memo-priority-select');
  const statusSelect = document.getElementById('memo-status-select');
  const dueDateInput = document.getElementById('memo-due-date-input');
  const saveBtn = document.getElementById('editor-save-btn');
  const conflictAlert = document.getElementById('editor-conflict-alert');

  const activeMemo = state.get('activeMemo') || {};

  const title = titleInput?.value.trim() || 'Untitled Memo';
  const content = bodyTextarea?.value || '';
  const mobileCategory = document.getElementById('mobile-memo-category-select');
  const mobileFolder = document.getElementById('mobile-memo-folder-select');
  const mobilePriority = document.getElementById('mobile-memo-priority-select');
  const mobileStatus = document.getElementById('mobile-memo-status-select');
  const mobileDueDate = document.getElementById('mobile-memo-due-date-input');
  const categoryId = mobileCategory && window.matchMedia('(max-width: 900px)').matches ? (mobileCategory.value || null) : (categorySelect?.value || null);
  const folderId = mobileFolder && window.matchMedia('(max-width: 900px)').matches ? (mobileFolder.value || null) : (folderSelect?.value || null);
  const priority = mobilePriority && window.matchMedia('(max-width: 900px)').matches ? mobilePriority.value : (prioritySelect?.value || 'medium');
  const status = mobileStatus && window.matchMedia('(max-width: 900px)').matches ? mobileStatus.value : (statusSelect?.value || 'pending');
  const dueDateValue = mobileDueDate && window.matchMedia('(max-width: 900px)').matches ? mobileDueDate.value : (dueDateInput?.value || '');
  const dueDate = dueDateValue ? new Date(dueDateValue).getTime() : null;
  const tags = activeMemo.tags || [];
  const isFavorite = !!activeMemo.isFavorite;
  const isPinned = !!activeMemo.isPinned;
  const normalizedDate = (value) => value == null || value === '' ? null : (typeof value === 'string' && !/^\d+$/.test(value) ? new Date(value).getTime() : Number(value));

  if (saveBtn) saveBtn.disabled = true;

  try {
    if (activeMemo.id && activeMemo.version !== undefined) {
      const savedTitle = activeMemo.title || '';
      const savedContent = activeMemo.content || '';
      const savedCategory = activeMemo.categoryId || activeMemo.category?.id || null;
      const savedFolder = activeMemo.folderId || activeMemo.folder_id || null;
      const savedDueDate = activeMemo.dueDate || activeMemo.due_date || null;
      const metadataSame = savedCategory === categoryId && savedFolder === folderId
        && (activeMemo.priority || 'medium') === priority && (activeMemo.status || 'pending') === status
        && normalizedDate(savedDueDate) === normalizedDate(dueDate)
        && !!activeMemo.isFavorite === isFavorite && !!activeMemo.isPinned === isPinned
        && JSON.stringify(activeMemo.tags || []) === JSON.stringify(tags);
      if (savedTitle === title && savedContent === content && metadataSame) {
        editorHasUnsavedChanges = false;
        editorLastSavedSnapshot = outgoingSnapshot;
        setEditorSaveState(`Saved (v${activeMemo.version || 1})`, 'saved');
        if (saveBtn) saveBtn.disabled = false;
        return;
      }
      const res = await api.updateMemo(activeMemo.id, {
        version: activeMemo.version,
        title,
        content,
        categoryId,
        folderId,
        priority,
        status,
        dueDate,
        tags,
        isFavorite,
        isPinned,
      });

      const updated = res.memo;
      state.set('activeMemo', { ...updated, isFavorite: !!updated.isFavorite, isPinned: !!updated.isPinned });
      void renderMemoAttachments(updated.id);
      editorLastSavedSnapshot = editorSnapshot();
      const favoriteButton = document.getElementById('editor-fav-btn');
      const pinButton = document.getElementById('editor-pin-btn');
      favoriteButton?.classList.toggle('active', !!updated.isFavorite);
      favoriteButton?.querySelector('svg')?.setAttribute('fill', updated.isFavorite ? 'currentColor' : 'none');
      pinButton?.classList.toggle('pinned-active', !!updated.isPinned);
      if (conflictAlert) conflictAlert.classList.remove('active');
    } else {
      const res = await api.createMemo({
        workspaceId: activeWs.id,
        title,
        content,
        categoryId,
        folderId,
        priority,
        status,
        dueDate,
        tags,
        isFavorite: !!activeMemo.isFavorite,
        isPinned: !!activeMemo.isPinned,
      });

      const created = res.memo;
      state.set('activeMemo', { ...created, isFavorite: !!created.isFavorite, isPinned: !!created.isPinned });
      void renderMemoAttachments(created.id);
      editorLastSavedSnapshot = editorSnapshot();
      const favoriteButton = document.getElementById('editor-fav-btn');
      const pinButton = document.getElementById('editor-pin-btn');
      favoriteButton?.classList.toggle('active', !!created.isFavorite);
      favoriteButton?.querySelector('svg')?.setAttribute('fill', created.isFavorite ? 'currentColor' : 'none');
      pinButton?.classList.toggle('pinned-active', !!created.isPinned);
    }

    if (typeof onRefreshWorkspaceCallback === 'function') {
      await onRefreshWorkspaceCallback();
    }
  } catch (err) {
    console.error('Error saving memo:', err);
    editorHasUnsavedChanges = true;
    setEditorSaveState('Save failed. Retry required.', 'error');
    if (!quiet) showToast(err.message || 'Failed to save memo', 'error', 5000);
    if (err.status === 409) {
      if (conflictAlert) {
        conflictAlert.classList.add('active');
        const conflictMsg = document.getElementById('editor-conflict-msg');
        if (conflictMsg) {
          conflictMsg.innerHTML = `<strong>Version Conflict:</strong> Memo was modified in another session (current version: ${err.data?.currentVersion || 'new'}).`;
        }
      }
      editorHasUnsavedChanges = true;
      setEditorSaveState('Conflict. Review latest version.', 'error');
      if (!quiet) showToast('Conflict: memo was modified concurrently. Please reload.', 'error', 4000);
    } else {
      if (!quiet) showToast(err.message || 'Failed to save memo', 'error');
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }

  if (editorSnapshot() === outgoingSnapshot && !conflictAlert?.classList.contains('active')) {
    editorHasUnsavedChanges = false;
    editorLastSavedSnapshot = editorSnapshot();
    setEditorSaveState(`Saved · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, 'saved');
  } else {
    editorHasUnsavedChanges = true;
    setEditorSaveState('Saving newer edits…', 'dirty');
    clearTimeout(editorAutosaveTimer);
    editorAutosaveTimer = setTimeout(() => void saveActiveMemo({ quiet: true }), 100);
  }
}

export function setupFormattingToolbar() {
  document.querySelectorAll('.editor-toolbar .toolbar-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const action = btn.getAttribute('data-action');
      const textarea = document.getElementById('editor-body-textarea');
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;
      const selected = text.slice(start, end);

      let replacement = '';

      switch (action) {
        case 'bold':
          replacement = `**${selected || 'bold text'}**`;
          break;
        case 'italic':
          replacement = `*${selected || 'italic text'}*`;
          break;
        case 'underline':
          replacement = `<u>${selected || 'underlined text'}</u>`;
          break;
        case 'strike':
          replacement = `~~${selected || 'strikethrough'}~~`;
          break;
        case 'h1':
          replacement = `\n# ${selected || 'Heading 1'}\n`;
          break;
        case 'h2':
          replacement = `\n## ${selected || 'Heading 2'}\n`;
          break;
        case 'code':
          replacement = selected.includes('\n') ? `\n\`\`\`\n${selected || 'code block'}\n\`\`\`\n` : `\`${selected || 'code'}\``;
          break;
        case 'bullet':
          replacement = `\n- ${selected || 'List item'}\n`;
          break;
        case 'numbered':
          replacement = `\n1. ${selected || 'First item'}\n`;
          break;
        case 'checklist':
          replacement = `\n- [ ] ${selected || 'Task checklist item'}\n`;
          break;
        case 'blockquote':
          replacement = `\n> ${selected || 'Quote'}\n`;
          break;
        case 'undo':
          document.execCommand('undo');
          return;
        case 'redo':
          document.execCommand('redo');
          return;
      }

      textarea.value = text.slice(0, start) + replacement + text.slice(end);
      textarea.focus();
      textarea.setSelectionRange(start + replacement.length, start + replacement.length);

      if (state.get('editorMode') === 'split' || state.get('editorMode') === 'preview') {
        updateMarkdownLivePreview();
      }
      scheduleEditorAutosave();
    });
  });

  let livePreviewTimer = null;
  document.getElementById('editor-body-textarea')?.addEventListener('input', () => {
    if (state.get('editorMode') === 'split') {
      clearTimeout(livePreviewTimer);
      livePreviewTimer = setTimeout(updateMarkdownLivePreview, 150);
    }
  });
}
