/**
 * Google Keep Floating Popovers Controller
 * Background Colors (12 Keep pastels), Themes, Reminders, and Collaborators
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { escapeHtml } from './markdown.js';

export function setupKeepPopovers() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.keep-popover') &&
        !e.target.closest('[data-action="color-popover"]') &&
        !e.target.closest('[data-action="remind-popover"]') &&
        !e.target.closest('[data-action="more-options"]') &&
        !e.target.closest('#keep-modal-color-btn') &&
        !e.target.closest('#keep-modal-reminder-btn') &&
        !e.target.closest('#keep-modal-collab-btn') &&
        !e.target.closest('#keep-modal-labels-btn') &&
        !e.target.closest('#qc-tool-palette') &&
        !e.target.closest('#qc-tool-reminder') &&
        !e.target.closest('#qc-tool-labels') &&
        !e.target.closest('#qc-voice-lang-btn') &&
        !e.target.closest('#keep-modal-voice-lang-btn')) {
      closeKeepPopovers();
    }
  });
}

export function openMoreOptionsPopover(anchorEl, memo, callbacks = {}) {
  const popover = document.getElementById('keep-popover-more');
  if (!popover || !anchorEl) return;
  positionPopover(popover, anchorEl);

  const deleteBtn = document.getElementById('keep-more-delete-btn');
  const copyBtn = document.getElementById('keep-more-copy-btn');
  const copyTextBtn = document.getElementById('keep-more-copy-text-btn');

  if (deleteBtn) {
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      closeKeepPopovers();
      if (typeof callbacks.onDelete === 'function') {
        callbacks.onDelete(memo);
      }
    };
  }

  if (copyBtn) {
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      closeKeepPopovers();
      if (typeof callbacks.onCopy === 'function') {
        callbacks.onCopy(memo);
      }
    };
  }

  if (copyTextBtn) {
    copyTextBtn.onclick = (e) => {
      e.stopPropagation();
      closeKeepPopovers();
      if (typeof callbacks.onCopyText === 'function') {
        callbacks.onCopyText(memo);
      }
    };
  }
}

export function positionPopover(popoverEl, anchorEl) {
  closeKeepPopovers();
  popoverEl.style.display = 'block';
  const rect = anchorEl.getBoundingClientRect();
  const popoverRect = popoverEl.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left;
  if (left + popoverRect.width > window.innerWidth - 16) {
    left = window.innerWidth - popoverRect.width - 16;
  }
  if (left < 16) left = 16;
  if (top + popoverRect.height > window.innerHeight - 16) {
    top = rect.top - popoverRect.height - 6;
  }
  popoverEl.style.top = `${top}px`;
  popoverEl.style.left = `${left}px`;
}

export function closeKeepPopovers() {
  document.querySelectorAll('.keep-popover').forEach((p) => { p.style.display = 'none'; });
  const pickerInput = document.getElementById('keep-labels-picker-new-input');
  if (pickerInput) pickerInput.value = '';
}

/**
 * Labels picker popover: assign / remove workspace labels on a note or draft.
 * Toggling a checkbox updates memoOrDraft.tags and fires onChange(tags).
 */
export function openLabelsPickerPopover(anchorEl, memoOrDraft, onChange = null) {
  const popover = document.getElementById('keep-popover-labels');
  if (!popover || !anchorEl || !memoOrDraft) return;
  positionPopover(popover, anchorEl);

  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id) {
    showToast('Select a workspace first', 'error');
    closeKeepPopovers();
    return;
  }

  const listContainer = document.getElementById('keep-labels-picker-list');
  const createInput = document.getElementById('keep-labels-picker-new-input');
  const createBtn = document.getElementById('keep-labels-picker-create-btn');

  const normalize = (t) => String(t).trim().replace(/^[#\s]+/, '').toLowerCase();
  const selectedTags = () => (Array.isArray(memoOrDraft.tags) ? memoOrDraft.tags : []);

  const toggleLabel = (name, checked) => {
    const tags = selectedTags();
    if (checked) {
      if (!tags.some((t) => normalize(t) === normalize(name))) tags.push(name);
    } else {
      memoOrDraft.tags = tags.filter((t) => normalize(t) !== normalize(name));
    }
    if (typeof onChange === 'function') onChange(memoOrDraft.tags);
  };

  const renderList = (tags) => {
    if (!listContainer) return;
    const selected = selectedTags().map(normalize);
    if (!tags.length) {
      listContainer.innerHTML = '<div class="keep-labels-picker-empty">No labels yet. Create one below.</div>';
      return;
    }
    listContainer.innerHTML = tags.map((t) => `
      <label class="keep-labels-picker-row">
        <input type="checkbox" data-label-name="${escapeHtml(t.name)}" ${selected.includes(normalize(t.name)) ? 'checked' : ''}>
        <span class="keep-labels-name">#${escapeHtml(t.name)}</span>
      </label>
    `).join('');

    listContainer.querySelectorAll('input[data-label-name]').forEach((chk) => {
      chk.addEventListener('change', () => toggleLabel(chk.dataset.labelName, chk.checked));
    });
  };

  const refreshTags = async () => {
    let tags = state.get('tags') || [];
    try {
      const res = await api.listTags(activeWs.id);
      tags = res.tags || [];
      state.set('tags', tags);
    } catch {
      // fall back to cached tags
    }
    renderList(tags);
  };
  refreshTags();

  const handleCreate = async () => {
    const name = (createInput?.value || '').trim().replace(/^[#\s]+/, '');
    if (!name) return;
    try {
      await api.createTag({ workspaceId: activeWs.id, name });
      if (createInput) createInput.value = '';
      showToast(`Label "${name}" created`, 'success', 1500);
      const res = await api.listTags(activeWs.id);
      state.set('tags', res.tags || []);
      renderList(res.tags || []);
      toggleLabel(name, true);
    } catch (err) {
      showToast(err.message || 'Failed to create label', 'error');
    }
  };

  if (createBtn) createBtn.onclick = (e) => { e.stopPropagation(); handleCreate(); };
  if (createInput) {
    createInput.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreate();
      }
    };
  }
}

export function openPalettePopover(anchorEl, targetMemoOrContext, onUpdate = null) {
  const popover = document.getElementById('keep-popover-palette');
  if (!popover || !anchorEl) return;
  positionPopover(popover, anchorEl);

  const isQC = !targetMemoOrContext.id;
  const currentMemo = isQC ? null : targetMemoOrContext;
  const currentColor = isQC ? (targetMemoOrContext.color || 'default') : (currentMemo.color || 'default');
  const currentTheme = isQC ? (targetMemoOrContext.theme || 'none') : (currentMemo.theme || 'none');

  popover.querySelectorAll('.keep-swatch').forEach((swatch) => {
    swatch.classList.toggle('active', swatch.dataset.color === currentColor);
    swatch.onclick = async (e) => {
      e.stopPropagation();
      const color = swatch.dataset.color;
      popover.querySelectorAll('.keep-swatch').forEach((s) => s.classList.remove('active'));
      swatch.classList.add('active');

      if (isQC) {
        targetMemoOrContext.color = color;
        applyQuickCapturePalette(targetMemoOrContext);
      } else {
        currentMemo.color = color;
        applyMemoCardPalette(currentMemo);
        try {
          await api.updateMemo(currentMemo.id, { color, version: currentMemo.version });
          currentMemo.version = (currentMemo.version || 1) + 1;
        } catch (err) {
          showToast('Failed to update color', 'error');
        }
      }
      if (typeof onUpdate === 'function') onUpdate(color, 'color');
      closeKeepPopovers();
    };
  });

  popover.querySelectorAll('.keep-theme-pill').forEach((pill) => {
    pill.classList.toggle('active', pill.dataset.theme === currentTheme);
    pill.onclick = async (e) => {
      e.stopPropagation();
      const theme = pill.dataset.theme;
      popover.querySelectorAll('.keep-theme-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');

      if (isQC) {
        targetMemoOrContext.theme = theme;
        applyQuickCapturePalette(targetMemoOrContext);
      } else {
        currentMemo.theme = theme;
        applyMemoCardPalette(currentMemo);
        try {
          await api.updateMemo(currentMemo.id, { theme, version: currentMemo.version });
          currentMemo.version = (currentMemo.version || 1) + 1;
        } catch (err) {
          showToast('Failed to update theme', 'error');
        }
      }
      if (typeof onUpdate === 'function') onUpdate(theme, 'theme');
      closeKeepPopovers();
    };
  });
}

export function openReminderPopover(anchorEl, targetMemoOrContext, onUpdate = null) {
  const popover = document.getElementById('keep-popover-reminder');
  if (!popover || !anchorEl) return;
  positionPopover(popover, anchorEl);

  const isQC = !targetMemoOrContext.id;
  const currentMemo = isQC ? null : targetMemoOrContext;

  const setReminder = async (timestamp) => {
    if (isQC) {
      targetMemoOrContext.reminderTime = timestamp;
    } else {
      currentMemo.reminderTime = timestamp;
      applyMemoReminderChip(currentMemo);
      try {
        await api.updateMemo(currentMemo.id, { reminderTime: timestamp, version: currentMemo.version });
        currentMemo.version = (currentMemo.version || 1) + 1;
        showToast('Reminder saved', 'success', 1800);
      } catch (err) {
        showToast('Failed to set reminder', 'error');
      }
    }
    if (typeof onUpdate === 'function') onUpdate(timestamp);
    closeKeepPopovers();
  };

  popover.querySelectorAll('[data-reminder-preset]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const preset = btn.dataset.reminderPreset;
      const now = new Date();
      let targetDate = new Date();

      if (preset === 'today') {
        targetDate.setHours(18, 0, 0, 0);
        if (targetDate.getTime() <= now.getTime()) {
          targetDate = new Date(now.getTime() + 2 * 3600000);
        }
      } else if (preset === 'tomorrow') {
        targetDate.setDate(now.getDate() + 1);
        targetDate.setHours(8, 0, 0, 0);
      } else if (preset === 'next_week') {
        const day = now.getDay();
        const diff = (day === 0 ? 1 : 8 - day);
        targetDate.setDate(now.getDate() + diff);
        targetDate.setHours(8, 0, 0, 0);
      }
      setReminder(targetDate.getTime());
    };
  });

  const customBtn = document.getElementById('keep-reminder-save-custom');
  if (customBtn) {
    customBtn.onclick = (e) => {
      e.stopPropagation();
      const customInput = document.getElementById('keep-reminder-custom-date');
      if (customInput && customInput.value) {
        const time = new Date(customInput.value).getTime();
        if (!isNaN(time)) setReminder(time);
      }
    };
  }
}

export function openCollabPopover(anchorEl, memo, onUpdate = null) {
  const popover = document.getElementById('keep-popover-collab');
  if (!popover || !anchorEl) return;
  positionPopover(popover, anchorEl);

  const listContainer = document.getElementById('keep-popover-collab-list');
  const renderCollabList = () => {
    if (!listContainer) return;
    const collabs = memo.collaborators || [];
    if (!collabs.length) {
      listContainer.innerHTML = '<div style="font-size:0.8rem; color:var(--text-muted); padding:0.4rem 0;">No collaborators added yet.</div>';
      return;
    }
    listContainer.innerHTML = collabs.map((c, i) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:0.3rem 0; border-bottom:1px solid var(--border-color);">
        <div style="display:flex; align-items:center; gap:0.4rem;">
          <span style="width:20px; height:20px; border-radius:50%; background:var(--color-primary-600); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:0.65rem;">${(c.name || c.email || 'C').charAt(0).toUpperCase()}</span>
          <span style="font-size:0.8rem;">${escapeHtml(c.email || c.name)}</span>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-collab-remove="${i}" style="color:var(--color-red); padding:0.1rem 0.3rem;">✕</button>
      </div>
    `).join('');

    listContainer.querySelectorAll('[data-collab-remove]').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const idx = Number(btn.dataset.collabRemove);
        collabs.splice(idx, 1);
        renderCollabList();
        if (typeof onUpdate === 'function') onUpdate(collabs);
        try {
          await api.updateMemo(memo.id, { collaborators: collabs, version: memo.version });
          memo.version = (memo.version || 1) + 1;
        } catch {}
      };
    });
  };

  renderCollabList();

  const addBtn = document.getElementById('keep-collab-add-btn');
  const emailInput = document.getElementById('keep-collab-email-input');
  if (addBtn && emailInput) {
    addBtn.onclick = async (e) => {
      e.stopPropagation();
      const email = emailInput.value.trim();
      if (!email || !email.includes('@')) {
        showToast('Please enter a valid email address', 'error');
        return;
      }
      memo.collaborators = memo.collaborators || [];
      memo.collaborators.push({ email, name: email.split('@')[0] });
      emailInput.value = '';
      renderCollabList();
      if (typeof onUpdate === 'function') onUpdate(memo.collaborators);
      try {
        await api.updateMemo(memo.id, { collaborators: memo.collaborators, version: memo.version });
        memo.version = (memo.version || 1) + 1;
        showToast(`Added ${email}`, 'success');
      } catch (err) {
        showToast('Failed to add collaborator', 'error');
      }
    };
  }
}

export function applyMemoCardPalette(memo) {
  const validColors = ['default','red','orange','yellow','green','teal','blue','darkblue','purple','pink','brown','gray'];
  const validThemes = ['grocery','food','music','recipes','places','celebration'];

  const card = document.querySelector(`.memo-card[data-memo-id="${memo.id}"]`);
  if (card) {
    validColors.forEach((c) => card.classList.remove(`memo-color-${c}`));
    validThemes.forEach((t) => card.classList.remove(`memo-theme-${t}`));
    card.classList.add(`memo-color-${memo.color && validColors.includes(memo.color) ? memo.color : 'default'}`);
    if (memo.theme && memo.theme !== 'none') card.classList.add(`memo-theme-${memo.theme}`);
  }

  const modalCard = document.getElementById('keep-modal-card');
  if (modalCard) {
    validColors.forEach((c) => modalCard.classList.remove(`memo-color-${c}`));
    validThemes.forEach((t) => modalCard.classList.remove(`memo-theme-${t}`));
    modalCard.classList.add(`memo-color-${memo.color && validColors.includes(memo.color) ? memo.color : 'default'}`);
    if (memo.theme && memo.theme !== 'none') modalCard.classList.add(`memo-theme-${memo.theme}`);
  }
}

export function applyMemoReminderChip(memo) {
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

export function applyQuickCapturePalette(draft) {
  const form = document.getElementById('quick-capture-form');
  if (!form) return;
  const validColors = ['default','red','orange','yellow','green','teal','blue','darkblue','purple','pink','brown','gray'];
  const validThemes = ['grocery','food','music','recipes','places','celebration'];

  validColors.forEach((c) => form.classList.remove(`memo-color-${c}`));
  validThemes.forEach((t) => form.classList.remove(`memo-theme-${t}`));

  form.classList.add(`memo-color-${draft.color && validColors.includes(draft.color) ? draft.color : 'default'}`);
  if (draft.theme && draft.theme !== 'none') {
    form.classList.add(`memo-theme-${draft.theme}`);
  }
}
