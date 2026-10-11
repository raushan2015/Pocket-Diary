/**
 * Workspace Data & Storage Quota Synchronization Controller
 * Fetches memos, categories, tags, folders, and storage metrics for the active workspace.
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { broadcastSync } from './keep-sync.js';
import { currentCalYear, currentCalMonth, renderInteractiveCalendar } from './calendar.js';
import {
  renderSidebarCategories,
  renderSidebarTags,
  renderSidebarFolders,
  updateSidebarBadges
} from './sidebar.js';
import { renderUpcomingReminders } from './memo-renderer.js';
import { filterAndRenderMemos, setFilter } from './search-filter.js';

export async function fetchWorkspaceData() {
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

    state.updateKpisFromMemos(memos);

    updateDashboardDateBadge();
    api.getStorageQuota(activeWs.id)
      .then((quota) => {
        const percentText = document.getElementById('storage-percent-text');
        const detailText = document.getElementById('storage-detail-text');
        const fill = document.getElementById('storage-progress-fill');
        if (percentText) percentText.textContent = `${quota.percentUsed}%`;
        if (detailText) detailText.textContent = `${quota.usedFormatted} of ${quota.maxFormatted}`;
        if (fill) fill.style.width = `${quota.percentUsed}%`;
      })
      .catch(() => {});

    renderSidebarCategories(categories);
    renderSidebarTags(tags);
    renderSidebarFolders(folders);
    updateSidebarBadges();
    renderInteractiveCalendar(currentCalYear, currentCalMonth, (range) => {
      setFilter('dueDate', range);
      document.getElementById('memos-view-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    renderUpcomingReminders();

    filterAndRenderMemos();
  } catch (err) {
    console.error('Error fetching workspace data:', err);
    showToast('Failed to load workspace memos from server', 'error');
  } finally {
    state.set('isLoadingMemos', false);
  }
}

export async function refreshWorkspaceMemos(broadcast = true) {
  await fetchWorkspaceData();
  if (broadcast) {
    broadcastSync('memos_changed');
  }
}

export function updateDashboardDateBadge() {
  const dateBadge = document.getElementById('dashboard-date-badge');
  if (dateBadge) {
    const now = new Date();
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    dateBadge.textContent = now.toLocaleDateString('en-US', options);
  }
}
