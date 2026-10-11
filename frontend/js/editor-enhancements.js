let editorAutosaveTimer = null;
let editorSaveInFlight = null;
let editorHasUnsavedChanges = false;
let editorIsHydrating = false;
let editorLastSavedSnapshot = '';
let whiteboardStrokes = [];
let whiteboardActiveStroke = null;

function editorSnapshot() {
  const memo = state.get('activeMemo') || {};
  const get = (id) => document.getElementById(id);
  const date = get('memo-due-date-input')?.value || get('mobile-memo-due-date-input')?.value || '';
  return JSON.stringify({
    id: memo.id || null, version: memo.version || 0,
    title: get('editor-title-input')?.value.trim() || 'Untitled Memo',
    content: get('editor-body-textarea')?.value || '',
    categoryId: get('mobile-memo-category-select')?.value || get('memo-category-select')?.value || null,
    folderId: get('mobile-memo-folder-select')?.value || get('memo-folder-select')?.value || null,
    priority: get('mobile-memo-priority-select')?.value || get('memo-priority-select')?.value || 'medium',
    status: get('mobile-memo-status-select')?.value || get('memo-status-select')?.value || 'pending',
    dueDate: date ? new Date(date).getTime() : null,
    tags: memo.tags || [], isFavorite: !!memo.isFavorite, isPinned: !!memo.isPinned,
  });
}

function setEditorSaveState(message, kind = '') {
  const indicator = document.getElementById('editor-save-indicator');
  if (indicator) { indicator.textContent = message; indicator.dataset.saveState = kind; }
}

function scheduleEditorAutosave(immediate = false) {
  if (editorIsHydrating || state.get('currentView') !== 'editor') return;
  editorHasUnsavedChanges = true;
  setEditorSaveState('Saving changes…', 'dirty');
  clearTimeout(editorAutosaveTimer);
  editorAutosaveTimer = setTimeout(() => void saveActiveMemo({ quiet: true }), immediate ? 0 : 650);
}

async function flushEditorAutosave() {
  clearTimeout(editorAutosaveTimer);
  if (editorHasUnsavedChanges && state.get('currentView') === 'editor') await saveActiveMemo({ quiet: true });
  if (editorSaveInFlight) await editorSaveInFlight;
}

function syncMobileMetadataFromDesktop() {
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
    const sync = (source, target) => { target.value = source.value; scheduleEditorAutosave(); };
    desktop.addEventListener('change', () => sync(desktop, mobile));
    mobile.addEventListener('change', () => sync(mobile, desktop));
  }
  syncMobileTagChips();
}

function syncMobileTagChips() {
  const desktop = document.getElementById('editor-tags-chips');
  const mobile = document.getElementById('mobile-editor-tags-chips');
  if (desktop && mobile) mobile.innerHTML = desktop.innerHTML;
}

function setupMobileTags() {
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

async function showMemoHistory() {
  const memo = state.get('activeMemo');
  if (!memo?.id) { showToast('Save this note first to view its history', 'info'); return; }
  try {
    await flushEditorAutosave();
    const result = await api.getMemoVersions(memo.id);
    const versions = result.versions || [];
    const lines = versions.map((v) => `Version ${v.versionNumber} · ${new Date(v.createdAt).toLocaleString()}\n${v.title || 'Untitled'}\n${v.content || ''}`).join('\n\n----------------\n\n');
    showToast(`${versions.length} saved version(s). Copy content from note history preview.`, 'info');
    const body = document.getElementById('editor-body-textarea');
    if (body) { body.dataset.currentDraft = body.value; body.value = lines || 'No saved versions.'; setEditorTab('preview'); }
  } catch (error) { showToast(error.message || 'Unable to load history', 'error'); }
}

function setupWhiteboard() {
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

function toggleWhiteboard() {
  const panel = document.getElementById('whiteboard-panel');
  if (!panel) return;
  panel.classList.toggle('active');
  if (panel.classList.contains('active')) setTimeout(() => document.getElementById('memo-whiteboard-canvas')?._redraw?.(), 80);
}
function clearWhiteboard() { whiteboardStrokes = []; document.getElementById('memo-whiteboard-canvas')?._redraw?.(); }
function undoWhiteboardStroke() { whiteboardStrokes.pop(); document.getElementById('memo-whiteboard-canvas')?._redraw?.(); }

function insertWhiteboardIntoMemo() {
  const canvas = document.getElementById('memo-whiteboard-canvas'); const textarea = document.getElementById('editor-body-textarea');
  if (!canvas || !textarea) return;
  const image = canvas.toDataURL('image/png');
  if (image.length > 1200000) { showToast('Drawing is too large. Clear or simplify it before inserting.', 'error'); return; }
  textarea.value += `${textarea.value ? '\n\n' : ''}![Whiteboard](${image})\n`;
  updateMarkdownLivePreview(); scheduleEditorAutosave(); toggleWhiteboard(); showToast('Whiteboard added to note', 'success');
}

async function handleMemoImageFiles(event) {
  const textarea = document.getElementById('editor-body-textarea'); const files = Array.from(event.target.files || []);
  for (const file of files) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { showToast(`${file.name}: use PNG, JPEG, or WebP`, 'error'); continue; }
    if (file.size > 1500000) { showToast(`${file.name}: maximum image size is 1.5 MB`, 'error'); continue; }
    try {
      const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Image read failed')); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(file); });
      const safeName = file.name.replace(/[\[\]<>]/g, '');
      textarea.value += `${textarea.value ? '\n\n' : ''}![${safeName}](${data})\n`;
    } catch (error) { showToast(error.message || `Unable to read ${file.name}`, 'error'); }
  }
  updateMarkdownLivePreview(); scheduleEditorAutosave(); event.target.value = '';
}

function setupEditorEnhancements() {
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
