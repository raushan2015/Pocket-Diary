/**
 * Workspace Data & Storage Quota Synchronization Controller
 * Fetches memos, categories, tags, folders, and storage metrics for the active workspace.
 * Memos are loaded page-by-page (server caps pages at 100); a "Load more" control
 * appends the next page so workspaces with many notes stay complete.
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
import { filterAndRenderMemos, setFilter, loadMoreTrashMemos, getTrashPagination } from './search-filter.js';

const MEMOS_PAGE_SIZE = 100;

// Pagination bookkeeping for the memo list
const memosPagination = {
  loadedCount: 0,
  total: 0,
  loadingMore: false,
};

export function getMemosPagination() {
  return { ...memosPagination };
}

/** Which pagination state is active right now (trash view pages the deleted list). */
function activePagination() {
  const filter = state.get('activeFilter') || { type: 'all' };
  return filter.type === 'trash' ? getTrashPagination() : { ...memosPagination };
}

/** Update the "Load more" button visibility and meta text. */
export function updateLoadMoreUi() {
  const row = document.getElementById('load-more-row');
  const btn = document.getElementById('load-more-btn');
  const meta = document.getElementById('load-more-meta');
  if (!row || !btn) return;

  const pagination = activePagination();
  const hasMore = pagination.total > pagination.loadedCount;
  row.style.display = hasMore ? 'flex' : 'none';
  if (hasMore && meta) {
    const label = state.get('activeFilter')?.type === 'trash' ? 'deleted notes' : 'notes';
    meta.textContent = `${pagination.loadedCount} of ${pagination.total} ${label} loaded`;
  }
  btn.disabled = pagination.loadingMore;
  btn.textContent = pagination.loadingMore ? 'Loading…' : 'Load more notes';
}

/** Load the next page for the current view (stream or trash). */
export async function loadMoreMemos() {
  const filter = state.get('activeFilter') || { type: 'all' };
  if (filter.type === 'trash') {
    await loadMoreTrashMemos();
    await filterAndRenderMemos();
    updateLoadMoreUi();
    return;
  }

  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id || memosPagination.loadingMore) return;
  if (memosPagination.total <= memosPagination.loadedCount) return;

  memosPagination.loadingMore = true;
  updateLoadMoreUi();

  try {
    const nextPage = Math.floor(memosPagination.loadedCount / MEMOS_PAGE_SIZE) + 1;
    const res = await api.listMemos({
      workspaceId: activeWs.id,
      page: nextPage,
      limit: MEMOS_PAGE_SIZE,
    });

    const existing = state.get('allWorkspaceMemos') || [];
    const incoming = res.memos || [];
    const seen = new Set(existing.map((m) => m.id));
    const merged = existing.concat(incoming.filter((m) => !seen.has(m.id)));

    memosPagination.total = res.total ?? merged.length;
    memosPagination.loadedCount = merged.length;

    state.set('allWorkspaceMemos', merged);
    state.updateKpisFromMemos(merged);
    updateSidebarBadges();
    renderUpcomingReminders();
    filterAndRenderMemos();
  } catch (err) {
    console.error('Load more failed:', err);
    showToast('Could not load more notes', 'error');
  } finally {
    memosPagination.loadingMore = false;
    updateLoadMoreUi();
  }
}

// Mirrors the backend's default quota (config.storageQuotaBytes, STORAGE_QUOTA_GB).
const DEMO_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

const utf8ByteLength = (value) => new TextEncoder().encode(String(value ?? '')).length;

/** Human-readable byte size with a KB tier, for the client-computed demo meter. */
function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/** Render real storage metrics into the sidebar widget (shape of GET /workspaces/:id/storage). */
export function updateStorageWidget(quota) {
  const percentText = document.getElementById('storage-percent-text');
  const detailText = document.getElementById('storage-detail-text');
  const fill = document.getElementById('storage-progress-fill');
  if (percentText) percentText.textContent = `${quota.percentUsed}%`;
  if (detailText) detailText.textContent = `${quota.usedFormatted} of ${quota.maxFormatted}`;
  if (fill) {
    fill.style.width = `${Math.max(0, Math.min(100, quota.percentUsed))}%`;
    fill.parentElement?.setAttribute('aria-valuenow', String(quota.percentUsed));
  }
}

/** Neutral signed-out state — the widget never shows fabricated numbers. */
export function resetStorageWidget() {
  updateStorageWidget({ percentUsed: 0, usedFormatted: '0 bytes', maxFormatted: '10 GB' });
}

/** Show "unavailable" instead of stale numbers when the quota endpoint fails. */
function markStorageWidgetUnavailable() {
  const percentText = document.getElementById('storage-percent-text');
  const detailText = document.getElementById('storage-detail-text');
  const fill = document.getElementById('storage-progress-fill');
  if (percentText) percentText.textContent = '—';
  if (detailText) detailText.textContent = 'Usage unavailable';
  if (fill) {
    fill.style.width = '0%';
    fill.parentElement?.setAttribute('aria-valuenow', '0');
  }
}

/**
 * Demo workspaces have no server, so compute the meter client-side from the
 * in-memory demo memos. Uses the same formula as the backend (UTF-8 bytes of
 * title + content, per workspace), so the widget shows real numbers instead
 * of the old hardcoded "2.4 GB / 24%" mock.
 */
export function refreshDemoStorageWidget() {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs?.id) return;

  const usedBytes = (state.get('allWorkspaceMemos') || [])
    .filter((memo) => memo.workspaceId === activeWs.id)
    .reduce((sum, memo) => sum + utf8ByteLength(memo.title) + utf8ByteLength(memo.content), 0);

  const percentUsed = usedBytes > 0
    ? Math.min(100, Math.max(0.1, Number(((usedBytes / DEMO_QUOTA_BYTES) * 100).toFixed(1))))
    : 0;

  updateStorageWidget({
    percentUsed,
    usedFormatted: formatBytes(usedBytes),
    maxFormatted: `${(DEMO_QUOTA_BYTES / 1024 ** 3).toFixed(0)} GB`,
  });
}

export async function fetchWorkspaceData() {
  const activeWs = state.get('activeWorkspace');
  if (!activeWs || !activeWs.id) return;
  if (String(activeWs.id).startsWith('demo-')) {
    refreshDemoStorageWidget();
    return;
  }

  state.set('isLoadingMemos', true);

  try {
    const [memosRes, categoriesRes, tagsRes, foldersRes] = await Promise.all([
      api.listMemos({ workspaceId: activeWs.id, limit: MEMOS_PAGE_SIZE }),
      api.listCategories(activeWs.id).catch(() => ({ categories: [] })),
      api.listTags(activeWs.id).catch(() => ({ tags: [] })),
      api.listFolders(activeWs.id).catch(() => ({ folders: [] })),
    ]);

    const memos = (memosRes && memosRes.memos) || [];
    const categories = (categoriesRes && categoriesRes.categories) || [];
    const tags = (tagsRes && tagsRes.tags) || [];
    const folders = (foldersRes && foldersRes.folders) || [];

    memosPagination.total = (memosRes && memosRes.total) ?? memos.length;
    memosPagination.loadedCount = memos.length;

    state.set('allWorkspaceMemos', memos);
    state.set('categories', categories);
    state.set('tags', tags);
    state.set('folders', folders);

    state.updateKpisFromMemos(memos);

    updateDashboardDateBadge();
    api.getStorageQuota(activeWs.id)
      .then(updateStorageWidget)
      .catch(markStorageWidgetUnavailable);

    renderSidebarCategories(categories);
    renderSidebarTags(tags);
    renderSidebarFolders(folders);
    updateSidebarBadges();
    updateLoadMoreUi();
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
