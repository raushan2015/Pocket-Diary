/**
 * Google Keep Quick Capture Bar Controller
 * Collapsed/Expanded Note Composer with 1-Click Checklist, Drawing, Image, Voice, and Link Previews
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml } from './markdown.js';
import { showToast, triggerImagePicker, toggleSpeechRecognition, checkAndAddLinkPreview, extractImageFilesFromEvent } from './utils.js';
import { openPalettePopover, openReminderPopover, applyQuickCapturePalette } from './keep-popovers.js';
import { openKeepDrawingModal } from './keep-drawing.js';

export let quickCaptureDraft = {
  title: '',
  content: '',
  noteType: 'text',
  checklistData: [],
  attachments: [],
  pendingFiles: [], // Array of { file: File, previewUrl: string, name: string }
  linkPreviews: [],
  reminderTime: null,
  color: 'default',
  theme: 'none',
  isPinned: false,
  isArchived: false,
  tags: []
};

let onNoteCreatedCallback = null;

export function setupKeepQuickCapture(callbacks = {}) {
  onNoteCreatedCallback = callbacks.onNoteCreated;

  const container = document.getElementById('quick-capture-container');
  const collapsed = document.getElementById('quick-capture-collapsed');
  const form = document.getElementById('quick-capture-form');
  const contentTextarea = document.getElementById('quick-capture-content');
  const checklistEditor = document.getElementById('qc-checklist-editor');
  const checklistAddInput = document.getElementById('qc-checklist-add-input');
  const pinBtn = document.getElementById('qc-pin-btn');

  if (!container || !collapsed || !form) return;

  function expand(asChecklist = false) {
    collapsed.style.display = 'none';
    form.style.display = 'block';
    if (asChecklist) {
      quickCaptureDraft.noteType = 'checklist';
      if (contentTextarea) contentTextarea.style.display = 'none';
      if (checklistEditor) checklistEditor.style.display = 'block';
      document.getElementById('qc-tool-checklist')?.classList.add('active');
      checklistAddInput?.focus();
    } else {
      quickCaptureDraft.noteType = 'text';
      if (contentTextarea) contentTextarea.style.display = 'block';
      if (checklistEditor) checklistEditor.style.display = 'none';
      document.getElementById('qc-tool-checklist')?.classList.remove('active');
      contentTextarea?.focus();
    }
  }

  async function collapse() {
    await saveQuickCaptureDraft();
    form.style.display = 'none';
    collapsed.style.display = 'flex';
  }

  collapsed.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    expand(false);
  });

  document.getElementById('qc-quick-checklist-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    expand(true);
  });

  document.getElementById('qc-quick-drawing-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openKeepDrawingModal('quick-capture');
  });

  document.getElementById('qc-quick-image-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerImagePicker((files) => {
      addPendingFilesToQuickCapture(files);
      expand(false);
    });
  });

  document.getElementById('qc-quick-mic-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    expand(false);
    toggleSpeechRecognition((text) => {
      if (contentTextarea) {
        contentTextarea.value += (contentTextarea.value ? ' ' : '') + text;
      }
    }, document.getElementById('qc-tool-mic'));
  });

  document.getElementById('quick-capture-close')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await collapse();
  });

  document.addEventListener('click', async (e) => {
    if (form.style.display === 'block') {
      if (!container.contains(e.target) && !e.target.closest('.keep-popover') && !e.target.closest('#modal-keep-drawing')) {
        await collapse();
      }
    }
  });

  pinBtn?.addEventListener('click', () => {
    quickCaptureDraft.isPinned = !quickCaptureDraft.isPinned;
    pinBtn.classList.toggle('active', quickCaptureDraft.isPinned);
  });

  document.getElementById('qc-tool-checklist')?.addEventListener('click', () => {
    const isChecklist = quickCaptureDraft.noteType === 'checklist';
    if (isChecklist) {
      const lines = (quickCaptureDraft.checklistData || []).map((i) => i.text || '');
      quickCaptureDraft.content = lines.join('\n');
      quickCaptureDraft.noteType = 'text';
      if (contentTextarea) {
        contentTextarea.value = quickCaptureDraft.content;
        contentTextarea.style.display = 'block';
      }
      if (checklistEditor) checklistEditor.style.display = 'none';
      document.getElementById('qc-tool-checklist')?.classList.remove('active');
    } else {
      const text = contentTextarea?.value || '';
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      quickCaptureDraft.checklistData = lines.map((l, i) => ({ id: 'qc_chk_' + Date.now() + '_' + i, text: l, checked: false }));
      quickCaptureDraft.noteType = 'checklist';
      if (contentTextarea) contentTextarea.style.display = 'none';
      if (checklistEditor) checklistEditor.style.display = 'block';
      document.getElementById('qc-tool-checklist')?.classList.add('active');
      renderQuickCaptureChecklist();
    }
  });

  checklistAddInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = checklistAddInput.value.trim();
      if (!val) return;
      quickCaptureDraft.checklistData = quickCaptureDraft.checklistData || [];
      quickCaptureDraft.checklistData.push({
        id: 'qc_chk_' + Date.now() + Math.random().toString(36).substr(2, 4),
        text: val,
        checked: false
      });
      checklistAddInput.value = '';
      renderQuickCaptureChecklist();
      checklistAddInput.focus();
    }
  });

  contentTextarea?.addEventListener('blur', () => {
    const text = contentTextarea.value;
    if (text && (!quickCaptureDraft.linkPreviews || !quickCaptureDraft.linkPreviews.length)) {
      checkAndAddLinkPreview(text, quickCaptureDraft, renderQuickCaptureLinks);
    }
  });

  document.getElementById('qc-tool-palette')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openPalettePopover(document.getElementById('qc-tool-palette'), quickCaptureDraft);
  });

  document.getElementById('qc-tool-reminder')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openReminderPopover(document.getElementById('qc-tool-reminder'), quickCaptureDraft, () => {
      renderQuickCaptureReminderChip();
    });
  });

  document.getElementById('qc-tool-image')?.addEventListener('click', (e) => {
    e.stopPropagation();
    triggerImagePicker((files) => {
      addPendingFilesToQuickCapture(files);
    });
  });

  // Clipboard image pasting support (form and container)
  const onImagePaste = (e) => {
    const files = extractImageFilesFromEvent(e);
    if (files.length > 0) {
      e.preventDefault();
      expand(false);
      addPendingFilesToQuickCapture(files);
      showToast(`${files.length} image(s) attached to quick note`, 'info', 1500);
    }
  };
  form.addEventListener('paste', onImagePaste);
  collapsed.addEventListener('paste', onImagePaste);

  // Drag and drop image file support (form and container)
  const onDragOver = (e) => {
    e.preventDefault();
    container.classList.add('keep-capture-active');
  };
  const onDragLeave = (e) => {
    if (!container.contains(e.relatedTarget)) {
      container.classList.remove('keep-capture-active');
    }
  };
  const onImageDrop = (e) => {
    e.preventDefault();
    container.classList.remove('keep-capture-active');
    const files = extractImageFilesFromEvent(e);
    if (files.length > 0) {
      expand(false);
      addPendingFilesToQuickCapture(files);
      showToast(`${files.length} image(s) dropped into quick note`, 'info', 1500);
    }
  };
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onImageDrop);

  document.getElementById('qc-tool-archive')?.addEventListener('click', () => {
    quickCaptureDraft.isArchived = !quickCaptureDraft.isArchived;
    document.getElementById('qc-tool-archive')?.classList.toggle('active', quickCaptureDraft.isArchived);
    showToast(quickCaptureDraft.isArchived ? 'Note will be archived' : 'Note will be saved to stream', 'info', 1500);
  });

  document.getElementById('qc-tool-mic')?.addEventListener('click', () => {
    toggleSpeechRecognition((text) => {
      if (quickCaptureDraft.noteType === 'checklist') {
        quickCaptureDraft.checklistData = quickCaptureDraft.checklistData || [];
        quickCaptureDraft.checklistData.push({ id: 'qc_chk_' + Date.now(), text, checked: false });
        renderQuickCaptureChecklist();
      } else {
        if (contentTextarea) contentTextarea.value += (contentTextarea.value ? ' ' : '') + text;
      }
    }, document.getElementById('qc-tool-mic'));
  });

  document.getElementById('qc-clear-reminder')?.addEventListener('click', (e) => {
    e.stopPropagation();
    quickCaptureDraft.reminderTime = null;
    renderQuickCaptureReminderChip();
  });
}

export function renderQuickCaptureChecklist() {
  const container = document.getElementById('qc-checklist-items');
  if (!container) return;
  const items = quickCaptureDraft.checklistData || [];
  container.innerHTML = items.map((item, idx) => `
    <div class="keep-checklist-item ${item.checked ? 'completed' : ''}">
      <input type="checkbox" ${item.checked ? 'checked' : ''} data-qc-chk="${idx}">
      <span class="keep-item-text" style="font-size:0.875rem;">${escapeHtml(item.text || '')}</span>
      <button type="button" class="keep-item-remove-btn" data-qc-rm="${idx}">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-qc-chk]').forEach((chk) => {
    chk.addEventListener('change', () => {
      const idx = Number(chk.dataset.qcChk);
      items[idx].checked = chk.checked;
      renderQuickCaptureChecklist();
    });
  });

  container.querySelectorAll('[data-qc-rm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.qcRm);
      items.splice(idx, 1);
      renderQuickCaptureChecklist();
    });
  });
}

export function addPendingFilesToQuickCapture(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const previewUrl = URL.createObjectURL(file);
    quickCaptureDraft.pendingFiles = quickCaptureDraft.pendingFiles || [];
    quickCaptureDraft.pendingFiles.push({ file, previewUrl, name: file.name });
  }
  renderQuickCaptureAttachments();
}

export function renderQuickCaptureAttachments() {
  const container = document.getElementById('qc-attachments-preview');
  if (!container) return;
  const pending = quickCaptureDraft.pendingFiles || [];
  if (!pending.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'grid';
  container.innerHTML = pending.map((item, idx) => `
    <div class="keep-attachment-item">
      <img src="${item.previewUrl}" alt="${escapeHtml(item.name || 'Image')}">
      <button type="button" class="keep-attachment-remove" data-qc-att-rm="${idx}" title="Remove image">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('[data-qc-att-rm]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.qcAttRm);
      const item = pending[idx];
      if (item?.previewUrl) {
        try { URL.revokeObjectURL(item.previewUrl); } catch {}
      }
      pending.splice(idx, 1);
      renderQuickCaptureAttachments();
    });
  });
}

export function renderQuickCaptureLinks() {
  const container = document.getElementById('qc-links-preview');
  if (!container) return;
  const links = quickCaptureDraft.linkPreviews || [];
  if (!links.length) {
    container.style.display = 'none';
    container.innerHTML = '';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = links.map((lp) => {
    let domain = '';
    try { domain = new URL(lp.url).hostname; } catch {}
    return `
      <a href="${escapeHtml(lp.url)}" target="_blank" rel="noopener noreferrer" class="keep-link-card">
        ${lp.image ? `<img src="${escapeHtml(lp.image)}" class="keep-link-thumb" alt="">` : ''}
        <div class="keep-link-info">
          <span class="keep-link-title">${escapeHtml(lp.title || lp.url)}</span>
          <span class="keep-link-domain">${escapeHtml(domain || lp.url)}</span>
        </div>
      </a>
    `;
  }).join('');
}

export function renderQuickCaptureReminderChip() {
  const chipsRow = document.getElementById('qc-composer-chips');
  const chip = document.getElementById('qc-reminder-chip');
  const textEl = document.getElementById('qc-reminder-text');
  const time = quickCaptureDraft.reminderTime;

  if (!chip || !textEl || !chipsRow) return;
  if (time) {
    const d = new Date(time);
    const formatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    textEl.textContent = formatted;
    chip.style.display = 'inline-flex';
    chipsRow.style.display = 'flex';
  } else {
    chip.style.display = 'none';
    if (!chipsRow.querySelector('#qc-labels-chips')?.children.length) {
      chipsRow.style.display = 'none';
    }
  }
}

export function resetQuickCaptureDraft() {
  (quickCaptureDraft.pendingFiles || []).forEach((item) => {
    if (item?.previewUrl) {
      try { URL.revokeObjectURL(item.previewUrl); } catch {}
    }
  });

  quickCaptureDraft = {
    title: '',
    content: '',
    noteType: 'text',
    checklistData: [],
    attachments: [],
    pendingFiles: [],
    linkPreviews: [],
    reminderTime: null,
    color: 'default',
    theme: 'none',
    isPinned: false,
    isArchived: false,
    tags: []
  };
  const titleInput = document.getElementById('quick-capture-title');
  const contentTextarea = document.getElementById('quick-capture-content');
  if (titleInput) titleInput.value = '';
  if (contentTextarea) contentTextarea.value = '';
  document.getElementById('qc-pin-btn')?.classList.remove('active');
  document.getElementById('qc-tool-archive')?.classList.remove('active');
  renderQuickCaptureChecklist();
  renderQuickCaptureAttachments();
  renderQuickCaptureLinks();
  renderQuickCaptureReminderChip();
  applyQuickCapturePalette(quickCaptureDraft);
}

export async function saveQuickCaptureDraft() {
  const titleInput = document.getElementById('quick-capture-title');
  const contentTextarea = document.getElementById('quick-capture-content');
  const title = titleInput?.value.trim() || '';
  const content = contentTextarea?.value.trim() || '';
  const checklistData = quickCaptureDraft.checklistData || [];
  const pendingFiles = quickCaptureDraft.pendingFiles || [];
  const hasContent = title || content || checklistData.length > 0 || pendingFiles.length > 0;

  if (!hasContent) {
    resetQuickCaptureDraft();
    return;
  }

  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id) {
    showToast('Select a workspace before creating a note', 'error');
    resetQuickCaptureDraft();
    return;
  }

  const categories = state.get('categories') || [];
  const folderId = state.get('activeFilter')?.type === 'folder' ? state.get('activeFilter').value : null;
  const fallbackTitle = (content || (checklistData[0]?.text) || 'Untitled Note').split(/\s+/).slice(0, 6).join(' ');

  const payload = {
    workspaceId: activeWs.id,
    title: title || fallbackTitle,
    content: contentTextarea?.value || '',
    noteType: quickCaptureDraft.noteType || 'text',
    checklistData: checklistData,
    linkPreviews: quickCaptureDraft.linkPreviews || [],
    reminderTime: quickCaptureDraft.reminderTime || null,
    color: quickCaptureDraft.color || 'default',
    theme: quickCaptureDraft.theme || 'none',
    isPinned: !!quickCaptureDraft.isPinned,
    isArchived: !!quickCaptureDraft.isArchived,
    categoryId: categories[0]?.id || null,
    folderId,
    priority: 'medium',
    status: 'pending'
  };

  try {
    const res = await api.createMemo(payload);
    const newMemo = res?.memo;

    // Upload queued image files if any
    if (newMemo?.id && pendingFiles.length > 0) {
      const uploadedImages = [];
      for (const item of pendingFiles) {
        try {
          const upRes = await api.uploadAttachment(newMemo.id, item.file);
          if (upRes?.attachment?.url) {
            uploadedImages.push({
              name: item.file.name || 'image',
              url: upRes.attachment.url
            });
          }
        } catch (uploadErr) {
          console.error('Failed to upload attachment:', uploadErr);
        }
        if (item.previewUrl) {
          try { URL.revokeObjectURL(item.previewUrl); } catch {}
        }
      }

      if (uploadedImages.length > 0 && (newMemo.noteType === 'text' || !newMemo.noteType)) {
        const imgMarkdown = uploadedImages.map(img => {
          const cleanName = img.name.replace(/[\[\]\(\)]/g, '_');
          return `![${cleanName}](${img.url})`;
        }).join('\n\n');
        const updatedContent = (newMemo.content ? `${newMemo.content}\n\n` : '') + imgMarkdown;
        try {
          await api.updateMemo(newMemo.id, { content: updatedContent });
          newMemo.content = updatedContent;
        } catch (updateErr) {
          console.error('Failed to update memo with markdown images:', updateErr);
        }
      }
    }

    showToast('Note created', 'success', 1800);
    resetQuickCaptureDraft();
    if (typeof onNoteCreatedCallback === 'function') {
      await onNoteCreatedCallback();
    }
  } catch (err) {
    showToast(err.message || 'Could not create note', 'error');
  }
}
