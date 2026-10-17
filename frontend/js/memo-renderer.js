/**
 * Memo Rendering Engine
 * Renders notes in Google Keep card grid or compact table list views, attaches card toolbars, checklists, and drag-and-drop.
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml } from './markdown.js';
import { showToast, showConfirmDialog, triggerImagePicker } from './utils.js';
import { navigateTo } from './navigation.js';
import { refreshWorkspaceMemos, updateLoadMoreUi } from './workspace-data.js';
import { openKeepNoteModal } from './keep-modal.js';
import { setupCardDragAndDrop } from './keep-dnd.js';
import {
  openPalettePopover,
  openReminderPopover,
  openMoreOptionsPopover
} from './keep-popovers.js';
import { openLightbox } from './keep-lightbox.js';
import { isMemoSelected, toggleSelectMemo, updateSelectionUi } from './keep-selection.js';
import { setFilter } from './search-filter.js';

export function renderMemos(memoList, customHeading = null, bannerMessage = null) {
  const gridContainer = document.getElementById('memos-grid-container');
  const listContainer = document.getElementById('recent-memos-list');
  const headingEl = document.getElementById('memos-view-heading');
  const countEl = document.getElementById('memos-count-indicator');
  const emptyStateEl = document.getElementById('memos-empty-state');
  const activeFilterBanner = document.getElementById('active-filter-banner');
  const activeFilterText = document.getElementById('active-filter-text');

  const viewMode = state.get('viewMode') || localStorage.getItem('memo_view_mode') || 'grid';
  const filter = state.get('activeFilter') || { type: 'all' };
  const isTrash = filter.type === 'trash';

  if (headingEl && customHeading) {
    headingEl.textContent = customHeading;
  }
  if (countEl) {
    countEl.textContent = `Showing ${memoList.length} memo${memoList.length === 1 ? '' : 's'}`;
  }

  if (activeFilterBanner && activeFilterText) {
    if (bannerMessage) {
      activeFilterBanner.style.display = 'flex';
      activeFilterText.textContent = bannerMessage;
    } else {
      activeFilterBanner.style.display = 'none';
    }
  }

  // Dedicated Trash toolbar: the Trash view is a managed destination with its
  // own header, item count and Empty Trash action — not just a filter heading.
  const trashToolbar = document.getElementById('trash-toolbar');
  const trashCountText = document.getElementById('trash-count-text');
  if (trashToolbar) {
    if (isTrash) {
      trashToolbar.style.display = 'flex';
      if (trashCountText) {
        trashCountText.textContent = memoList.length === 0
          ? 'Trash is empty'
          : `${memoList.length} note${memoList.length === 1 ? '' : 's'} in Trash`;
      }
      const emptyBtn = document.getElementById('empty-trash-btn');
      if (emptyBtn) emptyBtn.disabled = memoList.length === 0;
    } else {
      trashToolbar.style.display = 'none';
    }
  }

  if (memoList.length === 0) {
    if (gridContainer) {
      gridContainer.style.display = 'none';
      gridContainer.innerHTML = '';
    }
    if (listContainer) {
      listContainer.style.display = 'none';
      listContainer.innerHTML = '';
    }
    if (!isTrash) updateLoadMoreUi();
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

  if (viewMode === 'grid') {
    if (gridContainer) gridContainer.style.display = 'grid';
    if (listContainer) listContainer.style.display = 'none';
    renderCardGridView(memoList, gridContainer, isTrash);
  } else {
    if (gridContainer) gridContainer.style.display = 'none';
    if (listContainer) listContainer.style.display = 'flex';
    renderListView(memoList, listContainer, isTrash);
  }
  updateLoadMoreUi();
}

export function renderCardGridView(memos, container, isTrash, skipPinnedGrouping = false) {
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

  const validColors = ['default','red','orange','yellow','green','teal','blue','darkblue','purple','pink','brown','gray'];

  container.innerHTML = memos.map((memo) => {
    const isPinned = !!memo.isPinned;
    const isArchived = !!memo.isArchived;
    const memoColor = validColors.includes(memo.color) ? memo.color : 'default';
    const memoTheme = memo.theme && memo.theme !== 'none' ? `memo-theme-${memo.theme}` : '';

    const isSelected = isMemoSelected(memo.id);

    let checklistHtml = '';
    const isChecklist = memo.noteType === 'checklist' || (Array.isArray(memo.checklistData) && memo.checklistData.length > 0);
    if (isChecklist && Array.isArray(memo.checklistData) && memo.checklistData.length > 0) {
      const itemsToShow = memo.checklistData.slice(0, 8);
      checklistHtml = `
        <div class="keep-card-checklist">
          ${itemsToShow.map(item => `
            <div class="keep-checklist-item ${item.checked ? 'completed' : ''}">
              <input type="checkbox" ${item.checked ? 'checked' : ''} data-memo-id="${memo.id}" data-check-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.text || 'Item')}">
              <span class="keep-item-text" style="font-size:0.875rem;">${escapeHtml(item.text || '')}</span>
            </div>
          `).join('')}
          ${memo.checklistData.length > 8 ? `<span style="font-size:0.75rem; color:var(--text-muted); display:block; padding-top:0.25rem;">+${memo.checklistData.length - 8} more items</span>` : ''}
        </div>
      `;
    } else {
      checklistHtml = `<div class="memo-card-snippet">${escapeHtml((memo.snippet || memo.content || '').slice(0, 160))}</div>`;
    }

    let attachmentsHtml = '';
    if (Array.isArray(memo.attachments) && memo.attachments.length > 0) {
      attachmentsHtml = `
        <div class="keep-attachments-preview-grid" style="margin-bottom:0.5rem;">
          ${memo.attachments.slice(0, 4).map(att => `<div class="keep-attachment-item" data-att-id="${escapeHtml(att.id)}" title="Click to view image"><img src="${att.url || att.filePath}" alt="${escapeHtml(att.fileName || 'Attachment')}"></div>`).join('')}
        </div>
      `;
    }

    let linkPreviewsHtml = '';
    if (Array.isArray(memo.linkPreviews) && memo.linkPreviews.length > 0) {
      const lp = memo.linkPreviews[0];
      const lpImage = lp.image || lp.imageUrl || lp.faviconUrl || '';
      let domain = '';
      try { domain = new URL(lp.url).hostname; } catch {}
      linkPreviewsHtml = `
        <a href="${escapeHtml(lp.url)}" target="_blank" rel="noopener noreferrer" class="keep-link-card" style="margin-bottom:0.5rem;">
          ${lpImage ? `<img src="${escapeHtml(lpImage)}" class="keep-link-thumb" alt="">` : ''}
          <div class="keep-link-info">
            <span class="keep-link-title">${escapeHtml(lp.title || lp.url)}</span>
            <span class="keep-link-domain">${escapeHtml(domain || lp.url)}</span>
          </div>
        </a>
      `;
    }

    const tagsHtml = (memo.tags || []).map((t) => `
      <span class="tag-chip" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</span>
    `).join('');

    let reminderHtml = '';
    const remTime = memo.reminderTime || memo.dueDate;
    if (remTime) {
      const d = new Date(remTime);
      const isOverdue = d.getTime() < Date.now();
      const formatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      reminderHtml = `
        <span class="keep-chip-pill reminder ${isOverdue ? 'overdue' : ''}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span>${formatted}</span>
        </span>
      `;
    }

    let collabHtml = '';
    if (Array.isArray(memo.collaborators) && memo.collaborators.length > 0) {
      collabHtml = `
        <div style="display:flex; gap:0.25rem;">
          ${memo.collaborators.map(c => `<span style="width:20px; height:20px; border-radius:50%; background:var(--color-primary-600); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:0.65rem;" title="${escapeHtml(c.email || c.name || '')}">${(c.name || c.email || 'C').charAt(0).toUpperCase()}</span>`).join('')}
        </div>
      `;
    }

    return `
      <div class="memo-card memo-color-${memoColor} ${memoTheme} ${isPinned ? 'pinned' : ''} ${isSelected ? 'is-selected' : ''}" draggable="true" data-memo-id="${memo.id}">
        <button class="keep-card-select-btn ${isSelected ? 'active' : ''}" data-action="select" data-id="${memo.id}" title="Select note" aria-label="Select note">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>
        </button>
        <div class="memo-card-header">
          <h4 class="memo-card-title">${escapeHtml(memo.title || 'Untitled')}</h4>
          <button class="keep-pin-btn ${isPinned ? 'active' : ''}" title="${isPinned ? 'Unpin note' : 'Pin note'}" data-action="pin" data-id="${memo.id}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14v-2l-3-3V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v7l-3 3v2z"></path></svg>
          </button>
        </div>

        ${attachmentsHtml}
        ${checklistHtml}
        ${linkPreviewsHtml}

        <div class="memo-card-chips-row" style="display:flex; flex-wrap:wrap; gap:0.35rem; align-items:center; margin-top:0.4rem;">
          ${reminderHtml}
          ${collabHtml}
          ${tagsHtml}
        </div>

        <div class="memo-card-hover-toolbar">
          ${!isTrash ? `
            <button class="keep-tool-btn" data-action="quick-edit" data-id="${memo.id}" title="Keep In-place Editor">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
            <button class="keep-tool-btn" data-action="remind-popover" data-id="${memo.id}" title="Remind me">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
            </button>
            <button class="keep-tool-btn" data-action="color-popover" data-id="${memo.id}" title="Background options">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M12 2a10 10 0 0 0-9.5 13.1c.3.9 1.1 1.4 2 1.4h1.7c.6 0 1.1.5 1.1 1.1 0 .9.7 1.6 1.6 1.6h.4c5.5 0 9.7-4.5 9.7-10S17.5 2 12 2z"></path></svg>
            </button>
            <button class="keep-tool-btn" data-action="add-image" data-id="${memo.id}" title="Add image">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
            </button>
            <button class="keep-tool-btn ${isArchived ? 'active' : ''}" data-action="archive" data-id="${memo.id}" title="${isArchived ? 'Unarchive' : 'Archive'}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
            </button>
            <button class="keep-tool-btn" data-action="more-options" data-id="${memo.id}" title="More options">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
            </button>
            <button class="keep-tool-btn" data-action="trash" data-id="${memo.id}" title="Delete note">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          ` : `
            <button class="btn btn-outline btn-sm" data-action="restore" data-id="${memo.id}" title="Restore">Restore</button>
            <button class="btn btn-sm" style="color: var(--color-red);" data-action="perm-delete" data-id="${memo.id}" title="Delete">Delete</button>
          `}
        </div>
      </div>
    `;
  }).join('');

  attachMemoItemInteractions(container, memos);
  updateSelectionUi();
}

export function renderListView(memos, container, isTrash, skipPinnedGrouping = false) {
  const filterType = state.get('activeFilter')?.type || 'all';
  if (!skipPinnedGrouping && !isTrash && filterType !== 'pinned') {
    const pinned = memos.filter((memo) => memo.isPinned);
    const regular = memos.filter((memo) => !memo.isPinned);
    if (pinned.length && regular.length) {
      container.innerHTML = '<div class="memo-list-section-heading">📌 Pinned</div><div id="pinned-memo-list"></div><div class="memo-list-section-heading">Others</div><div id="regular-memo-list"></div>';
      renderListView(pinned, container.querySelector('#pinned-memo-list'), isTrash, true);
      renderListView(regular, container.querySelector('#regular-memo-list'), isTrash, true);
      return;
    }
    if (pinned.length && !regular.length) {
      container.innerHTML = '<div class="memo-list-section-heading">📌 Pinned</div><div id="pinned-memo-list"></div>';
      renderListView(pinned, container.querySelector('#pinned-memo-list'), isTrash, true);
      return;
    }
  }
  container.innerHTML = memos.map((memo) => {
    const categoryName = memo.category?.name || memo.category || 'General';
    const isPinned = !!memo.isPinned;
    const isFavorite = !!memo.isFavorite;
    const isArchived = !!memo.isArchived;

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
              ${isPinned ? '📌 ' : ''}${escapeHtml(memo.title || 'Untitled')}
            </span>
            <span class="memo-row-snippet">${escapeHtml((memo.snippet || memo.content || '').slice(0, 90))}</span>
          </div>
        </div>

        <div class="memo-row-meta">
          <span class="badge badge-${categoryName.toLowerCase()}">${escapeHtml(categoryName)}</span>

          ${!isTrash ? `
            <button class="memo-action-icon-btn ${isFavorite ? 'active' : ''}" data-action="fav" data-id="${memo.id}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="${isFavorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            </button>
            <button class="memo-action-icon-btn ${isArchived ? 'active' : ''}" data-action="archive" data-id="${memo.id}" title="${isArchived ? 'Unarchive' : 'Archive'}">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>
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

export function attachMemoItemInteractions(container, memos) {
  // Click on card/row opens editor view (supports fast markdown editing & E2E flows).
  // The in-place Keep modal is opened from the card hover toolbar (quick-edit pencil button).
  // A dblclick binding is intentionally avoided: dblclick also fires two click events,
  // which would navigate to the editor view *before* opening the modal on top of it.
  // Interactive zones (formerly guarded by inline onclick attributes, removed
  // for the strict CSP) are filtered here via one delegated closest() check.
  const INTERACTIVE_ZONES = 'button, a, input, .keep-tool-btn, .tag-chip, .keep-checklist-item, .keep-link-card, .keep-card-checklist, .memo-card-chips-row, .memo-card-hover-toolbar, .memo-row-meta, .keep-attachment-item, .md-image';
  container.querySelectorAll('[data-memo-id]').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.closest(INTERACTIVE_ZONES)) return;
      const id = el.getAttribute('data-memo-id');
      const memo = memos.find((m) => m.id === id);
      if (memo) {
        navigateTo('editor', { memo });
      }
    });
  });

  // Clicking label chip filters grid
  container.querySelectorAll('.tag-chip[data-tag]').forEach((chip) => chip.addEventListener('click', (event) => {
    event.stopPropagation();
    setFilter('tag', chip.getAttribute('data-tag'));
  }));

  // Card interactive checklist item toggle
  container.querySelectorAll('.keep-checklist-item input[type="checkbox"]').forEach((chk) => {
    chk.addEventListener('change', async (e) => {
      e.stopPropagation();
      const memoId = chk.getAttribute('data-memo-id');
      const checkId = chk.getAttribute('data-check-id');
      const memo = memos.find((m) => m.id === memoId);
      if (!memo || !Array.isArray(memo.checklistData)) return;
      const item = memo.checklistData.find((i) => String(i.id) === String(checkId));
      if (!item) return;
      item.checked = chk.checked;
      chk.closest('.keep-checklist-item')?.classList.toggle('completed', chk.checked);
      try {
        await api.updateMemo(memo.id, { checklistData: memo.checklistData, version: memo.version });
        memo.version = (memo.version || 1) + 1;
      } catch {
        showToast('Failed to update checklist item', 'error');
      }
    });
  });

  // Setup HTML5 drag-and-drop manual ordering
  setupCardDragAndDrop(container, memos, () => {
    renderCardGridView(memos, container, false, true);
  });

  // Lightbox click on attachment preview thumbnail
  container.querySelectorAll('.keep-attachment-item[data-att-id]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const memoEl = item.closest('[data-memo-id]');
      const memoId = memoEl?.getAttribute('data-memo-id');
      const attId = item.getAttribute('data-att-id');
      const memo = memos.find((m) => m.id === memoId);
      if (!memo || !Array.isArray(memo.attachments)) return;
      const att = memo.attachments.find((a) => a.id === attId);
      if (att) openLightbox(att, memo);
    });
  });

  // Lightbox click on markdown inline images
  container.querySelectorAll('.md-image').forEach((img) => {
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      const memoEl = img.closest('[data-memo-id]');
      const memoId = memoEl?.getAttribute('data-memo-id');
      const memo = memos.find((m) => m.id === memoId);
      openLightbox({ url: img.src, fileName: img.alt || 'Image' }, memo);
    });
  });

  // Card hover action buttons
  container.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      const memo = memos.find((m) => m.id === id);
      if (!memo) return;

      const rerender = () => { import('./search-filter.js').then(m => m.filterAndRenderMemos()); };

      if (action === 'select') {
        toggleSelectMemo(memo.id);
      } else if (action === 'quick-edit' || action === 'edit') {
        openKeepNoteModal(memo, { onChanged: rerender });
      } else if (action === 'color-popover') {
        openPalettePopover(btn, memo, rerender);
      } else if (action === 'remind-popover') {
        openReminderPopover(btn, memo, rerender);
      } else if (action === 'add-image') {
        triggerImagePicker(async (files) => {
          if (!files.length) return;
          const uploadedImages = [];
          for (const file of files) {
            try {
              const res = await api.uploadAttachment(memo.id, file);
              if (res?.attachment?.url) {
                uploadedImages.push({
                  name: file.name || 'image',
                  url: res.attachment.url
                });
              }
            } catch (err) {
              showToast('Failed to upload image', 'error');
            }
          }
          if (uploadedImages.length > 0 && (memo.noteType === 'text' || !memo.noteType)) {
            const imgMarkdown = uploadedImages.map(img => {
              const cleanName = img.name.replace(/[\[\]\(\)]/g, '_');
              return `![${cleanName}](${img.url})`;
            }).join('\n\n');
            const updatedContent = (memo.content ? `${memo.content}\n\n` : '') + imgMarkdown;
            try {
              await api.updateMemo(memo.id, { content: updatedContent });
              memo.content = updatedContent;
            } catch (updateErr) {
              console.error('Failed to update memo content with images:', updateErr);
            }
          }
          await refreshWorkspaceMemos();
        });
      } else if (action === 'more-options') {
        openMoreOptionsPopover(btn, memo, {
          onDelete: async (m) => {
            try {
              await api.deleteMemo(m.id, false);
              showToast('Note moved to Trash', 'info', 2000);
              refreshWorkspaceMemos();
            } catch {
              showToast('Failed to move note to trash', 'error');
            }
          },
          onCopy: async (m) => {
            try {
              const activeWs = state.get('activeWorkspace');
              const clone = {
                workspaceId: activeWs?.id || m.workspaceId,
                title: m.title ? `${m.title} (Copy)` : 'Untitled Copy',
                content: m.content || '',
                color: m.color || 'default',
                theme: m.theme || 'none',
                noteType: m.noteType || 'text',
                checklistData: m.checklistData || null,
                tags: m.tags || [],
                categoryId: m.categoryId || null,
                folderId: m.folderId || null,
                priority: m.priority || 'medium',
                status: m.status || 'pending',
                dueDate: m.dueDate || null,
                reminderTime: m.reminderTime || null
              };
              await api.createMemo(clone);
              showToast('Note copied', 'success', 1800);
              await refreshWorkspaceMemos();
            } catch (err) {
              showToast('Failed to copy note', 'error');
            }
          },
          onCopyText: (m) => {
            const text = [m.title, m.content].filter(Boolean).join('\n\n');
            if (navigator.clipboard) {
              navigator.clipboard.writeText(text);
              showToast('Note text copied to clipboard', 'info', 1800);
            }
          }
        });
      } else if (action === 'archive') {
        try {
          const newArchived = !memo.isArchived;
          await api.updateMemo(memo.id, { isArchived: newArchived, version: memo.version });
          memo.isArchived = newArchived;
          memo.version = (memo.version || 1) + 1;
          showToast(newArchived ? 'Note archived' : 'Note unarchived', 'info', 1800);
          await refreshWorkspaceMemos();
        } catch {
          showToast('Failed to toggle archive', 'error');
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
          showToast(memo.isPinned ? 'Note pinned to top' : 'Note unpinned', 'info', 1500);
          refreshWorkspaceMemos();
        } catch {
          showToast('Failed to toggle pin', 'error');
        }
      } else if (action === 'trash') {
        try {
          await api.deleteMemo(memo.id, false);
          showToast('Note moved to Trash', 'info', 2500);
          refreshWorkspaceMemos();
        } catch {
          showToast('Failed to move note to trash', 'error');
        }
      } else if (action === 'restore') {
        try {
          await api.restoreMemo(memo.id);
          showToast('Note restored from Trash', 'success', 2000);
          refreshWorkspaceMemos();
        } catch {
          showToast('Failed to restore note', 'error');
        }
      } else if (action === 'perm-delete') {
        showConfirmDialog('Delete Note Permanently', 'This action cannot be undone. Are you sure you want to permanently delete this note?', async () => {
          try {
            await api.deleteMemo(memo.id, true);
            showToast('Note permanently deleted', 'info', 2000);
            refreshWorkspaceMemos();
          } catch {
            showToast('Failed to permanently delete note', 'error');
          }
        });
      }
    });
  });
}

export function formatReminderDate(timestamp) {
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

export function renderUpcomingReminders() {
  const container = document.getElementById('upcoming-reminders-list');
  if (!container) return;
  const now = Date.now();
  const nextWeek = now + 7 * 86400000;
  const reminders = (state.get('allWorkspaceMemos') || [])
    .filter((memo) => {
      if (memo.deletedAt || memo.isArchived) return false;
      const time = Number(memo.reminderTime || memo.dueDate) || 0;
      return time > 0 && time <= nextWeek && (memo.status || '').toLowerCase() !== 'completed';
    })
    .sort((a, b) => Number(a.reminderTime || a.dueDate) - Number(b.reminderTime || b.dueDate))
    .slice(0, 6);
  container.replaceChildren();
  if (!reminders.length) {
    const empty = document.createElement('div');
    empty.className = 'reminders-empty-state';
    empty.textContent = 'No upcoming reminders. Add a due date to any note to see it here.';
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
    const remTs = Number(memo.reminderTime || memo.dueDate);
    icon.textContent = remTs < now ? '!' : '◷';
    const info = document.createElement('span');
    info.className = 'reminder-info';
    const title = document.createElement('span');
    title.className = 'reminder-title';
    title.textContent = memo.title || 'Untitled note';
    const time = document.createElement('span');
    time.className = 'reminder-time';
    time.textContent = remTs < now ? `Overdue · ${formatReminderDate(remTs)}` : formatReminderDate(remTs);
    info.append(title, time);
    item.append(icon, info);
    item.addEventListener('click', () => openKeepNoteModal(memo, { onChanged: () => { import('./search-filter.js').then(m => m.filterAndRenderMemos()); } }));
    container.append(item);
  }
}
