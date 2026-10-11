/**
 * Google Keep In-Place Note Modal Controller
 * Elevated modal note editor with dynamic checklists, attachments, link previews, reminders, colors, drawings, and voice typing
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml } from './markdown.js';
import { openModal, closeModal, showToast, toggleSpeechRecognition, checkAndAddLinkPreview, extractImageFilesFromEvent } from './utils.js';
import { openPalettePopover, openReminderPopover, openCollabPopover, applyMemoCardPalette, closeKeepPopovers } from './keep-popovers.js';
import { openKeepDrawingModal } from './keep-drawing.js';
import { openLightbox } from './keep-lightbox.js';

export let activeKeepModalMemo = null;
let keepModalAutosaveTimer = null;
let onMemoChangedCallback = null;

export function openKeepNoteModal(memo, callbacks = {}) {
  closeKeepPopovers();
  activeKeepModalMemo = memo;
  if (callbacks.onChanged) onMemoChangedCallback = callbacks.onChanged;

  const titleInput = document.getElementById('keep-modal-title');
  const contentTextarea = document.getElementById('keep-modal-content');
  const checklistContainer = document.getElementById('keep-modal-checklist');
  const pinBtn = document.getElementById('keep-modal-pin-btn');
  const statusEl = document.getElementById('keep-modal-status');

  if (titleInput) titleInput.value = memo.title || '';
  if (statusEl) statusEl.textContent = 'Saved';
  applyMemoCardPalette(memo);

  if (pinBtn) {
    pinBtn.classList.toggle('active', !!memo.isPinned);
  }

  const isChecklist = memo.noteType === 'checklist' || (Array.isArray(memo.checklistData) && memo.checklistData.length > 0);
  if (isChecklist) {
    memo.noteType = 'checklist';
    if (contentTextarea) contentTextarea.style.display = 'none';
    if (checklistContainer) checklistContainer.style.display = 'block';
    document.getElementById('keep-modal-checklist-toggle-btn')?.classList.add('active');
    renderKeepModalChecklist(memo);
  } else {
    memo.noteType = 'text';
    if (contentTextarea) {
      contentTextarea.style.display = 'block';
      contentTextarea.value = memo.content || '';
    }
    if (checklistContainer) checklistContainer.style.display = 'none';
    document.getElementById('keep-modal-checklist-toggle-btn')?.classList.remove('active');
  }

  renderKeepModalAttachments(memo);
  renderKeepModalLinks(memo);
  renderKeepModalReminderChip(memo);
  renderKeepModalCollaborators(memo);
  renderKeepModalTags(memo);

  openModal('modal-keep-editor');
}

export function closeKeepNoteModal() {
  clearTimeout(keepModalAutosaveTimer);
  if (activeKeepModalMemo) {
    saveKeepModalNote(true);
  }
  closeModal('modal-keep-editor');
  closeKeepPopovers();
  activeKeepModalMemo = null;
  if (typeof onMemoChangedCallback === 'function') {
    onMemoChangedCallback();
  }
}

export function scheduleKeepModalAutosave(immediate = false) {
  clearTimeout(keepModalAutosaveTimer);
  const statusEl = document.getElementById('keep-modal-status');
  if (statusEl) statusEl.textContent = 'Saving…';
  if (immediate) {
    saveKeepModalNote(true);
  } else {
    keepModalAutosaveTimer = setTimeout(() => saveKeepModalNote(true), 400);
  }
}

export async function saveKeepModalNote(quiet = true) {
  if (!activeKeepModalMemo || !activeKeepModalMemo.id) return;
  const memo = activeKeepModalMemo;
  const title = document.getElementById('keep-modal-title')?.value.trim() || '';
  memo.title = title;

  if (memo.noteType === 'text') {
    memo.content = document.getElementById('keep-modal-content')?.value || '';
  }

  const payload = {
    title: memo.title || 'Untitled Note',
    content: memo.content || '',
    noteType: memo.noteType || 'text',
    checklistData: memo.checklistData || [],
    linkPreviews: memo.linkPreviews || [],
    reminderTime: memo.reminderTime || null,
    collaborators: memo.collaborators || [],
    color: memo.color || 'default',
    theme: memo.theme || 'none',
    isPinned: !!memo.isPinned,
    isArchived: !!memo.isArchived,
    version: memo.version
  };

  try {
    const res = await api.updateMemo(memo.id, payload);
    if (res && res.memo) {
      memo.version = res.memo.version;
    }
    const statusEl = document.getElementById('keep-modal-status');
    if (statusEl) statusEl.textContent = 'Saved';

    if (memo.noteType === 'text' && memo.content && (!memo.linkPreviews || !memo.linkPreviews.length)) {
      checkAndAddLinkPreview(memo.content, memo, () => renderKeepModalLinks(memo));
    }
  } catch (err) {
    console.error('Save keep modal error:', err);
    const statusEl = document.getElementById('keep-modal-status');
    if (statusEl) statusEl.textContent = 'Error saving';
  }
}

export function renderKeepModalChecklist(memo) {
  memo.checklistData = Array.isArray(memo.checklistData) ? memo.checklistData : [];
  const activeContainer = document.getElementById('keep-modal-checklist-active');
  const completedSection = document.getElementById('keep-modal-checklist-completed-section');
  const completedCount = document.getElementById('keep-modal-completed-count');
  const completedContainer = document.getElementById('keep-modal-checklist-completed-items');

  const uncompleted = memo.checklistData.filter((i) => !i.checked);
  const completed = memo.checklistData.filter((i) => i.checked);

  if (activeContainer) {
    activeContainer.innerHTML = uncompleted.map((item) => `
      <div class="keep-checklist-item" data-item-id="${escapeHtml(item.id)}">
        <input type="checkbox" aria-label="Toggle item">
        <input type="text" class="keep-item-input" value="${escapeHtml(item.text || '')}" placeholder="List item">
        <button type="button" class="keep-item-remove-btn" title="Delete item">✕</button>
      </div>
    `).join('');

    activeContainer.querySelectorAll('.keep-checklist-item').forEach((row) => {
      const id = row.getAttribute('data-item-id');
      const item = memo.checklistData.find((i) => String(i.id) === String(id));
      if (!item) return;

      const chk = row.querySelector('input[type="checkbox"]');
      const txt = row.querySelector('.keep-item-input');
      const rm = row.querySelector('.keep-item-remove-btn');

      chk?.addEventListener('change', () => {
        item.checked = chk.checked;
        renderKeepModalChecklist(memo);
        scheduleKeepModalAutosave();
      });

      txt?.addEventListener('input', () => {
        item.text = txt.value;
        scheduleKeepModalAutosave();
      });

      txt?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const currIdx = memo.checklistData.findIndex((i) => String(i.id) === String(id));
          const newItem = { id: 'chk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4), text: '', checked: false };
          memo.checklistData.splice(currIdx + 1, 0, newItem);
          renderKeepModalChecklist(memo);
          scheduleKeepModalAutosave();
          setTimeout(() => {
            const nextRow = activeContainer.querySelector(`[data-item-id="${newItem.id}"] .keep-item-input`);
            nextRow?.focus();
          }, 20);
        } else if (e.key === 'Backspace' && txt.value === '' && memo.checklistData.length > 1) {
          e.preventDefault();
          const currIdx = memo.checklistData.findIndex((i) => String(i.id) === String(id));
          const prevItem = memo.checklistData[currIdx - 1];
          memo.checklistData.splice(currIdx, 1);
          renderKeepModalChecklist(memo);
          scheduleKeepModalAutosave();
          if (prevItem) {
            setTimeout(() => {
              const prevRow = activeContainer.querySelector(`[data-item-id="${prevItem.id}"] .keep-item-input`);
              if (prevRow) {
                prevRow.focus();
                prevRow.setSelectionRange(prevRow.value.length, prevRow.value.length);
              }
            }, 20);
          }
        }
      });

      rm?.addEventListener('click', () => {
        memo.checklistData = memo.checklistData.filter((i) => String(i.id) !== String(id));
        renderKeepModalChecklist(memo);
        scheduleKeepModalAutosave();
      });
    });
  }

  if (completedSection && completedContainer) {
    if (completed.length > 0) {
      completedSection.style.display = 'block';
      if (completedCount) completedCount.textContent = `${completed.length} Completed item${completed.length === 1 ? '' : 's'}`;
      completedContainer.innerHTML = completed.map((item) => `
        <div class="keep-checklist-item completed" data-item-id="${escapeHtml(item.id)}">
          <input type="checkbox" checked aria-label="Toggle item">
          <input type="text" class="keep-item-input" value="${escapeHtml(item.text || '')}">
          <button type="button" class="keep-item-remove-btn" title="Delete item">✕</button>
        </div>
      `).join('');

      completedContainer.querySelectorAll('.keep-checklist-item').forEach((row) => {
        const id = row.getAttribute('data-item-id');
        const item = memo.checklistData.find((i) => String(i.id) === String(id));
        if (!item) return;

        const chk = row.querySelector('input[type="checkbox"]');
        const txt = row.querySelector('.keep-item-input');
        const rm = row.querySelector('.keep-item-remove-btn');

        chk?.addEventListener('change', () => {
          item.checked = chk.checked;
          renderKeepModalChecklist(memo);
          scheduleKeepModalAutosave();
        });

        txt?.addEventListener('input', () => {
          item.text = txt.value;
          scheduleKeepModalAutosave();
        });

        rm?.addEventListener('click', () => {
          memo.checklistData = memo.checklistData.filter((i) => String(i.id) !== String(id));
          renderKeepModalChecklist(memo);
          scheduleKeepModalAutosave();
        });
      });
    } else {
      completedSection.style.display = 'none';
      completedContainer.innerHTML = '';
    }
  }
}

export function toggleKeepModalNoteType() {
  if (!activeKeepModalMemo) return;
  const memo = activeKeepModalMemo;
  const contentTextarea = document.getElementById('keep-modal-content');
  const checklistContainer = document.getElementById('keep-modal-checklist');
  const toggleBtn = document.getElementById('keep-modal-checklist-toggle-btn');

  if (memo.noteType === 'checklist') {
    const lines = (memo.checklistData || []).map((i) => i.text || '');
    memo.content = lines.join('\n');
    memo.noteType = 'text';
    memo.checklistData = [];
    if (contentTextarea) {
      contentTextarea.value = memo.content;
      contentTextarea.style.display = 'block';
    }
    if (checklistContainer) checklistContainer.style.display = 'none';
    toggleBtn?.classList.remove('active');
  } else {
    const text = document.getElementById('keep-modal-content')?.value || memo.content || '';
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    memo.checklistData = lines.map((line, idx) => ({
      id: 'chk_' + Date.now() + '_' + idx,
      text: line,
      checked: false,
      sortOrder: idx
    }));
    memo.noteType = 'checklist';
    if (contentTextarea) contentTextarea.style.display = 'none';
    if (checklistContainer) checklistContainer.style.display = 'block';
    toggleBtn?.classList.add('active');
    renderKeepModalChecklist(memo);
  }
  scheduleKeepModalAutosave(true);
}

export function renderKeepModalAttachments(memo) {
  const container = document.getElementById('keep-modal-attachments');
  if (!container) return;
  const attachments = memo.attachments || [];
  if (!attachments.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = attachments.map((att, idx) => `
    <div class="keep-attachment-item" data-att-idx="${idx}" title="Click to view full size">
      <img src="${att.url || att.filePath}" alt="${escapeHtml(att.fileName || att.name || 'Image')}">
      <button type="button" class="keep-attachment-remove" data-remove-attachment="${idx}" title="Remove image">&times;</button>
    </div>
  `).join('');

  container.querySelectorAll('.keep-attachment-item').forEach((itemEl) => {
    itemEl.addEventListener('click', (e) => {
      if (e.target.closest('.keep-attachment-remove')) return;
      const idx = Number(itemEl.dataset.attIdx);
      const att = attachments[idx];
      if (att) openLightbox(att, memo);
    });
  });

  container.querySelectorAll('[data-remove-attachment]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.removeAttachment);
      const att = attachments[idx];
      if (att && att.id && !att.id.startsWith('temp_')) {
        try {
          await api.deleteAttachment(att.id);
        } catch (err) {
          console.warn('Failed to delete attachment from server:', err);
        }
      }
      attachments.splice(idx, 1);
      renderKeepModalAttachments(memo);
      if (typeof onMemoChangedCallback === 'function') onMemoChangedCallback();
    });
  });
}

export function renderKeepModalLinks(memo) {
  const container = document.getElementById('keep-modal-links');
  if (!container) return;
  const previews = memo.linkPreviews || [];
  if (!previews.length) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = previews.map((lp) => {
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

export function renderKeepModalReminderChip(memo) {
  const chip = document.getElementById('keep-modal-reminder-chip');
  const label = document.getElementById('keep-modal-reminder-label');
  const time = memo.reminderTime || memo.dueDate;
  if (!chip || !label) return;
  if (time) {
    const d = new Date(time);
    const formatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    label.textContent = formatted;
    chip.style.display = 'inline-flex';
  } else {
    chip.style.display = 'none';
  }
}

export function renderKeepModalCollaborators(memo) {
  const container = document.getElementById('keep-modal-collaborators');
  if (!container) return;
  const collabs = memo.collaborators || [];
  container.innerHTML = collabs.map((c) => `
    <span style="width:24px; height:24px; border-radius:50%; background:var(--color-primary-600); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:0.75rem; font-weight:600;" title="${escapeHtml(c.email || c.name || '')}">
      ${(c.name || c.email || 'C').charAt(0).toUpperCase()}
    </span>
  `).join('');
}

export function renderKeepModalTags(memo) {
  const container = document.getElementById('keep-modal-tags');
  if (!container) return;
  const tags = memo.tags || [];
  container.innerHTML = tags.map((t) => `<span class="tag-chip">#${escapeHtml(t)}</span>`).join('');
}

export function setupKeepModalListeners(callbacks = {}) {
  const modal = document.getElementById('modal-keep-editor');
  const closeBtn = document.getElementById('keep-modal-close-btn');
  const titleInput = document.getElementById('keep-modal-title');
  const contentTextarea = document.getElementById('keep-modal-content');
  const pinBtn = document.getElementById('keep-modal-pin-btn');
  const expandBtn = document.getElementById('keep-modal-expand-btn');
  const archiveBtn = document.getElementById('keep-modal-archive-btn');
  const trashBtn = document.getElementById('keep-modal-trash-btn');
  const checklistToggleBtn = document.getElementById('keep-modal-checklist-toggle-btn');
  const reminderBtn = document.getElementById('keep-modal-reminder-btn');
  const colorBtn = document.getElementById('keep-modal-color-btn');
  const collabBtn = document.getElementById('keep-modal-collab-btn');
  const imageBtn = document.getElementById('keep-modal-image-btn');
  const drawingBtn = document.getElementById('keep-modal-drawing-btn');
  const voiceBtn = document.getElementById('keep-modal-voice-btn');
  const fileInput = document.getElementById('keep-modal-file-input');
  const clearReminderBtn = document.getElementById('keep-modal-clear-reminder');
  const newChecklistInput = document.getElementById('keep-modal-checklist-new-item');
  const completedToggle = document.getElementById('keep-modal-completed-toggle');

  closeBtn?.addEventListener('click', closeKeepNoteModal);

  expandBtn?.addEventListener('click', async () => {
    if (!activeKeepModalMemo) return;
    await saveKeepModalNote(true);
    const memoToOpen = { ...activeKeepModalMemo };
    closeKeepNoteModal();
    if (typeof callbacks.onExpand === 'function') {
      callbacks.onExpand(memoToOpen);
    }
  });

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeKeepNoteModal();
    }
  });

  titleInput?.addEventListener('input', () => scheduleKeepModalAutosave());
  contentTextarea?.addEventListener('input', () => scheduleKeepModalAutosave());

  pinBtn?.addEventListener('click', () => {
    if (!activeKeepModalMemo) return;
    activeKeepModalMemo.isPinned = !activeKeepModalMemo.isPinned;
    pinBtn.classList.toggle('active', !!activeKeepModalMemo.isPinned);
    scheduleKeepModalAutosave(true);
  });

  archiveBtn?.addEventListener('click', async () => {
    if (!activeKeepModalMemo) return;
    activeKeepModalMemo.isArchived = !activeKeepModalMemo.isArchived;
    await saveKeepModalNote(true);
    showToast(activeKeepModalMemo.isArchived ? 'Note archived' : 'Note unarchived', 'info', 1800);
    closeKeepNoteModal();
    if (typeof callbacks.onRefresh === 'function') await callbacks.onRefresh();
  });

  trashBtn?.addEventListener('click', async () => {
    if (!activeKeepModalMemo) return;
    const id = activeKeepModalMemo.id;
    try {
      await api.deleteMemo(id, false);
      showToast('Note moved to Trash', 'info', 2000);
      closeKeepNoteModal();
      if (typeof callbacks.onRefresh === 'function') await callbacks.onRefresh();
    } catch {
      showToast('Failed to delete note', 'error');
    }
  });

  checklistToggleBtn?.addEventListener('click', toggleKeepModalNoteType);

  reminderBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeKeepModalMemo) {
      openReminderPopover(reminderBtn, activeKeepModalMemo, () => {
        renderKeepModalReminderChip(activeKeepModalMemo);
      });
    }
  });

  colorBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeKeepModalMemo) {
      openPalettePopover(colorBtn, activeKeepModalMemo, () => {
        applyMemoCardPalette(activeKeepModalMemo);
      });
    }
  });

  collabBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeKeepModalMemo) {
      openCollabPopover(collabBtn, activeKeepModalMemo, () => {
        renderKeepModalCollaborators(activeKeepModalMemo);
      });
    }
  });

  async function uploadFilesToActiveMemo(files) {
    if (!activeKeepModalMemo || !files.length) return;
    if (!activeKeepModalMemo.id) {
      const activeWs = state.get('activeWorkspace');
      if (!activeWs?.id) {
        showToast('Please select a workspace first', 'error');
        return;
      }
      const title = document.getElementById('keep-modal-title')?.value.trim() || 'Untitled Note';
      const content = document.getElementById('keep-modal-content')?.value || '';
      try {
        const createRes = await api.createMemo({
          workspaceId: activeWs.id,
          title,
          content,
          noteType: activeKeepModalMemo.noteType || 'text',
          color: activeKeepModalMemo.color || 'default',
          priority: 'medium',
          status: 'pending'
        });
        if (createRes?.memo) {
          activeKeepModalMemo = { ...createRes.memo };
        }
      } catch (err) {
        showToast('Could not initialize note draft for upload', 'error');
        return;
      }
    }
    if (!activeKeepModalMemo.id) return;
    let uploadedCount = 0;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      showToast(`Uploading ${file.name}…`, 'info', 1800);
      try {
        const res = await api.uploadAttachment(activeKeepModalMemo.id, file);
        if (res && res.attachment) {
          activeKeepModalMemo.attachments = activeKeepModalMemo.attachments || [];
          activeKeepModalMemo.attachments.push(res.attachment);
          renderKeepModalAttachments(activeKeepModalMemo);

          const contentTextarea = document.getElementById('keep-modal-content');
          if (activeKeepModalMemo.noteType === 'text' && contentTextarea) {
            const cleanName = (file.name || 'image').replace(/[\[\]\(\)]/g, '_');
            const imgMd = `\n![${cleanName}](${res.attachment.url})\n`;
            contentTextarea.value += (contentTextarea.value ? '\n' : '') + imgMd;
            activeKeepModalMemo.content = contentTextarea.value;
            scheduleKeepModalAutosave(true);
          }

          uploadedCount++;
          if (typeof callbacks.onRefresh === 'function') callbacks.onRefresh();
        }
      } catch (err) {
        showToast(err.message || 'Image upload failed', 'error');
      }
    }
    if (uploadedCount > 0) {
      showToast(`${uploadedCount} image(s) attached inside note`, 'success', 2000);
    }
  }

  imageBtn?.addEventListener('click', () => {
    fileInput?.click();
  });

  fileInput?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    fileInput.value = '';
    await uploadFilesToActiveMemo(files);
  });

  modal?.addEventListener('paste', async (e) => {
    const files = extractImageFilesFromEvent(e);
    if (files.length > 0) {
      e.preventDefault();
      await uploadFilesToActiveMemo(files);
    }
  });

  modal?.addEventListener('dragover', (e) => e.preventDefault());
  modal?.addEventListener('drop', async (e) => {
    const files = extractImageFilesFromEvent(e);
    if (files.length > 0) {
      e.preventDefault();
      await uploadFilesToActiveMemo(files);
    }
  });

  drawingBtn?.addEventListener('click', () => {
    openKeepDrawingModal('modal');
  });

  voiceBtn?.addEventListener('click', () => {
    toggleSpeechRecognition((text) => {
      if (!activeKeepModalMemo) return;
      if (activeKeepModalMemo.noteType === 'checklist') {
        activeKeepModalMemo.checklistData = activeKeepModalMemo.checklistData || [];
        activeKeepModalMemo.checklistData.push({ id: 'chk_' + Date.now(), text, checked: false });
        renderKeepModalChecklist(activeKeepModalMemo);
      } else {
        const txt = document.getElementById('keep-modal-content');
        if (txt) {
          txt.value += (txt.value ? ' ' : '') + text;
          activeKeepModalMemo.content = txt.value;
        }
      }
      scheduleKeepModalAutosave(true);
    }, voiceBtn);
  });

  clearReminderBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeKeepModalMemo) {
      activeKeepModalMemo.reminderTime = null;
      renderKeepModalReminderChip(activeKeepModalMemo);
      scheduleKeepModalAutosave(true);
    }
  });

  newChecklistInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = newChecklistInput.value.trim();
      if (!val || !activeKeepModalMemo) return;
      activeKeepModalMemo.checklistData = activeKeepModalMemo.checklistData || [];
      activeKeepModalMemo.checklistData.push({
        id: 'chk_' + Date.now() + Math.random().toString(36).substr(2, 4),
        text: val,
        checked: false,
        sortOrder: activeKeepModalMemo.checklistData.length
      });
      newChecklistInput.value = '';
      renderKeepModalChecklist(activeKeepModalMemo);
      scheduleKeepModalAutosave();
      newChecklistInput.focus();
    }
  });

  completedToggle?.addEventListener('click', () => {
    completedToggle.classList.toggle('open');
    const items = document.getElementById('keep-modal-checklist-completed-items');
    if (items) {
      items.style.display = completedToggle.classList.contains('open') ? 'flex' : 'none';
    }
  });

  const uncheckAllBtn = document.getElementById('keep-modal-uncheck-all-btn');
  uncheckAllBtn?.addEventListener('click', () => {
    if (!activeKeepModalMemo || !Array.isArray(activeKeepModalMemo.checklistData)) return;
    let count = 0;
    activeKeepModalMemo.checklistData.forEach((item) => {
      if (item.checked) {
        item.checked = false;
        count++;
      }
    });
    if (count > 0) {
      renderKeepModalChecklist(activeKeepModalMemo);
      scheduleKeepModalAutosave(true);
      showToast(`${count} item${count === 1 ? '' : 's'} unchecked`, 'info', 1500);
    }
  });

  const deleteCheckedBtn = document.getElementById('keep-modal-delete-checked-btn');
  deleteCheckedBtn?.addEventListener('click', () => {
    if (!activeKeepModalMemo || !Array.isArray(activeKeepModalMemo.checklistData)) return;
    const initialLen = activeKeepModalMemo.checklistData.length;
    activeKeepModalMemo.checklistData = activeKeepModalMemo.checklistData.filter((item) => !item.checked);
    const removed = initialLen - activeKeepModalMemo.checklistData.length;
    if (removed > 0) {
      renderKeepModalChecklist(activeKeepModalMemo);
      scheduleKeepModalAutosave(true);
      showToast(`${removed} completed item${removed === 1 ? '' : 's'} removed`, 'info', 1500);
    }
  });
}
