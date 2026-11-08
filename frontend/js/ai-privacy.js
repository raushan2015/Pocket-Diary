/**
 * Pocket Diary AI — per-note privacy controls modal.
 *
 * Opened from the editor toolbar ("AI Privacy") or a note card menu. Manages:
 *  - the note's AI access policy (blocked / current_only / search_allowed),
 *  - protected passages ("never share with AI", stored server-side as salted
 *    hashes bound to the note version — the passage text is never persisted).
 *
 * The backend re-verifies edit authorization (viewer role rejected) for every
 * change; this UI simply mirrors server state.
 */
import { api } from './api.js';
import { state } from './state.js';
import { t, tEsc } from './i18n.js';
import { showToast, openModal, closeModal } from './utils.js';

let initialized = false;
let currentMemoId = null;
let currentWorkspaceId = null;

function qs(id) {
  return document.getElementById(id);
}

async function apiCall(endpoint, options = {}) {
  try {
    const data = await api.request(endpoint, options);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: err?.data ?? { message: err?.message }, status: err?.status ?? 0 };
  }
}

export async function openAiPrivacyModal(memoId) {
  if (!initialized) initAiPrivacy();
  const memo = state.get('activeMemo');
  const workspace = state.get('activeWorkspace');
  if (!memoId && memo) memoId = memo.id;
  if (!workspace?.id) return;
  currentMemoId = memoId;
  currentWorkspaceId = workspace.id;
  if (!memoId) return;
  openModal('modal-ai-privacy');
  // Raise above the chat drawer (z 950) when opened from within it.
  qs('modal-ai-privacy')?.style.setProperty('z-index', '1060');
  await refreshState();
}

async function refreshState() {
  if (!currentMemoId || !currentWorkspaceId) return;
  const res = await apiCall(`/api/v1/ai/memos/${currentMemoId}/protected-sections?workspaceId=${encodeURIComponent(currentWorkspaceId)}`);
  if (!res.ok) {
    showToast(res.data?.message || t('ai.errorLoad'), 'error');
    return;
  }
  // Policy radio
  const policy = res.data.aiAccess ?? 'current_only';
  const radios = document.querySelectorAll('#ai-privacy-options input[name="ai-access"]');
  radios.forEach((radio) => {
    radio.checked = radio.value === policy;
    radio.closest('.ai-privacy-option')?.classList.toggle('selected', radio.checked);
  });
  // Protected passages
  const list = qs('ai-protected-list');
  if (list) {
    list.innerHTML = '';
    for (const section of res.data.sections ?? []) {
      const item = document.createElement('div');
      item.className = 'ai-protected-item';
      const info = document.createElement('span');
      info.textContent = `🔒 ${t('ai.protectedPassage')} (${section.passageLength} ${t('ai.characters')}, v${section.noteVersion})`;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-ghost btn-xs';
      removeBtn.textContent = t('ai.remove');
      removeBtn.addEventListener('click', async () => {
        const update = await apiCall(`/api/v1/ai/memos/${currentMemoId}/protected-sections`, {
          method: 'PUT',
          body: JSON.stringify({ workspaceId: currentWorkspaceId, removeSectionIds: [section.id] }),
        });
        if (update.ok) {
          showToast(t('ai.protectedRemoved'), 'success');
          await refreshState();
        } else {
          showToast(update.data?.message || t('ai.errorSave'), 'error');
        }
      });
      item.appendChild(info);
      item.appendChild(removeBtn);
      list.appendChild(item);
    }
    if ((res.data.sections ?? []).length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-privacy-note';
      empty.textContent = t('ai.protectedNone');
      list.appendChild(empty);
    }
  }
}

async function setPolicy(value) {
  if (!currentMemoId || !currentWorkspaceId) return;
  const res = await apiCall(`/api/v1/ai/memos/${currentMemoId}/privacy`, {
    method: 'PATCH',
    body: JSON.stringify({ workspaceId: currentWorkspaceId, aiAccess: value }),
  });
  if (res.ok) {
    showToast(t('ai.policySaved'), 'success');
    // Reflect immediately in the app state (drives the chat scope indicator).
    const memo = state.get('activeMemo');
    if (memo && memo.id === currentMemoId) {
      state.set('activeMemo', { ...memo, aiAccess: value });
    }
  } else {
    showToast(res.data?.message || t('ai.errorSave'), 'error');
    await refreshState(); // restore the radio to the stored policy
  }
}

async function addProtectedPassage() {
  const input = qs('ai-protected-input');
  const passage = input?.value ?? '';
  if (passage.trim().length < 3) {
    showToast(t('ai.protectedTooShort'), 'error');
    return;
  }
  const res = await apiCall(`/api/v1/ai/memos/${currentMemoId}/protected-sections`, {
    method: 'PUT',
    body: JSON.stringify({ workspaceId: currentWorkspaceId, add: [passage] }),
  });
  if (res.ok) {
    input.value = '';
    showToast(t('ai.protectedAdded'), 'success');
    await refreshState();
  } else {
    showToast(res.data?.message || t('ai.errorSave'), 'error');
  }
}

export function initAiPrivacy() {
  if (initialized) return;
  initialized = true;

  qs('modal-ai-privacy-close-btn')?.addEventListener('click', () => closeModal('modal-ai-privacy'));
  qs('modal-ai-privacy-cancel-btn')?.addEventListener('click', () => closeModal('modal-ai-privacy'));
  document.querySelectorAll('#ai-privacy-options input[name="ai-access"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      if (radio.checked) void setPolicy(radio.value);
      document.querySelectorAll('#ai-privacy-options .ai-privacy-option').forEach((opt) => {
        opt.classList.toggle('selected', opt.querySelector('input')?.checked);
      });
    });
  });
  qs('ai-protected-add-btn')?.addEventListener('click', () => void addProtectedPassage());
}
