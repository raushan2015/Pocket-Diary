/**
 * Pocket Diary AI — provider settings dialog.
 *
 * IMPORTANT (handoff §6): #modal-profile already contains a <form>, so this
 * is a SEPARATE dialog (#modal-ai-settings) with its own buttons — no nested
 * forms anywhere. Provider API keys are typed once, sent to the backend,
 * encrypted at rest, and never displayed again (masked last-4 only).
 * No key value is ever stored in the browser.
 *
 * Model selection UX: the model list is fetched automatically
 *  - while configuring (unsaved form): POST /ai/providers/models-preview uses
 *    the typed key ONCE in memory — it is never persisted;
 *  - for saved configurations: GET /ai/providers/:id/models uses the stored key.
 * The Model field becomes a dropdown of the account's available models; a
 * manual-entry fallback stays available when listing fails.
 */
import { api } from './api.js';
import { t, tEsc } from './i18n.js';
import { showToast, openModal, closeModal, showConfirmDialog } from './utils.js';

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'] },
  { id: 'gemini', label: 'Google Gemini', models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'] },
  { id: 'deepseek', label: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'nvidia_nim', label: 'NVIDIA NIM', models: ['nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'nvidia/nemotron-4-340b-instruct', 'mistralai/mistral-large-2-instruct', 'meta/llama-3.2-90b-vision-instruct', 'deepseek-ai/deepseek-v4.1-flash', 'openai/gpt-oss-20b'] },
];

/** Prefer a known tool-capable chat model when the catalog offers many. */
function preferModelId(ids) {
  const preferences = [
    'nvidia/llama-3.1-nemotron-70b-instruct',
    (id) => /instruct/i.test(id) && !/embed|rerank|guard|reward|safety|parse|ocr|embedqa|neva|clip/i.test(id),
    (id) => /nemotron|flash|large|chat/i.test(id) && !/embed|rerank|guard|reward|safety|parse|ocr|embedqa|neva|clip/i.test(id),
  ];
  for (const pref of preferences) {
    const match = ids.find((id) => (typeof pref === 'string' ? id === pref : pref(id)));
    if (match) return match;
  }
  return ids[0];
}

let initialized = false;
let editingConfigId = null;
let modelFetchTimer = null;
/** Generation counter: only the LATEST fetch may apply its result — slower,
 * stale responses (e.g. an earlier provider's failed listing) must never
 * clobber a dropdown that a newer fetch already populated. */
let modelFetchGeneration = 0;
let savedConfigs = [];
let formDirty = false;

function setModelStatus(message, state = '') {
  const status = qs('ai-config-model-status');
  if (!status) return;
  status.textContent = message;
  status.className = `ai-model-fetch-status ${state}`.trim();
}

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

function providerLabel(id) {
  return PROVIDERS.find((p) => p.id === id)?.label ?? id;
}

export function openAiSettingsDialog() {
  if (!initialized) initAiSettings();
  openModal('modal-ai-settings');
  // Raise above the chat drawer (z 950) when opened from within it; the
  // generic modal stack starts at ~200 which would slide under the drawer.
  qs('modal-ai-settings')?.style.setProperty('z-index', '1060');
  // Always start from a clean form: a previous "Edit" must never leak into a
  // later "Add configuration" (that silently updated the old config instead).
  resetForm();
  void loadConfigs();
}

async function loadConfigs() {
  const list = qs('ai-config-list');
  if (!list) return;
  list.innerHTML = `<div class="ai-history-empty">${tEsc('ai.loading')}</div>`;
  const res = await apiCall('/api/v1/ai/providers');
  if (!res.ok) {
    list.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'ai-config-status fail';
    err.textContent = res.data?.message || t('ai.errorLoadProviders');
    list.appendChild(err);
    return;
  }
  const configs = res.data.configs ?? [];
  savedConfigs = configs;
  qs('ai-vault-warning')?.style.setProperty('display', res.data.vault?.configured ? 'none' : 'block');
  list.innerHTML = '';
  if (configs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ai-history-empty';
    empty.textContent = t('ai.noProvidersYet');
    list.appendChild(empty);
  }
  for (const config of configs) {
    list.appendChild(renderConfigCard(config));
  }
  // Prefill from the default saved key only while the form is untouched.
  // Async refreshes must not overwrite a provider or model being edited.
  if (!editingConfigId && !formDirty && configs.length > 0) {
    const def = configs.find((c) => c.isDefault) ?? configs[0];
    qs('ai-config-provider').value = def.provider;
    updateModelSuggestions();
    showModelWaiting(def.modelId, t('ai.modelsLoading'));
    void fetchModelsForForm({ silent: true, savedConfigId: def.id });
  } else if (!editingConfigId && !formDirty && configs.length === 0) {
    showModelWaiting();
  }
}

function renderConfigCard(config) {
  const card = document.createElement('div');
  card.className = 'ai-config-card';
  card.dataset.configId = config.id;

  const header = document.createElement('div');
  header.className = 'ai-config-card-header';
  const name = document.createElement('span');
  name.className = 'ai-config-provider';
  name.textContent = `${providerLabel(config.provider)} — ${config.label}`;
  if (config.isDefault) {
    const badge = document.createElement('span');
    badge.className = 'badge badge-work';
    badge.textContent = t('ai.defaultBadge');
    name.appendChild(document.createTextNode(' '));
    name.appendChild(badge);
  }
  header.appendChild(name);
  card.appendChild(header);

  const model = document.createElement('div');
  model.className = 'ai-config-model';
  model.textContent = `${t('ai.model')}: ${config.modelId}`;
  card.appendChild(model);

  const key = document.createElement('div');
  key.className = 'ai-config-key';
  key.textContent = `${t('ai.keyMasked')} •••• ${config.keyLast4}`;
  card.appendChild(key);

  const status = document.createElement('div');
  status.className = 'ai-config-status';
  status.dataset.role = 'test-status';
  card.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'ai-config-card-actions';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn btn-outline btn-sm';
  testBtn.textContent = t('ai.testConnection');
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    status.className = 'ai-config-status';
    status.textContent = t('ai.testing');
    const res = await apiCall(`/api/v1/ai/providers/${config.id}/test`, { method: 'POST' });
    testBtn.disabled = false;
    if (res.ok) {
      status.className = `ai-config-status ${res.data.ok ? 'ok' : 'fail'}`;
      status.textContent = `${res.data.ok ? '✓' : '✗'} ${res.data.message}${res.data.latencyMs ? ` (${res.data.latencyMs} ms)` : ''}`;
    } else {
      status.className = 'ai-config-status fail';
      status.textContent = `✗ ${res.data?.message || t('ai.testFailed')}`;
    }
  });
  actions.appendChild(testBtn);

  if (!config.isDefault) {
    const defaultBtn = document.createElement('button');
    defaultBtn.type = 'button';
    defaultBtn.className = 'btn btn-outline btn-sm';
    defaultBtn.textContent = t('ai.setDefault');
    defaultBtn.addEventListener('click', async () => {
      const res = await apiCall(`/api/v1/ai/providers/${config.id}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
      if (res.ok) void loadConfigs();
      else showToast(res.data?.message || t('ai.errorSave'), 'error');
    });
    actions.appendChild(defaultBtn);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn btn-outline btn-sm';
  editBtn.textContent = t('ai.edit');
  editBtn.addEventListener('click', () => {
    startEdit(config);
  });
  actions.appendChild(editBtn);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'btn btn-ghost btn-sm';
  deleteBtn.style.color = 'var(--color-red, #ef4444)';
  deleteBtn.textContent = t('ai.delete');
  deleteBtn.addEventListener('click', () => {
    showConfirmDialog(t('ai.deleteConfirmTitle'), t('ai.deleteConfirmBody'), async () => {
      const res = await apiCall(`/api/v1/ai/providers/${config.id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(t('ai.deleted'), 'success');
        void loadConfigs();
        document.dispatchEvent(new CustomEvent('pd:ai-configs-changed'));
      } else {
        showToast(res.data?.message || t('ai.errorSave'), 'error');
      }
    });
  });
  actions.appendChild(deleteBtn);

  card.appendChild(actions);
  return card;
}

// ---------------------------------------------------------------------------
// Model field: dropdown (fetched) with manual-entry fallback
// ---------------------------------------------------------------------------

function showModelDropdown(models, preferred) {
  const select = qs('ai-config-model-select');
  const input = qs('ai-config-model');
  if (!select || !input) return;
  select.innerHTML = '';
  const sorted = [...models].sort((a, b) => a.id.localeCompare(b.id));
  for (const model of sorted) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.id;
    select.appendChild(opt);
  }
  if (preferred && sorted.some((m) => m.id === preferred)) {
    select.value = preferred;
  } else if (preferred) {
    // Even on initial loading, never silently replace the saved model with
    // the alphabetically first model in an external catalog.
    const existing = document.createElement('option');
    existing.value = preferred;
    existing.textContent = `${preferred} (${t('ai.currentModelNotListed')})`;
    select.prepend(existing);
    select.value = preferred;
  } else {
    const suggestion = preferModelId(sorted.map((m) => m.id));
    if (suggestion) select.value = suggestion;
  }
  select.style.display = '';
  input.style.display = 'none';
  qs('ai-config-model-manual')?.style.setProperty('display', '');
}

/** Keep the dropdown visible while loading and on errors. Existing saved
 * models remain selectable until the user chooses a replacement. */
function showModelWaiting(preferred = '', message = t('ai.enterKeyFirst')) {
  const select = qs('ai-config-model-select');
  const input = qs('ai-config-model');
  if (!select || !input) return;
  select.replaceChildren();
  const option = document.createElement('option');
  option.value = preferred || '';
  option.textContent = preferred || message;
  if (!preferred) option.disabled = true;
  select.appendChild(option);
  select.value = option.value;
  select.style.display = '';
  input.style.display = 'none';
  input.value = preferred;
  qs('ai-config-model-manual')?.style.setProperty('display', '');
  setModelStatus(message);
}

function showModelManual(preferred) {
  const select = qs('ai-config-model-select');
  const input = qs('ai-config-model');
  if (!select || !input) return;
  select.style.display = 'none';
  input.style.display = '';
  input.value = preferred ?? '';
  qs('ai-config-model-manual')?.style.setProperty('display', 'none');
}

function currentModelValue() {
  const select = qs('ai-config-model-select');
  const input = qs('ai-config-model');
  if (select && select.style.display !== 'none' && select.value) return select.value;
  return input?.value.trim() ?? '';
}

function updateModelSuggestions() {
  // Historical IDs shown as suggestions were frequently retired. A successful
  // key-based fetch supplies the actual, account-specific list instead.
  const datalist = qs('ai-config-model-list');
  if (datalist) datalist.replaceChildren();
  const input = qs('ai-config-model');
  if (input) input.placeholder = t('ai.modelIdPlaceholder');
}

/**
 * Fetch models for the current form context:
 *  - editing a saved config without a new key -> stored key (GET /:id/models)
 *  - key typed in the form (saved or not)     -> transient key (models-preview)
 * Silent auto-fetches keep the dropdown fresh; explicit fetches report toasts.
 */
async function fetchModelsForForm({ silent = false, savedConfigId = null } = {}) {
  const providerId = qs('ai-config-provider')?.value;
  const typedKey = qs('ai-config-key')?.value.trim() ?? '';
  const preferred = currentModelValue();
  const generation = ++modelFetchGeneration;
  const configId = typedKey ? null : (savedConfigId ?? editingConfigId);
  // Always use the user's typed or saved key for model discovery.
  if (!configId && typedKey.length < 8) {
    setModelStatus(t('ai.enterKeyFirst'));
    if (!silent) showToast(t('ai.enterKeyFirst'), 'error');
    return;
  }
  setModelStatus(t('ai.modelsLoading'));
  try {
    const res = configId
      ? await apiCall(`/api/v1/ai/providers/${configId}/models`)
      : await apiCall('/api/v1/ai/providers/models-preview', {
          method: 'POST',
          body: JSON.stringify({ provider: providerId, apiKey: typedKey }),
        });
    if (!res.ok) throw new Error(res.data?.message || t('ai.testFailed'));
    if (generation !== modelFetchGeneration) return;
    const models = (res.data.models ?? [])
      .filter((model) => model && typeof model.id === 'string' && model.id.trim())
      .filter((model, i, all) => all.findIndex((item) => item.id === model.id) === i);
    if (!models.length) {
      showModelWaiting(preferred, t('ai.noModelsFound'));
      setModelStatus(t('ai.noModelsFound'), 'error');
      return;
    }
    showModelDropdown(models, preferred);
    const chosenIsListed = !preferred || models.some((m) => m.id === preferred);
    setModelStatus(chosenIsListed
      ? t('ai.modelsLoaded', { count: models.length })
      : `${t('ai.modelsLoaded', { count: models.length })} ${t('ai.savedModelUnavailable')}`,
    chosenIsListed ? 'success' : 'error');
    if (!silent) showToast(t('ai.modelsFetched'), 'success');
  } catch (err) {
    if (generation !== modelFetchGeneration) return;
    showModelWaiting(preferred, t('ai.modelsAutoFailed'));
    setModelStatus(`${t('ai.modelsAutoFailed')} ${err?.message || ''}`, 'error');
    if (!silent) showToast(t('ai.modelsAutoFailed'), 'error');
  }
}

// ---------------------------------------------------------------------------
// Edit / save flows
// ---------------------------------------------------------------------------

function startEdit(config) {
  clearTimeout(modelFetchTimer);
  ++modelFetchGeneration;
  editingConfigId = config.id;
  formDirty = true;
  const form = qs('ai-config-form');
  if (!form) return;
  qs('ai-config-provider').value = config.provider;
  qs('ai-config-provider').disabled = true;
  qs('ai-config-label').value = config.label;
  qs('ai-config-key').value = '';
  qs('ai-config-key').placeholder = t('ai.keyReplaceOptional');
  qs('ai-config-submit').textContent = t('ai.updateConfig');
  qs('ai-config-cancel-edit').style.display = '';
  qs('ai-config-editing-banner')?.style.setProperty('display', 'block');
  // Keep the saved model in a visible dropdown while its catalog loads.
  showModelWaiting(config.modelId, t('ai.modelsLoading'));
  void fetchModelsForForm({ silent: true, savedConfigId: config.id });
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetForm() {
  clearTimeout(modelFetchTimer);
  ++modelFetchGeneration;
  editingConfigId = null;
  formDirty = false;
  const form = qs('ai-config-form');
  if (!form) return;
  qs('ai-config-provider').value = 'openai';
  qs('ai-config-provider').disabled = false;
  qs('ai-config-label').value = '';
  qs('ai-config-key').value = '';
  qs('ai-config-key').placeholder = t('ai.keyPlaceholder');
  qs('ai-config-submit').textContent = t('ai.addConfig');
  qs('ai-config-cancel-edit').style.display = 'none';
  qs('ai-config-editing-banner')?.style.setProperty('display', 'none');
  showModelWaiting();
  updateModelSuggestions();
}

async function submitConfig() {
  const provider = qs('ai-config-provider')?.value;
  const label = qs('ai-config-label')?.value.trim();
  const modelId = currentModelValue();
  const apiKey = qs('ai-config-key')?.value.trim();
  if (!modelId) {
    showToast(t('ai.modelRequired'), 'error');
    return;
  }
  if (!editingConfigId && (!apiKey || apiKey.length < 8)) {
    showToast(t('ai.keyRequired'), 'error');
    return;
  }
  const submitBtn = qs('ai-config-submit');
  if (submitBtn) submitBtn.disabled = true;
  let res;
  let savedConfigId = null;
  let savedProvider = provider;
  if (editingConfigId) {
    const body = { label, modelId };
    if (apiKey) body.apiKey = apiKey;
    res = await apiCall(`/api/v1/ai/providers/${editingConfigId}`, { method: 'PATCH', body: JSON.stringify(body) });
    savedConfigId = editingConfigId;
    savedProvider = qs('ai-config-provider')?.value ?? provider;
  } else {
    res = await apiCall('/api/v1/ai/providers', { method: 'POST', body: JSON.stringify({ provider, label: label || providerLabel(provider), modelId, apiKey }) });
    savedConfigId = res.ok ? res.data.config?.id : null;
  }
  if (submitBtn) submitBtn.disabled = false;
  if (res.ok) {
    // Explicit confirmation toast (user request) + automatic model refresh.
    showToast(editingConfigId ? t('ai.updated') : t('ai.configSaved'), 'success');
    resetForm();
    // Keep the just-saved provider/model visible, and prevent the asynchronous
    // config-list refresh from switching the form back to another default.
    formDirty = true;
    if (savedProvider) qs('ai-config-provider').value = savedProvider;
    showModelWaiting(modelId, t('ai.modelsLoading'));
    updateModelSuggestions();
    void loadConfigs();
    document.dispatchEvent(new CustomEvent('pd:ai-configs-changed'));
    if (savedConfigId) void fetchModelsForForm({ silent: true, savedConfigId });
  } else {
    showToast(res.data?.message || t('ai.errorSave'), 'error');
  }
}

export function initAiSettings() {
  if (initialized) return;
  initialized = true;

  qs('modal-ai-settings-close-btn')?.addEventListener('click', () => closeModal('modal-ai-settings'));
  qs('modal-ai-settings-done-btn')?.addEventListener('click', () => closeModal('modal-ai-settings'));
  qs('ai-config-submit')?.addEventListener('click', (e) => {
    e.preventDefault();
    void submitConfig();
  });
  qs('ai-config-cancel-edit')?.addEventListener('click', () => resetForm());
  qs('ai-config-provider')?.addEventListener('change', () => {
    formDirty = true;
    ++modelFetchGeneration;
    clearTimeout(modelFetchTimer);
    updateModelSuggestions();
    showModelManual('');
    const provider = qs('ai-config-provider').value;
    // A key entered for provider A must NEVER be sent to provider B after
    // changing this selector. User can reenter the proper key, or use that
    // provider's own saved encrypted configuration.
    const keyInput = qs('ai-config-key');
    if (keyInput) keyInput.value = '';
    const matching = savedConfigs.find((c) => c.provider === provider);
    if (matching) void fetchModelsForForm({ silent: true, savedConfigId: matching.id });
    else setModelStatus(t('ai.enterKeyFirst'));
  });
  qs('ai-config-fetch-models')?.addEventListener('click', () => {
    const matching = savedConfigs.find((c) => c.provider === qs('ai-config-provider')?.value);
    void fetchModelsForForm({ silent: false, savedConfigId: matching?.id ?? null });
  });
  qs('ai-config-model-manual')?.addEventListener('click', () => {
    ++modelFetchGeneration;
    formDirty = true;
    showModelManual(currentModelValue());
    setModelStatus(t('ai.modelManualActive'));
  });
  qs('ai-config-model')?.addEventListener('input', () => {
    ++modelFetchGeneration;
    formDirty = true;
  });
  qs('ai-config-label')?.addEventListener('input', () => { formDirty = true; });
  // Auto-fetch: once a plausible key has been typed, load the catalog without
  // requiring the button (debounced; failures silently keep manual entry).
  qs('ai-config-key')?.addEventListener('input', () => {
    formDirty = true;
    ++modelFetchGeneration; // invalidate in-flight responses for an old key
    const key = qs('ai-config-key')?.value.trim() ?? '';
    clearTimeout(modelFetchTimer);
    setModelStatus(key.length >= 8 ? t('ai.modelsWaiting') : t('ai.enterKeyFirst'));
    if (key.length >= 8) {
      modelFetchTimer = setTimeout(() => void fetchModelsForForm({ silent: true }), 900);
    }
  });
  qs('ai-config-key')?.addEventListener('change', () => {
    const key = qs('ai-config-key')?.value.trim() ?? '';
    if (key.length >= 8) {
      clearTimeout(modelFetchTimer);
      void fetchModelsForForm({ silent: true });
    }
  });
  updateModelSuggestions();
  resetForm();

  // External open requests (chat drawer header button).
  document.addEventListener('pd:open-ai-settings', () => openAiSettingsDialog());
}
