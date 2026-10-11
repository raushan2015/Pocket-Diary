/**
 * Memo Manager SaaS - Main Application Bootstrap & Controller
 * Implements System Design §3, §4.2, §4.3, §4.4, §4.5, §4.6 and Visual Reference (frontend.PNG)
 */

import { api } from './api.js';
import { state } from './state.js';
import { renderMarkdown, extractChecklistStats, toggleChecklistItem, escapeHtml } from './markdown.js';

// Mobile-first autosave, image and whiteboard helpers. Kept in this module to share app state safely.
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

function setEditorSaveState(message, kind = '') {
  const indicator = document.getElementById('editor-save-indicator');
  if (indicator) { indicator.textContent = message; indicator.dataset.saveState = kind; }
}

function scheduleEditorAutosave(immediate = false) {
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

async function flushEditorAutosave() {
  clearTimeout(editorAutosaveTimer);
  if (state.get('currentView') !== 'editor') return;
  // Re-evaluate the live fields at navigation time, so the final keystroke/metadata
  // change cannot be skipped just because its debounce callback has not fired yet.
  const memo = state.get('activeMemo') || {};
  const hasDraft = !!document.getElementById('editor-title-input')?.value.trim()
    || !!document.getElementById('editor-body-textarea')?.value.trim();
  if (hasDraft || memo.id) {
    if (editorSnapshot() !== editorLastSavedSnapshot) editorHasUnsavedChanges = true;
    if (editorHasUnsavedChanges) await saveActiveMemo({ quiet: true });
  }
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
    if (desktop.dataset.mobileSyncBound === 'true') continue;
    desktop.dataset.mobileSyncBound = 'true';
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
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  // Attachments belong to a persisted memo; save the current draft first when necessary.
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

async function renderMemoAttachments(memoId) {
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


// ==========================================================================
// Toast Notification Center
// ==========================================================================
export function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;

  let iconSvg = '';
  if (type === 'success') {
    iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
  } else if (type === 'error') {
    iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
  } else {
    iconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
  }

  toast.innerHTML = `
    <span class="toast-icon">${iconSvg}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>
    <button class="toast-close-btn" aria-label="Close notification">&times;</button>
  `;

  toast.querySelector('.toast-close-btn')?.addEventListener('click', () => toast.remove());

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    setTimeout(() => toast.remove(), 250);
  }, duration);
}

// ==========================================================================
// Theme Management (Light / Dark System)
// ==========================================================================
function initTheme() {
  const savedTheme = localStorage.getItem('memo_theme');
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
  applyTheme(initialTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('memo_theme', theme);
  state.set('theme', theme);

  const sunIcon = document.querySelector('.theme-icon-sun');
  const moonIcon = document.querySelector('.theme-icon-moon');
  const dropdownThemeLabel = document.getElementById('dropdown-theme-label');

  if (theme === 'dark') {
    if (sunIcon) sunIcon.style.display = 'block';
    if (moonIcon) moonIcon.style.display = 'none';
    if (dropdownThemeLabel) dropdownThemeLabel.textContent = 'Light';
  } else {
    if (sunIcon) sunIcon.style.display = 'none';
    if (moonIcon) moonIcon.style.display = 'block';
    if (dropdownThemeLabel) dropdownThemeLabel.textContent = 'Dark';
  }
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  showToast(`Switched to ${newTheme === 'dark' ? 'Dark' : 'Light'} theme`, 'info', 2000);
}

// ==========================================================================
// SPA View Navigation
// ==========================================================================
export async function navigateTo(viewName, params = {}) {
  const previousView = state.get('currentView');
  if (state.get('currentView') === 'editor' && viewName !== 'editor') {
    const activeMemo = state.get('activeMemo');
    if (activeMemo?.id && editorHasUnsavedChanges) {
      try {
        await flushEditorAutosave();
      } catch (error) {
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
        } catch (error) {
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
      if (v === viewName) {
        el.classList.add('active');
      } else {
        el.classList.remove('active');
      }
    }
  });

  state.set('currentView', viewName);

  // Navbar elements adjustment
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

function updateMobileNavState(viewName) {
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

// ==========================================================================
// Authentication Controller (system-design.md §4.2)
// ==========================================================================
function setAuthMode(mode) {
  state.set('authMode', mode);

  const titleEl = document.getElementById('auth-title');
  const subtitleEl = document.getElementById('auth-subtitle');
  const nameGroup = document.getElementById('auth-name-group');
  const optionsRow = document.getElementById('auth-options-row');
  const submitBtn = document.getElementById('auth-submit-btn');
  const switchPrompt = document.getElementById('auth-switch-question');
  const switchBtn = document.getElementById('auth-switch-btn');
  const alertEl = document.getElementById('auth-alert');

  if (alertEl) {
    alertEl.className = 'auth-alert';
    alertEl.textContent = '';
  }
  clearAuthFieldErrors();

  if (mode === 'register') {
    if (titleEl) titleEl.textContent = 'Create Account';
    if (subtitleEl) subtitleEl.textContent = 'Get started with your free Memo Manager workspace';
    if (nameGroup) nameGroup.style.display = 'flex';
    if (optionsRow) optionsRow.style.display = 'none';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Create Account';
    if (switchPrompt) switchPrompt.textContent = 'Already have an account?';
    if (switchBtn) switchBtn.textContent = 'Sign in';
  } else {
    if (titleEl) titleEl.textContent = 'Welcome Back';
    if (subtitleEl) subtitleEl.textContent = 'Sign in to your Memo Manager account';
    if (nameGroup) nameGroup.style.display = 'none';
    if (optionsRow) optionsRow.style.display = 'flex';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Sign In';
    if (switchPrompt) switchPrompt.textContent = "Don't have an account?";
    if (switchBtn) switchBtn.textContent = 'Sign up';
  }
}

function clearAuthFieldErrors() {
  document.querySelectorAll('.form-error-msg').forEach((el) => {
    el.classList.remove('active');
  });
}

function showAuthAlert(message, type = 'error') {
  const alertEl = document.getElementById('auth-alert');
  if (!alertEl) return;
  alertEl.className = `auth-alert ${type} active`;
  alertEl.textContent = message;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  clearAuthFieldErrors();

  const mode = state.get('authMode') || 'login';
  const emailInput = document.getElementById('auth-email-input');
  const passwordInput = document.getElementById('auth-password-input');
  const nameInput = document.getElementById('auth-name-input');
  const submitBtn = document.getElementById('auth-submit-btn');

  const email = emailInput?.value.trim() || '';
  const password = passwordInput?.value || '';
  const name = nameInput?.value.trim() || '';

  let hasError = false;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('auth-email-error')?.classList.add('active');
    hasError = true;
  }

  if (!password || password.length < 6) {
    document.getElementById('auth-password-error')?.classList.add('active');
    hasError = true;
  }

  if (mode === 'register' && (!name || name.length < 2)) {
    document.getElementById('auth-name-error')?.classList.add('active');
    hasError = true;
  }

  if (hasError) return;

  const originalBtnText = submitBtn.querySelector('.auth-btn-text').textContent;
  submitBtn.disabled = true;
  submitBtn.querySelector('.auth-btn-text').textContent = mode === 'register' ? 'Creating Account...' : 'Signing In...';

  try {
    if (mode === 'register') {
      const response = await api.register({ email, password, name });
      const user = response.user;
      const workspace = response.workspace;

      state.setUser(user, [workspace], workspace);
      showToast(`Welcome to Memo Manager, ${user.name}!`, 'success');
      resetAuthForm();
      await fetchWorkspaceData();
      navigateTo('dashboard');
    } else {
      const response = await api.login({ email, password });
      const user = response.user;
      const activeWorkspace = response.activeWorkspace;

      let workspaces = [activeWorkspace];
      try {
        const meData = await api.getMe();
        if (meData.workspaces && meData.workspaces.length) {
          workspaces = meData.workspaces;
        }
      } catch {
        // Fallback to activeWorkspace
      }

      state.setUser(user, workspaces, activeWorkspace);
      showToast(`Welcome back, ${user.name}!`, 'success');
      resetAuthForm();
      await fetchWorkspaceData();
      navigateTo('dashboard');
    }
  } catch (err) {
    console.error('Authentication error:', err);
    const errorMsg = err.message || (mode === 'register' ? 'Registration failed' : 'Invalid email or password');
    showAuthAlert(errorMsg, 'error');
    showToast(errorMsg, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector('.auth-btn-text').textContent = originalBtnText;
  }
}

function resetAuthForm() {
  const form = document.getElementById('auth-form');
  if (form) form.reset();
  const alertEl = document.getElementById('auth-alert');
  if (alertEl) {
    alertEl.className = 'auth-alert';
    alertEl.textContent = '';
  }
  clearAuthFieldErrors();
}

async function handleLogout() {
  try {
    await api.logout();
    state.clearUser();
    showToast('Signed out successfully', 'info');
    closeUserDropdown();
    navigateTo('landing');
  } catch (err) {
    console.error('Logout error:', err);
    state.clearUser();
    closeUserDropdown();
    navigateTo('landing');
  }
}

// Session Persistence Check (GET /api/v1/auth/me)
async function detectSession() {
  try {
    const data = await api.getMe();
    if (data && data.user) {
      state.setUser(data.user, data.workspaces || [], data.workspaces?.[0] || null);
      await fetchWorkspaceData();
      if (state.get('currentView') === 'landing' || state.get('currentView') === 'auth') {
        navigateTo('dashboard');
      }
      return true;
    }
  } catch {
    state.clearUser();
  }
  return false;
}

// ==========================================================================
// Workspace Data Management (system-design.md §4.3, §4.4, §4.5)
// ==========================================================================
async function fetchWorkspaceData() {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs || !activeWs.id) return;

  state.set('isLoadingMemos', true);

  try {
    const [memosRes, categoriesRes, tagsRes, foldersRes] = await Promise.all([
      api.listMemos({ workspaceId: activeWs.id, limit: 100 }),
      api.listCategories(activeWs.id).catch(() => ({ categories: [] })),
      api.listTags(activeWs.id).catch(() => ({ tags: [] })),
      api.listFolders(activeWs.id).catch(() => ({ folders: [] })),
    ]);

    const memos = (memosRes && memosRes.memos) || [];
    const categories = (categoriesRes && categoriesRes.categories) || [];
    const tags = (tagsRes && tagsRes.tags) || [];
    const folders = (foldersRes && foldersRes.folders) || [];

    state.set('allWorkspaceMemos', memos);
    state.set('categories', categories);
    state.set('tags', tags);
    state.set('folders', folders);

    // Compute KPIs
    state.updateKpisFromMemos(memos);

    // Render Sidebars & Filters
    renderSidebarCategories(categories);
    renderSidebarTags(tags);
    renderSidebarFolders(folders);
    updateSidebarBadges();
    renderInteractiveCalendar(currentCalYear, currentCalMonth);
    renderUpcomingReminders();

    // Render Current Memos view
    filterAndRenderMemos();
  } catch (err) {
    console.error('Error fetching workspace data:', err);
    showToast('Failed to load workspace memos from server', 'error');
  } finally {
    state.set('isLoadingMemos', false);
  }
}

async function refreshWorkspaceMemos() {
  await fetchWorkspaceData();
}

function updateSidebarBadges() {
  const allMemos = state.get('allWorkspaceMemos') || [];
  const activeMemos = allMemos.filter((m) => !m.deletedAt);

  const countAll = document.getElementById('sidebar-count-all');
  const countFav = document.getElementById('sidebar-count-fav');
  const countPinned = document.getElementById('sidebar-count-pinned');
  const countDue = document.getElementById('sidebar-count-due');

  const now = Date.now();
  const nextWeek = now + 7 * 86400000;

  if (countAll) countAll.textContent = activeMemos.length;
  if (countFav) countFav.textContent = activeMemos.filter((m) => m.isFavorite).length;
  if (countPinned) countPinned.textContent = activeMemos.filter((m) => m.isPinned).length;
  if (countDue) countDue.textContent = activeMemos.filter((m) => m.dueDate && m.dueDate <= nextWeek).length;

  // Query trash count asynchronously
  const activeWs = state.get('activeWorkspace');
  if (activeWs && activeWs.id) {
    api.listMemos({ workspaceId: activeWs.id, includeDeleted: true, limit: 100 })
      .then((res) => {
        const deleted = (res.memos || []).filter((m) => m.deletedAt !== null);
        const countTrash = document.getElementById('sidebar-count-trash');
        if (countTrash) countTrash.textContent = deleted.length;
      })
      .catch(() => {});
  }
}

// ==========================================================================
// Filtering & Search Controller (system-design.md §4.4 FTS Search)
// ==========================================================================
let searchDebounceTimeout = null;

function setupSearchInput() {
  const searchInput = document.getElementById('global-search-input');
  const filterPanel = document.getElementById('navbar-filter-panel');
  const filterToggle = document.getElementById('navbar-filter-toggle');
  const filterBar = document.querySelector('#view-dashboard .memos-filter-bar');
  if (filterPanel && filterBar && filterBar.parentElement !== filterPanel) filterPanel.appendChild(filterBar);
  if (filterToggle && filterPanel && !filterToggle.dataset.bound) {
    filterToggle.dataset.bound = 'true';
    filterToggle.addEventListener('click', () => {
      const opening = filterPanel.hidden;
      filterPanel.hidden = !opening;
      filterToggle.setAttribute('aria-expanded', String(opening));
      filterToggle.classList.toggle('is-active', opening);
    });
    document.addEventListener('click', (event) => {
      if (!filterPanel.hidden && !filterPanel.contains(event.target) && !filterToggle.contains(event.target)) {
        filterPanel.hidden = true;
        filterToggle.setAttribute('aria-expanded', 'false');
        filterToggle.classList.remove('is-active');
      }
    });
  }
  if (!searchInput) return;

  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    clearTimeout(searchDebounceTimeout);

    searchDebounceTimeout = setTimeout(async () => {
      state.set('searchQuery', query);
      const activeWs = state.get('activeWorkspace');

      if (!query) {
        filterAndRenderMemos();
        return;
      }

      if (!activeWs || !activeWs.id) return;

      try {
        // Full-Text Search via Backend FTS5 API
        const res = await api.listMemos({
          workspaceId: activeWs.id,
          search: query,
          limit: 100,
        });

        const searchResults = (res && res.memos) || [];
        renderMemos(searchResults, `Search results for "${query}" (${searchResults.length})`);
      } catch (err) {
        console.error('Search error:', err);
        showToast('Full-text search failed', 'error');
      }
    }, 250);
  });
}

function closeMobileSidebar() { document.getElementById('app-sidebar')?.classList.remove('open'); document.getElementById('sidebar-overlay')?.classList.remove('active'); }

function setFilter(type, value = null) {
  state.set('activeFilter', { type, value });

  // Update active sidebar item
  document.querySelectorAll('.app-sidebar .sidebar-nav-item').forEach((item) => {
    item.classList.remove('active');
  });

  const filterToNavId = {
    all: 'side-nav-all',
    favorites: 'side-nav-favorites',
    pinned: 'side-nav-pinned',
    dueSoon: 'side-nav-due-soon',
    trash: 'side-nav-trash',
    dashboard: 'side-nav-dashboard',
  };

  const activeNavId = filterToNavId[type];
  if (activeNavId) {
    document.getElementById(activeNavId)?.classList.add('active');
  } else if (type === 'folder' && value) {
    document.getElementById(`side-nav-folder-${value}`)?.classList.add('active');
  }

  // Clear global search input if switching filters
  const searchInput = document.getElementById('global-search-input');
  if (searchInput && state.get('searchQuery')) {
    searchInput.value = '';
    state.set('searchQuery', '');
  }

  filterAndRenderMemos();
  closeMobileSidebar();
}

async function filterAndRenderMemos() {
  const filter = state.get('activeFilter') || { type: 'all', value: null };
  const allMemos = state.get('allWorkspaceMemos') || [];
  const statusFilter = document.getElementById('filter-status-select')?.value || '';
  const priorityFilter = document.getElementById('filter-priority-select')?.value || '';
  const sortOrder = document.getElementById('sort-memos-select')?.value || 'updatedAt:desc';

  let filtered = [];
  let filterHeading = 'All Memos';
  let bannerText = '';

  if (filter.type === 'trash') {
    filterHeading = 'Trash';
    bannerText = 'Showing items in Trash. Deleted memos can be restored or permanently removed.';

    // Fetch deleted items from server with includeDeleted=true
    const activeWs = state.get('activeWorkspace');
    if (activeWs && activeWs.id) {
      try {
        const res = await api.listMemos({ workspaceId: activeWs.id, includeDeleted: true, limit: 100 });
        filtered = (res.memos || []).filter((m) => m.deletedAt !== null);
      } catch {
        filtered = [];
      }
    }
  } else {
    // Normal active memos
    let base = allMemos.filter((m) => !m.deletedAt);

    if (filter.type === 'favorites') {
      base = base.filter((m) => m.isFavorite);
      filterHeading = 'Favorites';
      bannerText = 'Filtered by Favorites';
    } else if (filter.type === 'pinned') {
      base = base.filter((m) => m.isPinned);
      filterHeading = 'Pinned Memos';
      bannerText = 'Filtered by Pinned Memos';
    } else if (filter.type === 'dueSoon') {
      const now = Date.now();
      const nextWeek = now + 7 * 86400000;
      base = base.filter((m) => m.dueDate && Number(m.dueDate) <= nextWeek && (m.status || '').toLowerCase() !== 'completed');
      filterHeading = 'Upcoming & Overdue';
      bannerText = 'Memos that are overdue or due within the next 7 days';
    } else if (filter.type === 'dueDate' && filter.value) {
      const { start, end, label } = filter.value;
      base = base.filter((m) => m.dueDate && Number(m.dueDate) >= start && Number(m.dueDate) < end);
      filterHeading = `Due on ${label}`;
      bannerText = `Memos scheduled for ${label}`;
    } else if (filter.type === 'category' && filter.value) {
      base = base.filter((m) => (m.categoryId === filter.value) || (m.category && m.category.id === filter.value) || (m.category && m.category.name === filter.value));
      filterHeading = `Category: ${filter.value}`;
      bannerText = `Filtered by Category: ${filter.value}`;
    } else if (filter.type === 'tag' && filter.value) {
      const selectedTag = String(filter.value).trim().replace(/^#/, '').toLocaleLowerCase();
      base = base.filter((m) => Array.isArray(m.tags) && m.tags.some((tag) => String(tag).trim().replace(/^#/, '').toLocaleLowerCase() === selectedTag));
      filterHeading = `Label: #${selectedTag}`;
      bannerText = `Showing notes labeled #${selectedTag}`;
    } else if (filter.type === 'folder' && filter.value) {
      base = base.filter((memo) => memo.folderId === filter.value);
      const folder = (state.get('folders') || []).find((item) => item.id === filter.value);
      filterHeading = `Folder: ${folder?.name || 'Unknown'}`;
      bannerText = `Filtered by Folder: ${folder?.name || 'Unknown'}`;
    } else if (filter.type === 'dashboard') {
      filterHeading = 'Recent Memos';
      bannerText = '';
    }

    filtered = base;
  }

  // Secondary Filters (Status & Priority)
  if (statusFilter) {
    filtered = filtered.filter((m) => (m.status || '').toLowerCase() === statusFilter.toLowerCase());
  }
  if (priorityFilter) {
    filtered = filtered.filter((m) => (m.priority || '').toLowerCase() === priorityFilter.toLowerCase());
  }

  // Sort Memos
  const [sortField, sortDirection] = sortOrder.split(':');
  filtered.sort((a, b) => {
    let valA = a[sortField];
    let valB = b[sortField];

    if (sortField === 'title') {
      valA = (a.title || '').toLowerCase();
      valB = (b.title || '').toLowerCase();
      return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    if (sortField === 'dueDate') {
      // Undated notes stay at the end in either direction.
      const aMissing = !a.dueDate;
      const bMissing = !b.dueDate;
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      valA = Number(a.dueDate || 0);
      valB = Number(b.dueDate || 0);
      return sortDirection === 'asc' ? valA - valB : valB - valA;
    }
    if (sortField === 'createdAt') {
      valA = Number(a.createdAt || 0);
      valB = Number(b.createdAt || 0);
      return sortDirection === 'asc' ? valA - valB : valB - valA;
    }
    if (sortField === 'priority') {
      const order = { urgent: 4, high: 3, medium: 2, low: 1 };
      valA = order[(a.priority || '').toLowerCase()] || 0;
      valB = order[(b.priority || '').toLowerCase()] || 0;
      return sortDirection === 'asc' ? valA - valB : valB - valA;
    }
    // Default: date/timestamps
    valA = a.updatedAt || a.createdAt || 0;
    valB = b.updatedAt || b.createdAt || 0;
    return sortDirection === 'asc' ? valA - valB : valB - valA;
  });

  renderMemos(filtered, filterHeading, bannerText);
}

// ==========================================================================
// Memos Rendering (List and Card Grid Views)
// ==========================================================================
function renderMemos(memoList, customHeading = null, bannerMessage = null) {
  const gridContainer = document.getElementById('memos-grid-container');
  const listContainer = document.getElementById('recent-memos-list');
  const headingEl = document.getElementById('memos-view-heading');
  const countEl = document.getElementById('memos-count-indicator');
  const emptyStateEl = document.getElementById('memos-empty-state');
  const activeFilterBanner = document.getElementById('active-filter-banner');
  const activeFilterText = document.getElementById('active-filter-text');

  const viewMode = 'grid';
  const filter = state.get('activeFilter') || { type: 'all' };
  const isTrash = filter.type === 'trash';

  if (headingEl && customHeading) {
    headingEl.textContent = customHeading;
  }
  if (countEl) {
    countEl.textContent = `Showing ${memoList.length} memo${memoList.length === 1 ? '' : 's'}`;
  }

  // Active filter banner
  if (activeFilterBanner && activeFilterText) {
    if (bannerMessage) {
      activeFilterBanner.style.display = 'flex';
      activeFilterText.textContent = bannerMessage;
    } else {
      activeFilterBanner.style.display = 'none';
    }
  }

  // Empty state handling
  if (memoList.length === 0) {
    if (gridContainer) gridContainer.style.display = 'none';
    if (listContainer) listContainer.style.display = 'none';
    if (emptyStateEl) {
      emptyStateEl.style.display = 'block';
      const emptyTitle = document.getElementById('empty-state-title');
      const emptyDesc = document.getElementById('empty-state-desc');
      const emptyBtn = document.getElementById('empty-state-action-btn');

      if (isTrash) {
        if (emptyTitle) emptyTitle.textContent = 'Trash is empty';
        if (emptyDesc) emptyDesc.textContent = 'No deleted memos in this workspace.';
        if (emptyBtn) emptyBtn.style.display = 'none';
      } else {
        if (emptyTitle) emptyTitle.textContent = 'No memos match your criteria';
        if (emptyDesc) emptyDesc.textContent = 'Create a new memo or clear your filters to see more.';
        if (emptyBtn) {
          emptyBtn.style.display = 'inline-flex';
          emptyBtn.textContent = '+ Create Memo';
        }
      }
    }
    return;
  }

  if (emptyStateEl) emptyStateEl.style.display = 'none';

  // Toggle View Containers
  if (viewMode === 'grid') {
    if (gridContainer) gridContainer.style.display = 'grid';
    if (listContainer) listContainer.style.display = 'none';
    renderCardGridView(memoList, gridContainer, isTrash);
  } else {
    if (gridContainer) gridContainer.style.display = 'none';
    if (listContainer) listContainer.style.display = 'flex';
    renderListView(memoList, listContainer, isTrash);
  }
}

function renderCardGridView(memos, container, isTrash, skipPinnedGrouping = false) {
  // In the main notes view, pinned notes get their own section instead of being
  // mixed into the ordinary stream. Explicit Pinned/Trash filters stay focused.
  if (!skipPinnedGrouping && !isTrash && (state.get('activeFilter')?.type || 'all') !== 'pinned') {
    const pinned = memos.filter((memo) => memo.isPinned);
    const regular = memos.filter((memo) => !memo.isPinned);
    if (pinned.length && regular.length) {
      container.innerHTML = '<section class="memo-section memo-pinned-section"><h4 class="memo-section-heading"><span aria-hidden="true">📌</span> Pinned</h4><div class="memo-section-grid" id="pinned-memo-grid"></div></section><section class="memo-section memo-regular-section"><h4 class="memo-section-heading">Others</h4><div class="memo-section-grid" id="regular-memo-grid"></div></section>';
      renderCardGridView(pinned, container.querySelector('#pinned-memo-grid'), isTrash, true);
      renderCardGridView(regular, container.querySelector('#regular-memo-grid'), isTrash, true);
      return;
    }
    if (pinned.length && !regular.length) {
      container.innerHTML = '<section class="memo-section memo-pinned-section"><h4 class="memo-section-heading"><span aria-hidden="true">📌</span> Pinned</h4><div class="memo-section-grid" id="pinned-memo-grid"></div></section>';
      renderCardGridView(pinned, container.querySelector('#pinned-memo-grid'), isTrash, true);
      return;
    }
  }
  container.innerHTML = memos.map((memo) => {
    const categoryName = memo.category?.name || memo.category || 'General';
    const priority = (memo.priority || 'medium').toLowerCase();
    const status = (memo.status || 'pending').toLowerCase();
    const isPinned = !!memo.isPinned;
    const isFavorite = !!memo.isFavorite;

    // Checklists progress
    const checklistStats = extractChecklistStats(memo.content);
    let checklistHtml = '';
    if (checklistStats && checklistStats.total > 0) {
      checklistHtml = `
        <div class="memo-card-checklist-stats">
          <span>✓ ${checklistStats.completed}/${checklistStats.total} done</span>
          <div class="memo-card-progress-bar">
            <div class="memo-card-progress-fill" style="width: ${checklistStats.percentage}%;"></div>
          </div>
        </div>
      `;
    }

    // Tags chips
    const tagsHtml = (memo.tags || []).map((t) => `
      <span class="tag-chip" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>
    `).join('');

    // Due date badge
    let dueHtml = '';
    if (memo.dueDate) {
      const dueDateObj = new Date(memo.dueDate);
      const isOverdue = dueDateObj.getTime() < Date.now() && status !== 'completed';
      const formattedDate = dueDateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      dueHtml = `
        <span class="badge ${isOverdue ? 'badge-overdue' : 'badge-due-soon'}">
          🕒 ${formattedDate}
        </span>
      `;
    }

    const memoColor = ['default','red','orange','yellow','green','teal','blue','darkblue','purple','pink'].includes(memo.color) ? memo.color : 'default';
    const palette = ['default','red','orange','yellow','green','teal','blue','darkblue','purple','pink'];
    const colorPickerHtml = !isTrash ? `<div class="memo-card-color-picker" role="group" aria-label="Note color">${palette.map((color) => `<button type="button" class="memo-color-swatch ${memoColor === color ? 'selected' : ''}" data-action="color" data-id="${memo.id}" data-color="${color}" title="${color === 'default' ? 'Default color' : color}" aria-label="Set note color to ${color}" aria-pressed="${memoColor === color}"></button>`).join('')}</div>` : '';

    return `
      <div class="memo-card memo-color-${memoColor} ${isPinned ? 'pinned' : ''}" data-memo-id="${memo.id}">
        <div class="memo-card-header">
          <span class="badge badge-${categoryName.toLowerCase()}">${escapeHtml(categoryName)}</span>
          <div class="memo-card-actions-quick" onclick="event.stopPropagation();">
            ${!isTrash ? `
              <button class="memo-action-icon-btn ${isPinned ? 'pinned-active' : ''}" title="${isPinned ? 'Unpin' : 'Pin'}" data-action="pin" data-id="${memo.id}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-2l-3-3V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v7l-3 3v2z"></path></svg>
              </button>
              <button class="memo-action-icon-btn ${isFavorite ? 'active' : ''}" title="${isFavorite ? 'Unfavorite' : 'Favorite'}" data-action="fav" data-id="${memo.id}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="${isFavorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
              </button>
            ` : ''}
          </div>
        </div>

        <h4 class="memo-card-title">${escapeHtml(memo.title || 'Untitled Memo')}</h4>
        <div class="memo-card-snippet">${escapeHtml((memo.snippet || memo.content || '').slice(0, 140))}</div>

        ${checklistHtml}

        <div class="memo-card-tags" onclick="event.stopPropagation();">
          ${tagsHtml}
        </div>
        ${colorPickerHtml}

        <div class="memo-card-footer">
          <div class="memo-card-meta-badges">
            <span class="badge badge-priority-${priority}">${escapeHtml(priority)}</span>
            <span class="badge badge-status-${status}">${escapeHtml(status.replace('_', ' '))}</span>
            ${dueHtml}
          </div>

          <div class="memo-card-actions" onclick="event.stopPropagation();">
            ${isTrash ? `
              <button class="btn btn-outline btn-sm" data-action="restore" data-id="${memo.id}" title="Restore Memo">Restore</button>
              <button class="btn btn-sm" style="color: var(--color-red); border: 1px solid var(--color-red);" data-action="perm-delete" data-id="${memo.id}" title="Delete Permanently">Delete</button>
            ` : `
              <button class="memo-action-icon-btn" data-action="edit" data-id="${memo.id}" title="Edit Memo">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
              </button>
              <button class="memo-action-icon-btn" data-action="trash" data-id="${memo.id}" title="Move to Trash" style="color: var(--color-red);">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
              </button>
            `}
          </div>
        </div>
      </div>
    `;
  }).join('');

  attachMemoItemInteractions(container, memos);
}

function renderListView(memos, container, isTrash) {
  const filterType = state.get('activeFilter')?.type || 'all';
  if (!isTrash && filterType !== 'pinned') {
    const pinned = memos.filter((memo) => memo.isPinned);
    const regular = memos.filter((memo) => !memo.isPinned);
    if (pinned.length && regular.length) {
      container.innerHTML = '<div class="memo-list-section-heading">📌 Pinned</div><div id="pinned-memo-list"></div><div class="memo-list-section-heading">Others</div><div id="regular-memo-list"></div>';
      renderListView(pinned, container.querySelector('#pinned-memo-list'), isTrash);
      renderListView(regular, container.querySelector('#regular-memo-list'), isTrash);
      return;
    }
    if (pinned.length && !regular.length) {
      container.innerHTML = '<div class="memo-list-section-heading">📌 Pinned</div><div id="pinned-memo-list"></div>';
      renderListView(pinned, container.querySelector('#pinned-memo-list'), isTrash);
      return;
    }
  }
  container.innerHTML = memos.map((memo) => {
    const categoryName = memo.category?.name || memo.category || 'General';
    const priority = (memo.priority || 'medium').toLowerCase();
    const status = (memo.status || 'pending').toLowerCase();
    const isPinned = !!memo.isPinned;
    const isFavorite = !!memo.isFavorite;

    return `
      <div class="memo-row-item" data-memo-id="${memo.id}">
        <div class="memo-row-main">
          <div class="memo-item-icon-box" style="background-color: var(--color-primary-50); color: var(--color-primary-600);">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
              <polyline points="14 2 14 8 20 8"></polyline>
              <line x1="16" y1="13" x2="8" y2="13"></line>
              <line x1="16" y1="17" x2="8" y2="17"></line>
            </svg>
          </div>
          <div class="memo-row-text">
            <span class="memo-row-title">
              ${isPinned ? '📌 ' : ''}${escapeHtml(memo.title || 'Untitled Memo')}
            </span>
            <span class="memo-row-snippet">${escapeHtml((memo.snippet || memo.content || '').slice(0, 90))}</span>
          </div>
        </div>

        <div class="memo-row-meta" onclick="event.stopPropagation();">
          <span class="badge badge-${categoryName.toLowerCase()}">${escapeHtml(categoryName)}</span>
          <span class="badge badge-priority-${priority}">${escapeHtml(priority)}</span>
          <span class="badge badge-status-${status}">${escapeHtml(status.replace('_', ' '))}</span>

          ${!isTrash ? `
            <button class="memo-action-icon-btn ${isFavorite ? 'active' : ''}" data-action="fav" data-id="${memo.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFavorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            </button>
            <button class="memo-action-icon-btn" data-action="trash" data-id="${memo.id}" title="Trash" style="color: var(--color-red);">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          ` : `
            <button class="btn btn-outline btn-sm" data-action="restore" data-id="${memo.id}">Restore</button>
            <button class="btn btn-sm" style="color: var(--color-red);" data-action="perm-delete" data-id="${memo.id}">Delete</button>
          `}
        </div>
      </div>
    `;
  }).join('');

  attachMemoItemInteractions(container, memos);
}

function attachMemoItemInteractions(container, memos) {
  // Click on card/row opens editor
  container.querySelectorAll('[data-memo-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-memo-id');
      const memo = memos.find((m) => m.id === id);
      if (memo) {
        navigateTo('editor', { memo });
      }
    });
  });

  // Clicking a label on a note filters the grid by that label instead of opening the editor.
  container.querySelectorAll('.tag-chip[data-tag]').forEach((chip) => chip.addEventListener('click', (event) => {
    event.stopPropagation();
    setFilter('tag', chip.getAttribute('data-tag'));
  }));

  // Action button clicks
  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      const memo = memos.find((m) => m.id === id);
      if (!memo) return;

      if (action === 'edit') {
        navigateTo('editor', { memo });
      } else if (action === 'color') {
        const color = btn.getAttribute('data-color') || 'default';
        try {
          const result = await api.updateMemo(memo.id, { color, version: memo.version });
          Object.assign(memo, result.memo);
          showToast('Note color updated', 'success', 1200);
          await refreshWorkspaceMemos();
        } catch (error) {
          showToast(error.message || 'Could not update note color', 'error');
        }
      } else if (action === 'fav') {
        try {
          await api.updateMemo(memo.id, { isFavorite: !memo.isFavorite, version: memo.version });
          memo.isFavorite = !memo.isFavorite;
          memo.version = (memo.version || 1) + 1;
          showToast(memo.isFavorite ? 'Added to favorites' : 'Removed from favorites', 'info', 1500);
          refreshWorkspaceMemos();
        } catch {
          showToast('Failed to toggle favorite', 'error');
        }
      } else if (action === 'pin') {
        try {
          await api.updateMemo(memo.id, { isPinned: !memo.isPinned, version: memo.version });
          memo.isPinned = !memo.isPinned;
          memo.version = (memo.version || 1) + 1;
          showToast(memo.isPinned ? 'Memo pinned to top' : 'Memo unpinned', 'info', 1500);
          refreshWorkspaceMemos();
        } catch {
          showToast('Failed to toggle pin', 'error');
        }
      } else if (action === 'trash') {
        try {
          await api.deleteMemo(memo.id, false);
          showToast('Memo moved to Trash', 'info', 2500);
          refreshWorkspaceMemos();
        } catch {
          showToast('Failed to move memo to trash', 'error');
        }
      } else if (action === 'restore') {
        try {
          await api.restoreMemo(memo.id);
          showToast('Memo restored from Trash', 'success', 2000);
          refreshWorkspaceMemos();
        } catch {
          showToast('Failed to restore memo', 'error');
        }
      } else if (action === 'perm-delete') {
        showConfirmDialog('Delete Memo Permanently', 'This action cannot be undone. Are you sure you want to permanently delete this memo?', async () => {
          try {
            await api.deleteMemo(memo.id, true);
            showToast('Memo permanently deleted', 'info', 2000);
            refreshWorkspaceMemos();
          } catch {
            showToast('Failed to permanently delete memo', 'error');
          }
        });
      }
    });
  });

  // Tag chip clicks filter by tag
  container.querySelectorAll('.tag-chip').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const tagName = chip.getAttribute('data-tag');
      if (tagName) {
        setFilter('tag', tagName);
      }
    });
  });
}

// ==========================================================================
// Memo Editor Controller (system-design.md §4.4)
// ==========================================================================
function loadMemoIntoEditor(memo) {
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

  // Populate Categories in Select
  populateCategorySelect(memo.categoryId || memo.category?.id || memo.category);
  populateFolderSelect(memo.folderId || memo.folder_id || '');

  if (prioritySelect) prioritySelect.value = (memo.priority || 'medium').toLowerCase();
  if (statusSelect) statusSelect.value = (memo.status || 'pending').toLowerCase();

  // Due Date (Format: YYYY-MM-DD)
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

  // Toggle buttons visual state
  if (favBtn) {
    favBtn.classList.toggle('active', !!memo.isFavorite);
    favBtn.querySelector('svg').setAttribute('fill', memo.isFavorite ? 'currentColor' : 'none');
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

function populateCategorySelect(selectedCategoryId = '') {
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

function populateFolderSelect(selectedFolderId = '') {
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

function setEditorTab(tabName) {
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

function updateMarkdownLivePreview() {
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

  // Interactive Checkbox clicking inside Preview canvas updates markdown text
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

function renderEditorTags(tags) {
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

async function saveActiveMemo(options = {}) {
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
  const saveIndicator = document.getElementById('editor-save-indicator');
  const conflictAlert = document.getElementById('editor-conflict-alert');

  const activeMemo = state.get('activeMemo') || {};

  const title = titleInput?.value.trim() || 'Untitled Memo';
  const content = bodyTextarea?.value || '';
  // Do not re-copy desktop values here: on phones the mobile controls are authoritative.
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
      // Avoid writing a new revision when an autosave snapshot has no changes.
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
      // Optimistic concurrency update PATCH /api/v1/memos/:id
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
      // Create new memo POST /api/v1/memos
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

    await refreshWorkspaceMemos();
  } catch (err) {
    console.error('Error saving memo:', err);
    editorHasUnsavedChanges = true;
    setEditorSaveState('Save failed. Retry required.', 'error');
    if (!quiet) showToast(err.message || 'Failed to save memo', 'error', 5000);
    if (err.status === 409) {
      // Concurrency Conflict Detected (§4.4)
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

// ==========================================================================
// Local Data Migration & Backup Controller (system-design.md §4.6)
// ==========================================================================
let detectedMigrationPayload = null;
let parsedMigrationPayload = null;

function initMigrationModal() {
  const modal = document.getElementById('modal-migration');
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
      a.download = `memo-manager-backup-${(activeWs.name || 'workspace').toLowerCase()}-${Date.now()}.json`;
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

function checkLocalStorageForLegacyData() {
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
    } catch {
      // Ignore unparseable keys
    }
  }

  if (foundMemos.length > 0) {
    detectedMigrationPayload = { memos: foundMemos };
    if (title) title.textContent = `Found ${foundMemos.length} legacy memo${foundMemos.length === 1 ? '' : 's'} in browser storage`;
    if (desc) desc.textContent = 'Migrate your single-user client data into this cloud workspace.';
    if (importBtn) importBtn.style.display = 'inline-flex';
  } else {
    detectedMigrationPayload = null;
    if (title) title.textContent = 'No legacy browser data found';
    if (desc) desc.textContent = 'Upload a JSON backup file below or paste raw memo JSON.';
    if (importBtn) importBtn.style.display = 'none';
  }
}

function handleJsonFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      const jsonTextarea = document.getElementById('mig-json-textarea');
      if (jsonTextarea) jsonTextarea.value = JSON.stringify(parsed, null, 2);
      updateMigrationPreview(parsed);
      showToast(`Loaded ${file.name}`, 'info', 1500);
    } catch {
      showToast('Invalid JSON file. Please check syntax.', 'error');
      updateMigrationPreview(null);
    }
  };
  reader.readAsText(file);
}

function updateMigrationPreview(payload) {
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
  if (submitBtn) submitBtn.disabled = memos.length === 0 && categories.length === 0;
}

async function executeMigrationImport(payload) {
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
    await refreshWorkspaceMemos();

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

// ==========================================================================
// Modal Windows Controller
// ==========================================================================
function openModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('active');
}

function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('active');
}

function showConfirmDialog(title, message, onConfirm) {
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('modal-confirm-title');
  const msgEl = document.getElementById('modal-confirm-msg');
  const okBtn = document.getElementById('modal-confirm-ok-btn');
  const cancelBtn = document.getElementById('modal-confirm-cancel-btn');
  const closeBtn = document.getElementById('modal-confirm-close-btn');

  if (!modal) return;
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  const handleConfirm = () => {
    cleanup();
    closeModal('modal-confirm');
    onConfirm();
  };

  const handleCancel = () => {
    cleanup();
    closeModal('modal-confirm');
  };

  const cleanup = () => {
    okBtn?.removeEventListener('click', handleConfirm);
    cancelBtn?.removeEventListener('click', handleCancel);
    closeBtn?.removeEventListener('click', handleCancel);
  };

  okBtn?.addEventListener('click', handleConfirm);
  cancelBtn?.addEventListener('click', handleCancel);
  closeBtn?.addEventListener('click', handleCancel);

  openModal('modal-confirm');
}

// ==========================================================================
// Sidebar Dynamic Elements (Categories, Tags, Workspaces)
// ==========================================================================
function renderSidebarCategories(categories) {
  const container = document.getElementById('sidebar-categories-list');
  if (!container) return;

  const cats = categories || [];
  const allMemos = state.get('allWorkspaceMemos') || [];
  const activeFilter = state.get('activeFilter') || {};

  container.innerHTML = cats.map((cat) => {
    const count = allMemos.filter((m) => !m.deletedAt && ((m.categoryId === cat.id) || (m.category?.id === cat.id) || (m.category?.name === cat.name))).length;
    const isActive = activeFilter.type === 'category' && (activeFilter.value === cat.name || activeFilter.value === cat.id);
    const color = cat.color || '#3b82f6';

    return `
      <div class="workspace-item ${isActive ? 'active' : ''}" data-category-name="${escapeHtml(cat.name)}" data-category-id="${cat.id}">
        <div class="workspace-item-info">
          <span class="workspace-bullet" style="background-color: ${color};"></span>
          <span class="ws-item-name">${escapeHtml(cat.name)}</span>
        </div>
        <span style="font-size: 0.7rem; color: var(--text-muted);">${count}</span>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.workspace-item').forEach((el) => {
    el.addEventListener('click', () => {
      const catName = el.getAttribute('data-category-name');
      setFilter('category', catName);
    });
  });
}

function renderSidebarTags(tags) {
  const container = document.getElementById('sidebar-tags-list');
  if (!container) return;

  const tagList = tags || [];
  const allMemos = state.get('allWorkspaceMemos') || [];
  const activeFilter = state.get('activeFilter') || {};

  if (tagList.length === 0) {
    container.innerHTML = `<span style="font-size: 0.75rem; color: var(--text-muted); padding: 0.25rem 0.5rem;">No tags yet</span>`;
    return;
  }

  container.innerHTML = tagList.map((tag) => {
    const tagName = tag.name || tag;
    const count = allMemos.filter((m) => !m.deletedAt && Array.isArray(m.tags) && m.tags.some((item) => String(item).trim().replace(/^#/, '').toLowerCase() === String(tagName).trim().replace(/^#/, '').toLowerCase())).length;
    const isActive = activeFilter.type === 'tag' && activeFilter.value === tagName;

    return `
      <div class="workspace-item ${isActive ? 'active' : ''}" data-tag-name="${escapeHtml(tagName)}" data-tag-id="${tag.id || ''}">
        <button type="button" class="tag-filter-trigger" data-tag-filter="${escapeHtml(tagName)}" aria-label="Filter notes by ${escapeHtml(tagName)}"><span>#</span><span class="ws-item-name">${escapeHtml(tagName)}</span><span class="tag-count">${count}</span></button>
        ${tag.id ? `<span class="tag-management-actions"><button type="button" data-tag-edit="${tag.id}" aria-label="Rename ${escapeHtml(tagName)}" title="Rename label">✎</button><button type="button" data-tag-delete="${tag.id}" aria-label="Delete ${escapeHtml(tagName)}" title="Delete label">×</button></span>` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-tag-filter]').forEach((el) => el.addEventListener('click', (event) => { event.stopPropagation(); setFilter('tag', el.dataset.tagFilter); closeMobileSidebar(); }));
  container.querySelectorAll('[data-tag-edit]').forEach((el) => el.addEventListener('click', async (event) => {
    event.stopPropagation(); const tag = tagList.find((item) => item.id === el.dataset.tagEdit); if (!tag) return;
    const value = window.prompt('Rename label', tag.name); if (value === null) return;
    const name = value.trim().replace(/^[#\s]+/, '').toLowerCase(); if (!name) return showToast('Label name is required', 'error');
    try { await api.updateTag(tag.id, { workspaceId: state.get('activeWorkspace')?.id, name }); if (state.get('activeFilter')?.type === 'tag' && state.get('activeFilter')?.value === tag.name) state.set('activeFilter', {type:'tag',value:name}); await refreshWorkspaceMemos(); showToast('Label renamed','success'); }
    catch (error) { showToast(error.message || 'Unable to rename label','error'); }
  }));
  container.querySelectorAll('[data-tag-delete]').forEach((el) => el.addEventListener('click', async (event) => {
    event.stopPropagation(); const tag = tagList.find((item) => item.id === el.dataset.tagDelete); if (!tag || !window.confirm('Delete label #' + tag.name + '?')) return;
    try { await api.deleteTag(tag.id, state.get('activeWorkspace')?.id); if (state.get('activeFilter')?.type === 'tag' && state.get('activeFilter')?.value === tag.name) setFilter('all'); await refreshWorkspaceMemos(); showToast('Label deleted','success'); }
    catch (error) { showToast(error.message || 'Unable to delete label','error'); }
  }));
}

function renderSidebarFolders(folders) {
  const container = document.getElementById('sidebar-folders-list');
  if (!container) return;

  const folderList = folders || [];
  const allMemos = state.get('allWorkspaceMemos') || [];
  const activeFilter = state.get('activeFilter') || {};

  if (folderList.length === 0) {
    container.innerHTML = '<span style="font-size: 0.75rem; color: var(--text-muted); padding: 0.25rem 0.5rem;">No folders yet</span>';
    return;
  }

  container.innerHTML = folderList.map((folder) => {
    const count = allMemos.filter((memo) => !memo.deletedAt && memo.folderId === folder.id).length;
    const isActive = activeFilter.type === 'folder' && activeFilter.value === folder.id;
    return `
      <div class="workspace-item ${isActive ? 'active' : ''}" id="side-nav-folder-${escapeHtml(folder.id)}" data-folder-id="${escapeHtml(folder.id)}">
        <div class="workspace-item-info">
          <span style="color: var(--text-muted); font-size: 0.8rem;">📁</span>
          <span class="ws-item-name">${escapeHtml(folder.name)}</span>
        </div>
        <span style="font-size: 0.7rem; color: var(--text-muted);">${count}</span>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-folder-id]').forEach((item) => {
    item.addEventListener('click', () => setFilter('folder', item.getAttribute('data-folder-id')));
  });
}

function renderWorkspacesList(workspaces) {
  const container = document.getElementById('sidebar-workspace-list');
  if (!container || !workspaces || !workspaces.length) return;

  const activeWs = state.get('activeWorkspace');

  container.innerHTML = workspaces.map((ws) => {
    const isActive = activeWs && activeWs.id === ws.id;
    return `
      <div class="workspace-item ${isActive ? 'active' : ''}" data-workspace-id="${ws.id}">
        <div class="workspace-item-info">
          <span class="workspace-bullet"></span>
          <span class="ws-item-name">${escapeHtml(ws.name)}</span>
        </div>
        <svg class="workspace-check-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.workspace-item').forEach((item) => {
    item.addEventListener('click', async () => {
      const wsId = item.getAttribute('data-workspace-id');
      const targetWs = workspaces.find((w) => w.id === wsId);
      if (targetWs) {
        state.set('activeWorkspace', targetWs);
        renderWorkspacesList(workspaces);
        showToast(`Switched to workspace: ${targetWs.name}`, 'info', 2000);
        await refreshWorkspaceMemos();
      }
    });
  });
}

// ==========================================================================
 // Interactive Mini-Calendar & Upcoming Reminders
 // ==========================================================================
let currentCalYear = new Date().getFullYear();
let currentCalMonth = new Date().getMonth();

function formatReminderDate(timestamp) {
  const date = new Date(Number(timestamp));
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const dueDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (dueDay.getTime() === new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) {
    return `Today, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (dueDay.getTime() === tomorrow.getTime()) {
    return `Tomorrow, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  return date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderUpcomingReminders() {
  const container = document.getElementById('upcoming-reminders-list');
  if (!container) return;
  const now = Date.now();
  const nextWeek = now + 7 * 86400000;
  const reminders = (state.get('allWorkspaceMemos') || [])
    .filter((memo) => !memo.deletedAt && memo.dueDate && Number(memo.dueDate) <= nextWeek && (memo.status || '').toLowerCase() !== 'completed')
    .sort((a, b) => Number(a.dueDate) - Number(b.dueDate))
    .slice(0, 6);
  container.replaceChildren();
  if (!reminders.length) {
    const empty = document.createElement('div');
    empty.className = 'reminders-empty-state';
    empty.textContent = 'No upcoming reminders. Add a due date to any memo to see it here.';
    container.append(empty);
    return;
  }
  for (const memo of reminders) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'reminder-item';
    item.setAttribute('data-reminder-memo-id', memo.id);
    const icon = document.createElement('span');
    icon.className = 'reminder-icon-box';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = Number(memo.dueDate) < now ? '!' : '◷';
    const info = document.createElement('span');
    info.className = 'reminder-info';
    const title = document.createElement('span');
    title.className = 'reminder-title';
    title.textContent = memo.title || 'Untitled memo';
    const time = document.createElement('span');
    time.className = 'reminder-time';
    time.textContent = Number(memo.dueDate) < now ? `Overdue · ${formatReminderDate(memo.dueDate)}` : formatReminderDate(memo.dueDate);
    info.append(title, time);
    item.append(icon, info);
    item.addEventListener('click', () => navigateTo('editor', { memo }));
    container.append(item);
  }
}

function renderInteractiveCalendar(year, month) {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const titleEl = document.getElementById('calendar-month-title');
  if (titleEl) titleEl.textContent = `${monthNames[month]} ${year}`;
  const grid = document.getElementById('calendar-grid');
  if (!grid) return;
  grid.querySelectorAll('.calendar-day-num').forEach((el) => el.remove());

  const dueByDay = new Map();
  for (const memo of (state.get('allWorkspaceMemos') || [])) {
    if (memo.deletedAt || !memo.dueDate || (memo.status || '').toLowerCase() === 'completed') continue;
    const due = new Date(Number(memo.dueDate));
    const key = `${due.getFullYear()}-${due.getMonth()}-${due.getDate()}`;
    dueByDay.set(key, (dueByDay.get(key) || 0) + 1);
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  for (let i = firstDay - 1; i >= 0; i--) {
    const dayEl = document.createElement('div');
    dayEl.className = 'calendar-day-num other-month';
    dayEl.textContent = daysInPrevMonth - i;
    dayEl.setAttribute('aria-hidden', 'true');
    grid.appendChild(dayEl);
  }

  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const dayEl = document.createElement('button');
    dayEl.type = 'button';
    dayEl.className = 'calendar-day-num';
    dayEl.textContent = day;
    dayEl.setAttribute('aria-label', `${monthNames[month]} ${day}, ${year}`);
    if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) dayEl.classList.add('today');
    const key = `${year}-${month}-${day}`;
    const dueCount = dueByDay.get(key) || 0;
    if (dueCount) {
      dayEl.classList.add('has-due-memos');
      dayEl.title = `${dueCount} memo${dueCount === 1 ? '' : 's'} due`;
      dayEl.dataset.dueCount = String(dueCount);
    }
    dayEl.addEventListener('click', () => {
      grid.querySelectorAll('.calendar-day-num').forEach((el) => el.classList.remove('active'));
      dayEl.classList.add('active');
      const start = new Date(year, month, day).getTime();
      const end = new Date(year, month, day + 1).getTime();
      setFilter('dueDate', { start, end, label: `${monthNames[month]} ${day}, ${year}` });
      document.getElementById('memos-view-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    grid.appendChild(dayEl);
  }
  const trailing = (7 - ((firstDay + daysInMonth) % 7)) % 7;
  for (let day = 1; day <= trailing; day++) {
    const dayEl = document.createElement('div');
    dayEl.className = 'calendar-day-num other-month';
    dayEl.textContent = day;
    dayEl.setAttribute('aria-hidden', 'true');
    grid.appendChild(dayEl);
  }
}

// ==========================================================================
// Setup Event Listeners & UI Bootstrap
// ==========================================================================
function setupEventListeners() {
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
    navigateTo('dashboard');
    showToast('Viewing dashboard preview', 'info', 2000);
  });
  document.getElementById('bottom-cta-btn')?.addEventListener('click', () => navigateTo('auth', { mode: 'register' }));

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

  // OAuth providers are visual placeholders until provider credentials and callback routes are configured.
  ['social-google-btn', 'social-apple-btn', 'social-github-btn'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', () => {
      showToast('Social sign-in is not enabled yet. Please use email and password.', 'info', 3500);
    });
  });

  document.getElementById('auth-forgot-link')?.addEventListener('click', (event) => {
    event.preventDefault();
    showToast('Password recovery is not available yet. Please contact the application administrator.', 'info', 4500);
  });

  document.getElementById('nav-notifications-btn')?.addEventListener('click', () => {
    const upcoming = (state.get('allWorkspaceMemos') || []).filter((memo) => !memo.deletedAt && memo.dueDate && (memo.status || '').toLowerCase() !== 'completed' && Number(memo.dueDate) <= Date.now() + 7 * 86400000);
    setFilter('dueSoon');
    if (!upcoming.length) showToast('No overdue or upcoming memos. Add a due date to a memo to create a reminder.', 'info', 3500);
    else showToast(`${upcoming.length} overdue or upcoming memo${upcoming.length === 1 ? '' : 's'} shown.`, 'info', 2500);
  });

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

  // Sidebar Filter Links
  document.getElementById('side-nav-dashboard')?.addEventListener('click', () => setFilter('dashboard'));
  document.getElementById('side-nav-all')?.addEventListener('click', () => setFilter('all'));
  document.getElementById('side-nav-favorites')?.addEventListener('click', () => setFilter('favorites'));
  document.getElementById('side-nav-pinned')?.addEventListener('click', () => setFilter('pinned'));
  document.getElementById('side-nav-due-soon')?.addEventListener('click', () => setFilter('dueSoon'));
  document.getElementById('side-nav-calendar')?.addEventListener('click', () => {
    navigateTo('dashboard');
    document.querySelector('.calendar-widget-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.getElementById('calendar-prev-btn')?.addEventListener('click', () => {
    currentCalMonth -= 1;
    if (currentCalMonth < 0) { currentCalMonth = 11; currentCalYear -= 1; }
    renderInteractiveCalendar(currentCalYear, currentCalMonth);
  });
  document.getElementById('calendar-next-btn')?.addEventListener('click', () => {
    currentCalMonth += 1;
    if (currentCalMonth > 11) { currentCalMonth = 0; currentCalYear += 1; }
    renderInteractiveCalendar(currentCalYear, currentCalMonth);
  });
  document.querySelector('.card-link[href="#reminders"]')?.addEventListener('click', (event) => {
    event.preventDefault();
    setFilter('dueSoon');
    document.getElementById('memos-view-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.getElementById('side-nav-trash')?.addEventListener('click', () => setFilter('trash'));
  document.getElementById('recent-memos-view-all')?.addEventListener('click', () => setFilter('all'));

  // Clear Active Filter
  document.getElementById('clear-filter-btn')?.addEventListener('click', () => setFilter('all'));

  // Refresh Memos Button
  document.getElementById('dashboard-refresh-btn')?.addEventListener('click', () => {
    showToast('Refreshing workspace memos...', 'info', 1000);
    refreshWorkspaceMemos();
  });

  // Filter Selects (Status, Priority, Sort)
  document.getElementById('filter-status-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('filter-priority-select')?.addEventListener('change', () => filterAndRenderMemos());
  document.getElementById('sort-memos-select')?.addEventListener('change', () => filterAndRenderMemos());

  // View Mode Switcher (Grid vs List)
  const gridBtn = document.getElementById('view-mode-grid-btn');
  const listBtn = document.getElementById('view-mode-list-btn');
  state.set('viewMode', 'grid');
  localStorage.setItem('memo_view_mode', 'grid');

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

  // Keep-style quick capture: create a note without opening the full editor.
  const quickCaptureForm = document.getElementById('quick-capture-form');
  const quickCaptureTitle = document.getElementById('quick-capture-title');
  const quickCaptureContent = document.getElementById('quick-capture-content');
  const quickCaptureSave = document.getElementById('quick-capture-save');
  document.getElementById('quick-capture-expand')?.addEventListener('click', () => {
    const title = quickCaptureTitle?.value.trim() || '';
    const content = quickCaptureContent?.value || '';
    if (!title && !content.trim()) { quickCaptureContent?.focus(); return; }
    const categories = state.get('categories') || [];
    const requestedFolderId = state.get('activeFilter')?.type === 'folder' ? state.get('activeFilter').value : null;
    navigateTo('editor', { memo: { title, content, categoryId: categories[0]?.id || null, folderId: requestedFolderId, priority: 'medium', status: 'pending', dueDate: null, tags: [], isFavorite: false, isPinned: false } });
  });
  quickCaptureForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = quickCaptureTitle?.value.trim() || '';
    const content = quickCaptureContent?.value || '';
    if (!title && !content.trim()) { quickCaptureContent?.focus(); return; }
    const activeWs = state.get('activeWorkspace');
    if (!activeWs?.id) { showToast('Select a workspace before creating a note.', 'error'); return; }
    if (quickCaptureSave) { quickCaptureSave.disabled = true; quickCaptureSave.textContent = 'Saving…'; }
    try {
      const categories = state.get('categories') || [];
      const folderId = state.get('activeFilter')?.type === 'folder' ? state.get('activeFilter').value : null;
      const fallbackTitle = content.trim().split(/\\s+/).slice(0, 6).join(' ');
      await api.createMemo({ workspaceId: activeWs.id, title: title || fallbackTitle, content, categoryId: categories[0]?.id || null, folderId, priority: 'medium', status: 'pending', dueDate: null, tags: [], isFavorite: false, isPinned: false });
      if (quickCaptureTitle) quickCaptureTitle.value = '';
      if (quickCaptureContent) quickCaptureContent.value = '';
      await refreshWorkspaceMemos();
      showToast('Note created', 'success');
      quickCaptureContent?.focus();
    } catch (error) {
      showToast(error.message || 'Could not create note', 'error', 4500);
    } finally {
      if (quickCaptureSave) { quickCaptureSave.disabled = false; quickCaptureSave.textContent = 'Create note'; }
    }
  });

  // Create New Memo Buttons
  const createNewMemoHandler = () => {
    const activeWs = state.get('activeWorkspace');
    const categories = state.get('categories') || [];
    const defaultCat = categories.length > 0 ? categories[0].id : null;
    const requestedFolderId = state.get('activeFilter')?.type === 'folder' ? state.get('activeFilter').value : null;
    // Do not silently assign every new memo to the only folder in a workspace.
    // Keep the active folder only when the user explicitly started from that folder.
    const defaultFolderId = requestedFolderId || null;

    const newMemo = {
      title: '',
      content: '',
      categoryId: defaultCat,
      folderId: defaultFolderId,
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
  document.getElementById('empty-state-action-btn')?.addEventListener('click', createNewMemoHandler);
  document.getElementById('mob-nav-create')?.addEventListener('click', createNewMemoHandler);

  // Editor Actions
  document.getElementById('editor-back-btn')?.addEventListener('click', async () => {
    await flushEditorAutosave();
    if (!editorHasUnsavedChanges) await navigateTo('dashboard');
  });

  // Phone browser Back should behave like the editor's back arrow, never discard a draft.
  window.addEventListener('popstate', async () => {
    if (state.get('currentView') === 'editor') {
      await flushEditorAutosave();
      if (!editorHasUnsavedChanges) {
        // Replace the now-popped hash state instead of adding another Back entry.
        try { window.history.replaceState({ memoManagerDashboard: true }, '', window.location.pathname); } catch {}
        await navigateTo('dashboard');
      } else {
        // Saving failed: keep the editor state reachable from the browser's Back stack.
        try { window.history.pushState({ memoManagerEditor: true }, '', '#editor'); } catch {}
        showToast('Note not saved yet. Check your connection and try again.', 'error', 5000);
      }
    }
  });

  document.getElementById('editor-save-btn')?.addEventListener('click', () => saveActiveMemo({ quiet: false }));

  document.getElementById('editor-share-btn')?.addEventListener('click', async () => {
    // There is no server-side share token/authorization endpoint yet. Never copy a URL that does not grant access.
    showToast('Secure memo sharing is not available yet. Your memo remains private.', 'info', 4000);
  });

  document.getElementById('editor-fav-btn')?.addEventListener('click', () => {
    const memo = state.get('activeMemo');
    if (!memo) return;
    memo.isFavorite = !memo.isFavorite;
    scheduleEditorAutosave();
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
    scheduleEditorAutosave();
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
      showToast('Memo moved to Trash', 'info', 2000);
      await refreshWorkspaceMemos();
      navigateTo('dashboard');
    } catch {
      showToast('Failed to delete memo', 'error');
    }
  });

  document.getElementById('editor-conflict-reload-btn')?.addEventListener('click', async () => {
    const memo = state.get('activeMemo');
    if (!memo || !memo.id) return;
    try {
      const res = await api.getMemo(memo.id);
      if (res && res.memo) {
        loadMemoIntoEditor(res.memo);
        showToast('Loaded latest version of memo', 'info');
      }
    } catch {
      showToast('Failed to reload memo', 'error');
    }
  });

  // Editor Formatting Toolbar
  setupFormattingToolbar();

  // Editor Tab Switchers
  document.getElementById('tab-write-btn')?.addEventListener('click', () => setEditorTab('write'));
  document.getElementById('tab-preview-btn')?.addEventListener('click', () => setEditorTab('preview'));
  document.getElementById('tab-split-btn')?.addEventListener('click', () => setEditorTab('split'));

  // Due Date Clear Button
  document.getElementById('memo-due-date-clear-btn')?.addEventListener('click', () => {
    const input = document.getElementById('memo-due-date-input');
    const mobileInput = document.getElementById('mobile-memo-due-date-input');
    if (input) input.value = '';
    if (mobileInput) mobileInput.value = '';
    scheduleEditorAutosave();
  });

  // Add Tag in Editor
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
    scheduleEditorAutosave();
  };

  document.getElementById('editor-add-tag-btn')?.addEventListener('click', addTagHandler);
  document.getElementById('editor-new-tag-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTagHandler();
    }
  });

  // Modal Triggers: Add Workspace, Add Category, Add Tag
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

      // Reload workspaces
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

  // Add Category
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

  // Add Tag
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

  // Folder management
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

  // Calendar Controls
  document.getElementById('calendar-prev-btn')?.addEventListener('click', () => {
    currentCalMonth--;
    if (currentCalMonth < 0) {
      currentCalMonth = 11;
      currentCalYear--;
    }
    renderInteractiveCalendar(currentCalYear, currentCalMonth);
  });

  document.getElementById('calendar-next-btn')?.addEventListener('click', () => {
    currentCalMonth++;
    if (currentCalMonth > 11) {
      currentCalMonth = 0;
      currentCalYear++;
    }
    renderInteractiveCalendar(currentCalYear, currentCalMonth);
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
      document.querySelectorAll('.modal-backdrop.active').forEach((modal) => {
        modal.classList.remove('active');
      });
      closeUserDropdown();
    }
    // Ctrl+S or ⌘S saves memo in Editor
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      if (state.get('currentView') === 'editor') {
        e.preventDefault();
        saveActiveMemo();
      }
    }
  });
}

function setupFormattingToolbar() {
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

  // Live preview update on textarea typing (debounced)
  let livePreviewTimer = null;
  document.getElementById('editor-body-textarea')?.addEventListener('input', () => {
    if (state.get('editorMode') === 'split') {
      clearTimeout(livePreviewTimer);
      livePreviewTimer = setTimeout(updateMarkdownLivePreview, 150);
    }
  });
}

// User Profile Pill Toggle
function toggleUserDropdown() {
  const dropdown = document.getElementById('user-dropdown-menu');
  const pill = document.getElementById('user-menu-pill');
  if (!dropdown || !pill) return;

  const isOpen = dropdown.classList.contains('active');
  if (isOpen) {
    closeUserDropdown();
  } else {
    dropdown.classList.add('active');
    pill.classList.add('open');
    pill.setAttribute('aria-expanded', 'true');
  }
}

function closeUserDropdown() {
  const dropdown = document.getElementById('user-dropdown-menu');
  const pill = document.getElementById('user-menu-pill');
  if (dropdown) dropdown.classList.remove('active');
  if (pill) {
    pill.classList.remove('open');
    pill.setAttribute('aria-expanded', 'false');
  }
}

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
  initMigrationModal();

  renderInteractiveCalendar(currentCalYear, currentCalMonth);

  // Set initial view mode button state
  const viewMode = state.get('viewMode') || 'grid';
  if (viewMode === 'grid') {
    document.getElementById('view-mode-grid-btn')?.classList.add('active');
    document.getElementById('view-mode-list-btn')?.classList.remove('active');
  } else {
    document.getElementById('view-mode-list-btn')?.classList.add('active');
    document.getElementById('view-mode-grid-btn')?.classList.remove('active');
  }

  // Detect authenticated session cookie with backend
  await detectSession();

  console.log('Memo Manager SaaS Productivity Frontend initialized successfully.');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
