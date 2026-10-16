/**
 * Sidebar Navigation & Taxonomy Controller
 * Renders categories, labels/tags, folders, and workspace switcher items.
 */

import { api } from './api.js';
import { state } from './state.js';
import { escapeHtml } from './markdown.js';
import { showToast } from './utils.js';
import { setFilter, closeMobileSidebar } from './search-filter.js';
import { refreshWorkspaceMemos } from './workspace-data.js';

export function renderSidebarCategories(categories) {
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
        <button type="button" class="tag-filter-trigger" data-cat-filter="${escapeHtml(cat.name)}" aria-label="Filter notes by ${escapeHtml(cat.name)}">
          <span class="workspace-bullet" style="background-color: ${color};"></span>
          <span class="ws-item-name">${escapeHtml(cat.name)}</span>
          <span class="tag-count">${count}</span>
        </button>
        ${cat.id ? `
          <span class="tag-management-actions">
            <button type="button" data-cat-edit="${cat.id}" aria-label="Rename ${escapeHtml(cat.name)}" title="Rename category">✎</button>
            <button type="button" data-cat-delete="${cat.id}" aria-label="Delete ${escapeHtml(cat.name)}" title="Delete category">×</button>
          </span>
        ` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-cat-filter]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      setFilter('category', el.dataset.catFilter);
      closeMobileSidebar();
    });
  });

  container.querySelectorAll('[data-cat-edit]').forEach((el) => {
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cat = cats.find((item) => item.id === el.dataset.catEdit);
      if (!cat) return;
      const value = window.prompt('Rename category', cat.name);
      if (value === null) return;
      const name = value.trim();
      if (!name) return showToast('Category name is required', 'error');
      try {
        await api.updateCategory(cat.id, { name, workspaceId: state.get('activeWorkspace')?.id });
        if (state.get('activeFilter')?.type === 'category' && state.get('activeFilter')?.value === cat.name) {
          state.set('activeFilter', { type: 'category', value: name });
        }
        await refreshWorkspaceMemos();
        showToast('Category renamed', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to rename category', 'error');
      }
    });
  });

  container.querySelectorAll('[data-cat-delete]').forEach((el) => {
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cat = cats.find((item) => item.id === el.dataset.catDelete);
      if (!cat || !window.confirm(`Delete category "${cat.name}"?`)) return;
      try {
        await api.deleteCategory(cat.id, state.get('activeWorkspace')?.id);
        if (state.get('activeFilter')?.type === 'category' && state.get('activeFilter')?.value === cat.name) {
          setFilter('all');
        }
        await refreshWorkspaceMemos();
        showToast('Category deleted', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to delete category', 'error');
      }
    });
  });
}

export function renderSidebarTags(tags) {
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

export function renderSidebarFolders(folders) {
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
        <button type="button" class="tag-filter-trigger" data-folder-filter="${escapeHtml(folder.id)}" aria-label="Filter notes by folder ${escapeHtml(folder.name)}">
          <span style="color: var(--text-muted); font-size: 0.8rem;">📁</span>
          <span class="ws-item-name">${escapeHtml(folder.name)}</span>
          <span class="tag-count">${count}</span>
        </button>
        ${folder.id ? `
          <span class="tag-management-actions">
            <button type="button" data-folder-edit="${folder.id}" aria-label="Rename folder" title="Rename folder">✎</button>
            <button type="button" data-folder-delete="${folder.id}" aria-label="Delete folder" title="Delete folder">×</button>
          </span>
        ` : ''}
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-folder-filter]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      setFilter('folder', el.dataset.folderFilter);
      closeMobileSidebar();
    });
  });

  container.querySelectorAll('[data-folder-edit]').forEach((el) => {
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      const folder = folderList.find((f) => f.id === el.dataset.folderEdit);
      if (!folder) return;
      const value = window.prompt('Rename folder', folder.name);
      if (value === null) return;
      const name = value.trim();
      if (!name) return showToast('Folder name is required', 'error');
      try {
        await api.updateFolder(folder.id, { name, workspaceId: state.get('activeWorkspace')?.id });
        await refreshWorkspaceMemos();
        showToast('Folder renamed', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to rename folder', 'error');
      }
    });
  });

  container.querySelectorAll('[data-folder-delete]').forEach((el) => {
    el.addEventListener('click', async (event) => {
      event.stopPropagation();
      const folder = folderList.find((f) => f.id === el.dataset.folderDelete);
      if (!folder || !window.confirm(`Delete folder "${folder.name}"?`)) return;
      try {
        await api.deleteFolder(folder.id, state.get('activeWorkspace')?.id);
        if (state.get('activeFilter')?.type === 'folder' && state.get('activeFilter')?.value === folder.id) {
          setFilter('all');
        }
        await refreshWorkspaceMemos();
        showToast('Folder deleted', 'success');
      } catch (error) {
        showToast(error.message || 'Unable to delete folder', 'error');
      }
    });
  });
}

export function renderWorkspacesList(workspaces) {
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

export function updateSidebarBadges() {
  const allMemos = state.get('allWorkspaceMemos') || [];
  const activeMemos = allMemos.filter((m) => !m.deletedAt);
  const streamMemos = activeMemos.filter((m) => !m.isArchived);
  const archivedMemos = activeMemos.filter((m) => !!m.isArchived);
  const reminderMemos = activeMemos.filter((m) => !m.isArchived && (m.reminderTime || m.dueDate));

  const countAll = document.getElementById('sidebar-count-all');
  const countFav = document.getElementById('sidebar-count-fav');
  const countPinned = document.getElementById('sidebar-count-pinned');
  const countDue = document.getElementById('sidebar-count-due');
  const countReminders = document.getElementById('sidebar-count-reminders');
  const countArchive = document.getElementById('sidebar-count-archive');

  const now = Date.now();
  const nextWeek = now + 7 * 86400000;

  if (countAll) countAll.textContent = streamMemos.length;
  if (countFav) countFav.textContent = activeMemos.filter((m) => m.isFavorite).length;
  if (countPinned) countPinned.textContent = streamMemos.filter((m) => m.isPinned).length;
  if (countDue) countDue.textContent = activeMemos.filter((m) => m.dueDate && m.dueDate <= nextWeek).length;
  if (countReminders) countReminders.textContent = reminderMemos.length;
  if (countArchive) countArchive.textContent = archivedMemos.length;

  const activeWs = state.get('activeWorkspace');
  if (activeWs && activeWs.id) {
    api.listMemos({ workspaceId: activeWs.id, deletedOnly: 'true', limit: 1 })
      .then((res) => {
        const countTrash = document.getElementById('sidebar-count-trash');
        if (countTrash) countTrash.textContent = res.total ?? 0;
      })
      .catch(() => {});
  }
}
