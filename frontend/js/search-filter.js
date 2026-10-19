/**
 * Search & Filtering Controller
 * Full-text search (SQLite FTS5), tag/category/color/type filters, and memo sorting.
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { renderMemos } from './memo-renderer.js';

let searchDebounceTimeout = null;

// Trash pagination bookkeeping (server caps pages at 100 memos)
const trashPagination = { loadedCount: 0, total: 0, loadingMore: false, pagesLoaded: 0 };

export function getTrashPagination() {
  return { ...trashPagination };
}

/** Fetch one page of trash (deletedOnly) and merge into the cached trash list. */
async function fetchTrashPage(page = 1) {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id) return [];
  const res = await api.listMemos({
    workspaceId: activeWs.id,
    deletedOnly: 'true',
    page,
    limit: 100,
  });
  const list = (res.memos || []).filter((m) => m.deletedAt !== null);
  trashPagination.total = res.total ?? list.length;
  const prev = page > 1 ? state.get('trashMemos') || [] : [];
  const seen = new Set(prev.map((m) => m.id));
  const merged = prev.concat(list.filter((m) => !seen.has(m.id)));
  trashPagination.loadedCount = merged.length;
  trashPagination.pagesLoaded = page === 1 ? 1 : Math.max(trashPagination.pagesLoaded, page);
  state.set('trashMemos', merged);
  return merged;
}

/** Load the next page of trash ("Load more" button while viewing Trash). */
export async function loadMoreTrashMemos() {
  if (trashPagination.loadingMore) return;
  if (trashPagination.total <= trashPagination.loadedCount) return;
  trashPagination.loadingMore = true;
  try {
    await fetchTrashPage(Math.floor(trashPagination.loadedCount / 100) + 1);
  } finally {
    trashPagination.loadingMore = false;
  }
}

export function setupSearchInput() {
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

export function closeMobileSidebar() {
  document.getElementById('app-sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('active');
}

export function setFilter(type, value = null) {
  state.set('activeFilter', { type, value });

  document.querySelectorAll('.app-sidebar .sidebar-nav-item').forEach((item) => {
    item.classList.remove('active');
  });

  const filterToNavId = {
    all: 'side-nav-all',
    notes: 'side-nav-all',
    reminders: 'side-nav-reminders',
    archive: 'side-nav-archive',
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

  // Toggle dashboard overview mode (shows KPI cards, hero header, 2-column grid with calendar & reminders)
  document.getElementById('view-dashboard')?.classList.toggle('dashboard-overview-mode', type === 'dashboard');

  const searchInput = document.getElementById('global-search-input');
  if (searchInput && state.get('searchQuery')) {
    searchInput.value = '';
    state.set('searchQuery', '');
  }

  filterAndRenderMemos();
  closeMobileSidebar();
}

export async function filterAndRenderMemos() {
  const filter = state.get('activeFilter') || { type: 'all', value: null };
  const allMemos = state.get('allWorkspaceMemos') || [];
  // Status filter
  const statusFilter = document.getElementById('filter-status-select')?.value || '';
  const priorityFilter = document.getElementById('filter-priority-select')?.value || '';
  const typeFilter = document.getElementById('filter-type-select')?.value || '';
  const colorFilter = document.getElementById('filter-color-select')?.value || '';
  const sortOrder = document.getElementById('sort-memos-select')?.value || 'updatedAt:desc';

  let filtered = [];
  let filterHeading = 'Notes';
  let bannerText = '';

  if (filter.type === 'trash') {
    filterHeading = 'Trash';
    // The dedicated trash toolbar (#trash-toolbar) carries the Trash UI — the
    // generic filter banner stays hidden for this view.
    bannerText = '';

    const activeWs = state.get('activeWorkspace');
    if (activeWs && activeWs.id) {
      try {
        // Refresh page 1 on every render (keeps restore/delete in sync), then
        // re-merge any extra pages the user previously loaded.
        const pagesToReload = Math.max(1, trashPagination.pagesLoaded || 1);
        await fetchTrashPage(1);
        for (let p = 2; p <= pagesToReload; p++) {
          await fetchTrashPage(p);
        }
        filtered = state.get('trashMemos') || [];
      } catch {
        filtered = [];
      }
    }
  } else if (filter.type === 'archive') {
    filterHeading = 'Archive';
    bannerText = 'Notes in Archive. Notes here are kept safe and hidden from your main notes stream.';
    filtered = allMemos.filter((m) => !m.deletedAt && !!m.isArchived);
  } else if (filter.type === 'reminders') {
    filterHeading = 'Reminders';
    bannerText = 'Notes with active reminders.';
    filtered = allMemos.filter((m) => !m.deletedAt && !m.isArchived && (m.reminderTime || m.dueDate));
  } else {
    let base = allMemos.filter((m) => !m.deletedAt && !m.isArchived);

    if (filter.type === 'favorites') {
      base = base.filter((m) => m.isFavorite);
      filterHeading = 'Favorites';
      bannerText = 'Filtered by Favorites';
    } else if (filter.type === 'pinned') {
      base = base.filter((m) => m.isPinned);
      filterHeading = 'Pinned Notes';
      bannerText = 'Filtered by Pinned Notes';
    } else if (filter.type === 'dueSoon') {
      const now = Date.now();
      const nextWeek = now + 7 * 86400000;
      base = base.filter((m) => (m.reminderTime || m.dueDate) && Number(m.reminderTime || m.dueDate) <= nextWeek && (m.status || '').toLowerCase() !== 'completed');
      filterHeading = 'Upcoming & Overdue';
      bannerText = 'Notes that are overdue or due within the next 7 days';
    } else if (filter.type === 'dueDate' && filter.value) {
      const { start, end, label } = filter.value;
      base = base.filter((m) => (m.reminderTime || m.dueDate) && Number(m.reminderTime || m.dueDate) >= start && Number(m.reminderTime || m.dueDate) < end);
      filterHeading = `Due on ${label}`;
      bannerText = `Notes scheduled for ${label}`;
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
    } else if (filter.type === 'all' || filter.type === 'notes') {
      filterHeading = 'Notes';
      bannerText = '';
    }

    filtered = base;
  }

  if (statusFilter) {
    filtered = filtered.filter((m) => (m.status || '').toLowerCase() === statusFilter.toLowerCase());
  }
  if (priorityFilter) {
    filtered = filtered.filter((m) => (m.priority || '').toLowerCase() === priorityFilter.toLowerCase());
  }
  if (colorFilter) {
    filtered = filtered.filter((m) => (m.color || 'default').toLowerCase() === colorFilter.toLowerCase());
  }
  if (typeFilter) {
    if (typeFilter === 'checklist') {
      filtered = filtered.filter((m) => m.noteType === 'checklist' || (Array.isArray(m.checklistData) && m.checklistData.length > 0));
    } else if (typeFilter === 'image') {
      filtered = filtered.filter((m) => Array.isArray(m.attachments) && m.attachments.some((a) => (a.mimeType || '').startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.fileName || a.filePath || '')));
    } else if (typeFilter === 'drawing') {
      filtered = filtered.filter((m) => Array.isArray(m.attachments) && m.attachments.some((a) => (a.fileName || '').toLowerCase().includes('drawing') || (a.filePath || '').toLowerCase().includes('drawing')));
    } else if (typeFilter === 'reminder') {
      filtered = filtered.filter((m) => m.reminderTime || m.dueDate);
    } else if (typeFilter === 'text') {
      filtered = filtered.filter((m) => m.noteType !== 'checklist' && (!m.attachments || m.attachments.length === 0));
    }
  }

  const [sortField, sortDirection] = sortOrder.split(':');
  filtered.sort((a, b) => {
    let valA = a[sortField];
    let valB = b[sortField];

    if (sortField === 'sortOrder') {
      // Custom (manual) order set via drag & drop. Newer notes win on ties.
      valA = Number(a.sortOrder || 0);
      valB = Number(b.sortOrder || 0);
      if (valA === valB) return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
      return sortDirection === 'asc' ? valA - valB : valB - valA;
    }
    if (sortField === 'title') {
      valA = (a.title || '').toLowerCase();
      valB = (b.title || '').toLowerCase();
      return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    }
    if (sortField === 'dueDate') {
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
    valA = a.updatedAt || a.createdAt || 0;
    valB = b.updatedAt || b.createdAt || 0;
    return sortDirection === 'asc' ? valA - valB : valB - valA;
  });

  renderMemos(filtered, filterHeading, bannerText);

  // Sync mobile quick filter tabs
  const mobileTabs = document.querySelectorAll('.mobile-filter-tab');
  if (mobileTabs.length) {
    mobileTabs.forEach((tab) => {
      const tabFilter = tab.getAttribute('data-mobile-filter');
      const isActive = (tabFilter === 'favorite' && filter.type === 'favorites')
        || (tabFilter === 'pending' && statusFilter.toLowerCase() === 'pending')
        || (tabFilter === 'all' && filter.type !== 'favorites' && statusFilter.toLowerCase() !== 'pending');
      tab.classList.toggle('active', isActive);
    });
  }
}
