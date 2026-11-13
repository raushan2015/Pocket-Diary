/**
 * Pocket Diary AI — persistent chat drawer (singleton).
 *
 * Lifecycle rules (handoff §2.1):
 *  - Closing the drawer HIDES it; it never deletes the conversation nor
 *    aborts server-side generation. Reopening shows the same messages,
 *    draft, provider and scroll position.
 *  - Conversations/messages live on the SERVER per (user, workspace), so a
 *    page refresh or second device restores them after sign-in.
 *  - SSE subscription is decoupled from job creation: the drawer subscribes
 *    by request id and reconnects (Last-Event-ID); the backend keeps
 *    generating while the drawer is hidden.
 *  - All note access requires explicit grants; the scope indicator always
 *    tells the user exactly what is shared ("General chat — no notes shared",
 *    "Current note: …", "AI Search").
 *
 * Security notes:
 *  - AI output is rendered with the app's existing XSS-safe markdown
 *    renderer; user messages are rendered as plain text (textContent).
 *  - No secrets, provider keys or note-derived data are stored in
 *    localStorage. Only the draft text and selected ids live in
 *    sessionStorage, and the draft is the user's own typing.
 */
import { state } from './state.js';
import { api } from './api.js';
import { t, tEsc } from './i18n.js';
import { showToast, openModal, closeModal, showConfirmDialog } from './utils.js';
import { renderMarkdown } from './markdown.js';
import { initAiSettings, openAiSettingsDialog } from './ai-settings.js';

const DRAFT_KEY = 'pd_ai_draft';
const CONV_KEY = 'pd_ai_conversation';
const THINKING_KEY = 'pd_ai_thinking_effort';
const FULL_CONTROL_KEY = 'pd_ai_full_control';

function isFullControlEnabled() {
  try {
    return localStorage.getItem(FULL_CONTROL_KEY) !== 'false';
  } catch {
    return true;
  }
}

function syncFullControlButton() {
  const btn = qs('ai-full-control-toggle');
  if (!btn) return;
  const active = isFullControlEnabled();
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  const label = btn.querySelector('span');
  if (label) label.textContent = t(active ? 'ai.fullControlOn' : 'ai.fullControlOff');
}

let initialized = false;
let drawerOpen = false;
const EXPAND_KEY = 'pd_ai_expanded';
let currentConversationId = null;
let conversationLoadVersion = 0;
let ensureConversationPromise = null;
let activeRequestId = null; // request currently being streamed (if any)
let eventSourceAbort = null; // AbortController for the SSE fetch
let lastEventId = -1;
let providerConfigs = [];
let selectedProviderConfigId = null;
let generating = false;
let sendingInProgress = false;
let historyOpen = false;
let searchMode = false; // "Find a note / AI Search" explicit mode
let lastSearchQuery = '';
let noteGrant = null; // { grantId, memoId, version, expiresAt } for the currently authorized note task
let noteGrantMemoId = null;

function qs(id) {
  return document.getElementById(id);
}

/** api.request throws on non-2xx; normalize to {ok, data, status}. */
async function apiCall(endpoint, options = {}) {
  try {
    const data = await api.request(endpoint, options);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, data: err?.data ?? { message: err?.message }, status: err?.status ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// Scope computation (what the UI claims is shared)
// ---------------------------------------------------------------------------

function currentActiveMemo() {
  // The editor's activeMemo cache can outlive its view. An old note is NOT
  // open when the user returns to the dashboard or general chat.
  if (state.get('currentView') !== 'editor') return null;
  return state.get('activeMemo') || null;
}

/** An explicit request about the currently open note authorizes only that
 * note for this task. Ordinary chat while the editor is open remains private. */
function requestsOpenNoteTask(message) {
  const memo = currentActiveMemo();
  if (!memo?.id || typeof message !== 'string') return false;
  return /\b(?:this|the|current|open|opened|existing)\s+(?:note|memo|diary entry)\b/i.test(message)
    && /\b(?:summari[sz]e|update|edit|rewrite|improve|review|analy[sz]e|explain|read|correct|fix|expand|revise|translate|modify)\b/i.test(message);
}

function scopeInfo() {
  const memo = currentActiveMemo();
  if (searchMode) {
    return { kind: 'search', label: t('ai.scopeSearch') };
  }
  if (memo && memo.id && noteGrantMemoId === memo.id && noteGrant) {
    return { kind: 'note', label: `${t('ai.scopeNote')}: ${memo.title || t('ai.untitled')}` };
  }
  if (memo && memo.aiAccess === 'blocked') {
    return { kind: 'note-blocked', label: t('ai.scopeNoteBlocked') };
  }
  return { kind: 'general', label: t('ai.scopeGeneral') };
}

function updateScopeIndicator() {
  const el = qs('ai-scope-indicator');
  if (!el) return;
  const scope = scopeInfo();
  el.textContent = scope.label;
  el.classList.toggle('ai-scope-note', scope.kind === 'note');
  el.classList.toggle('ai-scope-blocked', scope.kind === 'note-blocked');
}

// ---------------------------------------------------------------------------
// Draft + selection persistence (sessionStorage only)
// ---------------------------------------------------------------------------

function saveDraft() {
  const input = qs('ai-composer-input');
  if (!input) return;
  try { sessionStorage.setItem(DRAFT_KEY, input.value); } catch { /* private mode */ }
}

function restoreDraft() {
  const input = qs('ai-composer-input');
  if (!input) return;
  try { input.value = sessionStorage.getItem(DRAFT_KEY) ?? ''; } catch { /* ignore */ }
  maybeShowSecretWarning();
  // Keep a restored long draft fully visible instead of clipped.
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

async function loadProviderConfigs() {
  const res = await apiCall('/api/v1/ai/providers');
  if (res.ok) {
    providerConfigs = res.data.configs ?? [];
    if (!selectedProviderConfigId || !providerConfigs.some((c) => c.id === selectedProviderConfigId)) {
      const def = providerConfigs.find((c) => c.isDefault) ?? providerConfigs[0];
      selectedProviderConfigId = def ? def.id : null;
    }
  } else {
    providerConfigs = [];
  }
  renderProviderSelector();
}

function updateThinkingHint() {
  const hint = qs('ai-thinking-hint');
  if (!hint) return;
  const selection = qs('ai-thinking-select')?.value ?? 'auto';
  const config = providerConfigs.find((item) => item.id === selectedProviderConfigId);
  // NVIDIA GLM-5.3 has a built-in reasoning model and distinct native
  // low/high/max effort controls (Medium maps to high, High maps to max).
  if (config?.provider === 'nvidia_nim' &&
      /^(?:z-ai|zai-org)\/glm-5\.3(?:-flash)?$/i.test(config.modelId)) {
    const key = selection === 'auto' ? 'thinkingGlmAuto'
      : selection === 'low' ? 'thinkingGlmLow'
      : selection === 'medium' ? 'thinkingGlmMedium' : 'thinkingGlmHigh';
    hint.textContent = t('ai.' + key);
    return;
  }
  hint.textContent = t('ai.thinkingHint');
}

const PROVIDER_SHORT_LABELS = {
  antigravity_cli: 'Google Plan',
  openai: 'OpenAI',
  gemini: 'Gemini',
  anthropic: 'Claude',
  deepseek: 'DeepSeek',
  nvidia_nim: 'NVIDIA',
  mistral: 'Mistral',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

function renderProviderSelector() {
  const select = qs('ai-provider-select');
  if (!select) return;
  select.innerHTML = '';
  if (providerConfigs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = t('ai.noProvider');
    select.appendChild(opt);
    select.disabled = true;
    updateThinkingHint();
    renderEmptyStateIfNeeded();
    return;
  }
  select.disabled = false;
  for (const config of providerConfigs) {
    const opt = document.createElement('option');
    opt.value = config.id;
    const shortName = PROVIDER_SHORT_LABELS[config.provider] || config.provider;
    opt.textContent = `${shortName} · ${config.modelId}`;
    if (config.id === selectedProviderConfigId) opt.selected = true;
    select.appendChild(opt);
  }
  updateThinkingHint();
  renderEmptyStateIfNeeded();
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

async function ensureConversation({ forceNew = false } = {}) {
  // Drawer opening and Send can happen together. Serialize recovery so they
  // never create two chats or erase the active one in a response race.
  if (ensureConversationPromise) {
    await ensureConversationPromise;
    if (!forceNew && currentConversationId) {
      const res = await apiCall(`/api/v1/ai/conversations/${currentConversationId}?messageLimit=1`);
      if (res.ok) return res.data.conversation;
    }
  }
  const operation = (async () => {
    const workspace = state.get('activeWorkspace');
    if (!workspace) return null;
    if (!forceNew && currentConversationId) {
      const res = await apiCall(`/api/v1/ai/conversations/${currentConversationId}?messageLimit=1`);
      if (res.ok && res.data.conversation.workspaceId === workspace.id) return res.data.conversation;
      // Temporary server/network failures must not silently clear a chat.
      if (!res.ok && res.status !== 404 && res.status !== 403) {
        showToast(res.data?.message || t('ai.errorLoadHistory'), 'error');
        return null;
      }
      currentConversationId = null;
      persistConversationId();
    }
    if (!forceNew) {
      // Recover recent chat even when iPad/Safari lost sessionStorage, or the
      // user opens a new tab/device. The server remains the source of truth.
      const latest = await apiCall(`/api/v1/ai/conversations?workspaceId=${encodeURIComponent(workspace.id)}&limit=1`);
      if (!latest.ok) {
        showToast(latest.data?.message || t('ai.errorLoadHistory'), 'error');
        return null;
      }
      const recent = latest.data.conversations?.[0];
      if (recent?.id) {
        currentConversationId = recent.id;
        persistConversationId();
        return recent;
      }
    }
    const res = await apiCall('/api/v1/ai/conversations', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id }),
    });
    if (res.ok) {
      currentConversationId = res.data.conversation.id;
      persistConversationId();
      return res.data.conversation;
    }
    showToast(res.data?.message || t('ai.errorCreateConversation'), 'error');
    return null;
  })();
  ensureConversationPromise = operation;
  try { return await operation; }
  finally { if (ensureConversationPromise === operation) ensureConversationPromise = null; }
}

function persistConversationId() {
  try {
    if (currentConversationId) sessionStorage.setItem(CONV_KEY, currentConversationId);
    else sessionStorage.removeItem(CONV_KEY);
  } catch { /* ignore */ }
}

function restoreConversationId() {
  try { currentConversationId = sessionStorage.getItem(CONV_KEY) || null; } catch { currentConversationId = null; }
}

async function loadHistory() {
  const workspace = state.get('activeWorkspace');
  const panel = qs('ai-history-panel');
  if (!panel || !workspace) return;
  panel.innerHTML = '';
  const res = await apiCall(`/api/v1/ai/conversations?workspaceId=${encodeURIComponent(workspace.id)}&limit=20`);
  if (!res.ok) {
    panel.innerHTML = `<div class="ai-history-empty">${tEsc('ai.errorLoadHistory')}</div>`;
    return;
  }
  const conversations = res.data.conversations ?? [];
  if (conversations.length === 0) {
    panel.innerHTML = `<div class="ai-history-empty">${tEsc('ai.historyEmpty')}</div>`;
    return;
  }
  for (const conversation of conversations) {
    const item = document.createElement('div');
    item.className = 'ai-history-item' + (conversation.id === currentConversationId ? ' active' : '');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'ai-history-open';
    openBtn.textContent = conversation.title || t('ai.newChat');
    openBtn.title = openBtn.textContent;
    openBtn.setAttribute('role', 'menuitem');
    openBtn.addEventListener('click', () => {
      void switchConversation(conversation.id);
      toggleHistory(false);
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ai-history-delete';
    deleteBtn.title = t('ai.deleteChat');
    deleteBtn.setAttribute('aria-label', `${t('ai.deleteChat')}: ${conversation.title || t('ai.newChat')}`);
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      showConfirmDialog(t('ai.deleteChatConfirmTitle'), t('ai.deleteChatConfirmBody'), async () => {
        deleteBtn.disabled = true;
        const res = await apiCall(`/api/v1/ai/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
        if (!res.ok) {
          deleteBtn.disabled = false;
          showToast(res.data?.message || t('ai.errorDeleteChat'), 'error');
          return;
        }
        if (conversation.id === currentConversationId) {
          stopEventStream();
          activeRequestId = null;
          setGenerating(false);
          currentConversationId = null;
          persistConversationId();
          clearMessages();
          discardCurrentNoteGrant();
          toggleSearchMode(false);
          // New messages start in a fresh conversation; deleting chat history
          // never deletes any Pocket Diary notes that were created from it.
        }
        showToast(t('ai.chatDeleted'), 'success');
        void loadHistory();
      });
      // Confirm dialogs use the generic modal stack (below the AI drawer);
      // raise only this confirmation above the chat, without changing other
      // dialogs or letting it appear hidden behind the drawer.
      qs('modal-confirm')?.style.setProperty('z-index', '1100');
    });
    item.append(openBtn, deleteBtn);
    panel.appendChild(item);
  }
}

function toggleHistory(open) {
  historyOpen = open ?? !historyOpen;
  const panel = qs('ai-history-panel');
  if (panel) panel.classList.toggle('open', historyOpen);
  if (historyOpen) void loadHistory();
}

async function switchConversation(conversationId) {
  // Switching is explicit. The previous job continues on the server.
  ++conversationLoadVersion;
  stopEventStream();
  activeRequestId = null;
  setGenerating(false);
  currentConversationId = conversationId;
  persistConversationId();
  clearMessages();
  await loadConversation({ force: true });
}

async function loadConversation({ force = false, reconnect = true } = {}) {
  const id = currentConversationId;
  if (!id) return;
  const version = ++conversationLoadVersion;
  const res = await apiCall(`/api/v1/ai/conversations/${id}?messageLimit=200`);
  // Never clear chat when a stale, out-of-order request returns.
  if (id !== currentConversationId || version !== conversationLoadVersion) return;
  if (!res.ok) {
    // Transient network/provider errors are NOT conversation deletion.
    if (res.status === 404) {
      currentConversationId = null;
      persistConversationId();
    } else {
      showToast(res.data?.message || t('ai.errorLoadHistory'), 'error');
    }
    return;
  }
  // A live stream owns the message area. Re-rendering from a partial server
  // snapshot mid-stream used to erase user bubbles and streamed text.
  if (((generating && activeRequestId) || sendingInProgress) && !force) return;
  const container = messagesContainer();
  const hadMessages = Boolean(container?.children.length);
  const previousScroll = container ? container.scrollTop : 0;
  const wasNearBottom = !container || container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  // Local search results are intentionally NEVER stored in chat messages
  // because their titles/snippets are private. Preserve the live DOM nodes
  // (including checkbox listeners) when refreshing durable chat history.
  const localSearchPanels = container ? Array.from(container.querySelectorAll('.ai-search-results')) : [];
  clearMessages();
  for (const message of res.data.messages ?? []) appendMessage(message);
  for (const message of res.data.messages ?? []) {
    if (message.role === 'assistant' && message.meta?.proposalIds) {
      await attachProposals(message);
      if (id !== currentConversationId || version !== conversationLoadVersion) return;
    }
  }
  if (id === currentConversationId && version === conversationLoadVersion && container) {
    for (const panel of localSearchPanels) container.appendChild(panel);
  }
  if (hadMessages && !wasNearBottom && container) container.scrollTop = previousScroll;
  else scrollToBottom();
  renderEmptyStateIfNeeded();
  if (reconnect) await reconnectIfGenerating(res.data.activeRequestId ?? null);
}

async function reconnectIfGenerating(serverActiveRequestId = null) {
  if (!activeRequestId && serverActiveRequestId) activeRequestId = serverActiveRequestId;
  // If the drawer hid while generating in THIS tab, activeRequestId is set.
  if (activeRequestId) {
    const res = await apiCall(`/api/v1/ai/requests/${activeRequestId}`);
    if (res.ok && ['queued', 'running'].includes(res.data.request.status)) {
      setGenerating(true);
      void subscribeToEvents(activeRequestId);
      showTyping();
      return;
    }
    activeRequestId = null;
  }
  setGenerating(false);
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function messagesContainer() {
  return qs('ai-drawer-messages');
}

function removeEmptyState() {
  document.getElementById('ai-empty-state')?.remove();
}

function renderEmptyStateIfNeeded() {
  const container = messagesContainer();
  if (!container) return;
  const hasRealContent = Array.from(container.children).some((el) => el.id !== 'ai-empty-state');
  if (hasRealContent) {
    removeEmptyState();
    return;
  }
  removeEmptyState();
  const empty = document.createElement('div');
  empty.className = 'ai-empty-state';
  empty.id = 'ai-empty-state';

  const icon = document.createElement('div');
  icon.className = 'ai-empty-icon';
  icon.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"></path></svg>';
  empty.appendChild(icon);

  const title = document.createElement('div');
  title.className = 'ai-empty-title';
  title.textContent = t('ai.emptyTitle');
  empty.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'ai-empty-subtitle';
  sub.textContent = providerConfigs.length === 0 ? t('ai.emptySubtitleNoProvider') : t('ai.emptySubtitleReady');
  empty.appendChild(sub);

  if (providerConfigs.length === 0) {
    const setupBtn = document.createElement('button');
    setupBtn.type = 'button';
    setupBtn.className = 'btn btn-primary btn-sm';
    setupBtn.textContent = t('ai.emptyConnectBtn');
    setupBtn.addEventListener('click', () => openAiSettingsDialog());
    empty.appendChild(setupBtn);
  } else {
    const chips = document.createElement('div');
    chips.className = 'ai-starter-prompts';
    const starters = [
      { label: t('ai.starterGoalsLabel'), prompt: t('ai.starterGoalsPrompt') },
      { label: t('ai.starterOutlineLabel'), prompt: t('ai.starterOutlinePrompt') },
      { label: t('ai.starterBrainstormLabel'), prompt: t('ai.starterBrainstormPrompt') },
    ];
    for (const item of starters) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-starter-chip';
      btn.textContent = item.label;
      btn.addEventListener('click', () => {
        const input = qs('ai-composer-input');
        if (input) {
          input.value = item.prompt;
          void sendMessage();
        }
      });
      chips.appendChild(btn);
    }
    empty.appendChild(chips);
  }

  container.appendChild(empty);
}

function clearMessages() {
  const container = messagesContainer();
  if (container) container.innerHTML = '';
  renderEmptyStateIfNeeded();
}

function scrollToBottom() {
  const container = messagesContainer();
  if (container) container.scrollTop = container.scrollHeight;
}

function savedNoteButton(note, parent) {
  if (!note?.id || !parent) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ai-saved-note-link';
  button.textContent = `${t('ai.noteAutoSaved')} · ${note.title || t('ai.untitled')} · ${t('ai.openNote')}`;
  button.addEventListener('click', () => void openNoteFromAssistant(note.id, false));
  parent.appendChild(button);
}

function appendMessage(message) {
  const container = messagesContainer();
  if (!container) return null;
  removeEmptyState();
  // Idempotent: SSE delivery and a concurrent conversation reload can both
  // carry the same message — render it exactly once.
  if (message.id && container.querySelector(`[data-message-id="${CSS.escape(String(message.id))}"]`)) {
    return container.querySelector(`[data-message-id="${CSS.escape(String(message.id))}"]`);
  }
  const wrap = document.createElement('div');
  wrap.className = `ai-msg ${message.role}`;
  wrap.dataset.messageId = message.id ?? '';
  if (message.role === 'assistant') {
    wrap.innerHTML = renderMarkdown(message.content || '');
    if (message.status === 'failed') {
      wrap.classList.add('ai-msg-failed');
      const status = document.createElement('span');
      status.className = 'ai-msg-status';
      status.textContent = `${message.errorCode || 'error'} — ${t('ai.tryAgain')}`;
      wrap.appendChild(status);
    } else if (message.status === 'interrupted') {
      wrap.classList.add('ai-msg-interrupted');
      const status = document.createElement('span');
      status.className = 'ai-msg-status';
      status.textContent = t('ai.interruptedNotice');
      wrap.appendChild(status);
    }
    for (const note of (Array.isArray(message.meta?.autoSavedNotes) ? message.meta.autoSavedNotes : [])) {
      savedNoteButton(note, wrap);
    }
    if ((message.content || '').trim() && message.status !== 'failed') {
      const actions = document.createElement('div');
      actions.className = 'ai-msg-actions';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'ai-msg-copy-btn';
      copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
      const copyLabel = document.createElement('span');
      copyLabel.textContent = t('ai.copyReply');
      copyBtn.appendChild(copyLabel);
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(message.content || '');
          copyBtn.classList.add('copied');
          copyLabel.textContent = t('ai.copied');
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyLabel.textContent = t('ai.copyReply');
          }, 1400);
        } catch {
          showToast(t('ai.copyFailed'), 'error');
        }
      });
      actions.appendChild(copyBtn);
      const usage = message.meta?.usage;
      if (usage && (typeof usage.inputTokens === 'number' || typeof usage.outputTokens === 'number')) {
        const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        const inTok = Number(usage.inputTokens ?? 0);
        const outTok = Number(usage.outputTokens ?? 0);
        const cachedTok = Number(usage.cacheReadTokens ?? 0);
        const usageEl = document.createElement('span');
        usageEl.className = 'ai-msg-usage';
        usageEl.textContent = `${fmt(inTok)} ${t('ai.tokensIn')} · ${fmt(outTok)} ${t('ai.tokensOut')}`;
        usageEl.title = `${inTok.toLocaleString()} ${t('ai.tokensIn')} / ${outTok.toLocaleString()} ${t('ai.tokensOut')}${cachedTok ? ` / ${cachedTok.toLocaleString()} ${t('ai.tokensCached')}` : ''}`;
        actions.appendChild(usageEl);
      }
      wrap.appendChild(actions);
    }
  } else {
    wrap.textContent = message.content; // user messages: plain text, no markdown
  }
  container.appendChild(wrap);
  return wrap;
}

function appendTyping() {
  const container = messagesContainer();
  if (!container) return;
  removeEmptyState();
  removeTyping();
  const el = document.createElement('div');
  el.className = 'ai-typing';
  el.id = 'ai-typing-indicator';
  el.innerHTML = '<span></span><span></span><span></span>';
  container.appendChild(el);
  scrollToBottom();
}

function removeTyping() {
  document.getElementById('ai-typing-indicator')?.remove();
}

function showTyping() { appendTyping(); }

// Streaming assistant bubble
let streamingBubble = null;
let streamingText = '';

function startStreamingBubble() {
  const container = messagesContainer();
  if (!container) return;
  streamingBubble = document.createElement('div');
  streamingBubble.className = 'ai-msg assistant';
  streamingBubble.id = 'ai-streaming-bubble';
  streamingText = '';
  container.appendChild(streamingBubble);
}

function appendStreamDelta(delta) {
  if (!streamingBubble) startStreamingBubble();
  streamingText += delta;
  if (streamingBubble) {
    streamingBubble.innerHTML = renderMarkdown(streamingText);
    scrollToBottom();
  }
}

function finishStreamingBubble() {
  document.getElementById('ai-streaming-bubble')?.remove();
  streamingBubble = null;
  streamingText = '';
}

// Proposals
async function attachProposals(assistantMessage) {
  const ids = assistantMessage.meta?.proposalIds ?? [];
  for (const proposalId of ids) {
    try {
      const res = await apiCall(`/api/v1/ai/proposals/${proposalId}`);
      if (!res.ok) continue;
      const proposal = res.data.proposal;
      if (proposal.status === 'pending' && !document.querySelector(`[data-proposal-id="${proposalId}"]`)) {
        renderProposalCard(proposal);
      } else if (proposal.status === 'executed' && proposal.resultMemoId) {
        renderProposalDone(proposalId, proposal.resultMemoId, proposal.payload?.title);
      }
    } catch { /* non-fatal */ }
  }
}

async function broadcastMemosChanged() {
  try {
    const mod = await import('./keep-sync.js');
    if (mod.broadcastSync) mod.broadcastSync('memos_changed');
  } catch { /* optional */ }
  await refreshWorkspaceMemosSafe();
}

async function refreshWorkspaceMemosSafe() {
  try {
    const mod = await import('./workspace-data.js');
    if (mod.refreshWorkspaceMemos) await mod.refreshWorkspaceMemos();
  } catch { /* non-fatal */ }
}

function renderProposalCard(proposal) {
  const container = messagesContainer();
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'ai-proposal-card';
  card.dataset.proposalId = proposal.id;
  const title = proposal.payload?.title || t('ai.untitled');
  const isUpdate = proposal.action === 'update';
  const heading = document.createElement('h5');
  heading.textContent = isUpdate ? t('ai.proposalUpdateTitle') : t('ai.proposalCreateTitle');
  card.appendChild(heading);
  const titleLine = document.createElement('div');
  titleLine.style.fontWeight = '600';
  titleLine.style.marginBottom = '0.35rem';
  titleLine.textContent = proposal.payload?.title || t('ai.untitled');
  card.appendChild(titleLine);

  if (isUpdate && proposal.targetNoteId) {
    const info = document.createElement('div');
    info.className = 'ai-proposal-status';
    info.textContent = `${t('ai.proposalTarget')} v${proposal.expectedNoteVersion ?? '?'}`;
    card.appendChild(info);
  }
  const body = document.createElement('div');
  body.className = 'ai-proposal-body';
  body.textContent = proposal.payload?.content ?? '';
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'ai-proposal-actions';
  const approveBtn = document.createElement('button');
  approveBtn.type = 'button';
  approveBtn.className = 'btn btn-primary btn-sm';
  approveBtn.textContent = isUpdate ? t('ai.proposalApply') : t('ai.proposalCreate');
  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    const res = await apiCall(`/api/v1/ai/proposals/${proposal.id}/approve`, { method: 'POST' });
    if (res.ok) {
      const memoId = res.data.memo?.id;
      if (memoId) {
        renderProposalDone(proposal.id, memoId, title);
        showToast(t('ai.noteSaved'), 'success');
        await broadcastMemosChanged();
      } else {
        showToast(t('ai.proposalConflict'), 'error');
        actions.remove();
        const status = document.createElement('div');
        status.className = 'ai-proposal-status';
        status.textContent = res.data.conflict ? `${t('ai.proposalConflict')} (v${res.data.conflict.currentVersion})` : t('ai.proposalConflict');
        card.appendChild(status);
      }
    } else {
      approveBtn.disabled = false;
      showToast(res.data?.message || t('ai.proposalFailed'), 'error');
    }
  });
  const rejectBtn = document.createElement('button');
  rejectBtn.type = 'button';
  rejectBtn.className = 'btn btn-secondary btn-sm';
  rejectBtn.textContent = t('ai.proposalCancel');
  rejectBtn.addEventListener('click', async () => {
    rejectBtn.disabled = true;
    await apiCall(`/api/v1/ai/proposals/${proposal.id}/reject`, { method: 'POST' });
    actions.remove();
    body.remove();
    const status = document.createElement('div');
    status.className = 'ai-proposal-status';
    status.textContent = t('ai.proposalRejected');
    card.appendChild(status);
  });
  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  card.appendChild(actions);
  container.appendChild(card);
  scrollToBottom();
}

/** Load the full authorized note before navigating. navigateTo(editor) expects
 * params.memo, not params.memoId; an ID alone displayed an empty editor and
 * left activeMemo unset, breaking the first AI summarize action. */
async function openNoteFromAssistant(memoId, closeDrawer) {
  try {
    const result = await api.getMemo(memoId);
    if (!result?.memo) throw new Error('Note not found');
    const { navigateTo } = await import('./navigation.js');
    await navigateTo('editor', { memo: result.memo });
    // The chat is a docked panel on desktop: navigating keeps it open so the
    // conversation continues. Only the mobile sheet auto-closes.
    if (closeDrawer && window.matchMedia('(max-width: 720px)').matches) setDrawerOpen(false);
  } catch (error) {
    showToast(error?.message || t('ai.errorLoad'), 'error');
  }
}

function renderProposalDone(proposalId, memoId, title) {
  document.querySelector(`[data-proposal-id="${proposalId}"]`)?.remove();
  const container = messagesContainer();
  if (!container) return;
  const card = document.createElement('div');
  card.className = 'ai-proposal-card';
  card.dataset.proposalDone = memoId;
  const status = document.createElement('div');
  status.className = 'ai-proposal-status';
  status.textContent = `✓ ${t('ai.noteSavedAs')}: ${title || ''}`;
  card.appendChild(status);
  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn-outline btn-sm';
  openBtn.textContent = t('ai.openNote');
  openBtn.addEventListener('click', async () => {
    await openNoteFromAssistant(memoId, true);
  });
  card.appendChild(openBtn);
  container.appendChild(card);
  scrollToBottom();
}

// Search results stay local in the browser. Only the user's explicit Stage B
// selection and redacted preview can authorize sending excerpts to an LLM.
function renderSearchResults(data) {
  const container = messagesContainer();
  const workspace = state.get('activeWorkspace');
  if (!container || !workspace) return;
  removeEmptyState();
  const panel = document.createElement('div');
  panel.className = 'ai-search-results';
  const heading = document.createElement('h5');
  heading.textContent = t('ai.searchResultsLocal');
  panel.appendChild(heading);
  const results = document.createElement('div');
  panel.appendChild(results);
  const selected = new Set();
  let page = Number(data.page) || 1;
  const limit = Number(data.limit) || 25;
  const query = data.query || lastSearchQuery;
  const seen = new Set();

  const reviewBtn = document.createElement('button');
  reviewBtn.type = 'button';
  reviewBtn.className = 'btn btn-primary btn-sm';
  reviewBtn.textContent = t('ai.reviewSelected');
  reviewBtn.disabled = true;
  reviewBtn.style.marginTop = '0.55rem';
  const reviewCount = () => {
    reviewBtn.disabled = selected.size === 0 || selected.size > 10;
    reviewBtn.textContent = `${t('ai.reviewSelected')} (${selected.size}/10)`;
  };

  function addHits(hits) {
    for (const hit of hits ?? []) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      const row = document.createElement('div');
      row.className = 'ai-search-hit';
      const main = document.createElement('div');
      main.className = 'ai-search-hit-main';
      const titleEl = document.createElement('div');
      titleEl.className = 'ai-search-hit-title';
      titleEl.textContent = hit.title || t('ai.untitled');
      titleEl.addEventListener('click', async () => {
        await openNoteFromAssistant(hit.id, false);
      });
      const snippet = document.createElement('div');
      snippet.className = 'ai-search-hit-snippet';
      snippet.textContent = hit.snippet || '';
      main.appendChild(titleEl);
      main.appendChild(snippet);
      if (hit.llmEligible) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('aria-label', `${t('ai.selectForAnalysis')}: ${hit.title}`);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            if (selected.size >= 10) {
              checkbox.checked = false;
              showToast(t('ai.selectMaxTen'), 'error');
            } else selected.add(hit.id);
          } else selected.delete(hit.id);
          reviewCount();
        });
        row.appendChild(checkbox);
      }
      const badge = document.createElement('span');
      badge.className = `badge-ai-state ${hit.eligibility}`;
      badge.textContent = hit.llmEligible ? t('ai.eligibleShort') : hit.eligibility === 'blocked' ? t('ai.blockedShort') : t('ai.currentOnlyShort');
      row.appendChild(main);
      row.appendChild(badge);
      results.appendChild(row);
    }
  }
  addHits(data.hits);
  if (!seen.size) {
    const empty = document.createElement('p');
    empty.textContent = t('ai.searchNoResults');
    results.appendChild(empty);
  }
  const pagingBtn = document.createElement('button');
  pagingBtn.className = 'btn btn-outline btn-sm';
  pagingBtn.type = 'button';
  pagingBtn.textContent = t('ai.loadMoreSearch');
  pagingBtn.style.marginTop = '0.55rem';
  pagingBtn.hidden = !query || seen.size >= Number(data.total);
  pagingBtn.addEventListener('click', async () => {
    pagingBtn.disabled = true;
    const next = await apiCall('/api/v1/ai/search', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, query, phrases: data.queries ?? [], page: page + 1, limit }),
    });
    pagingBtn.disabled = false;
    if (!next.ok) { showToast(next.data?.message || t('ai.errorLoad'), 'error'); return; }
    page = next.data.page;
    addHits(next.data.hits);
    pagingBtn.hidden = !next.data.hits.length || seen.size >= next.data.total;
  });
  panel.appendChild(pagingBtn);

  reviewBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    reviewBtn.disabled = true;
    const preview = await apiCall('/api/v1/ai/search/preview', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: workspace.id, memoIds: [...selected] }),
    });
    reviewBtn.disabled = false;
    if (!preview.ok) {
      showToast(preview.data?.message || t('ai.errorLoad'), 'error');
      return;
    }
    showSearchPrivacyPreview(preview.data, workspace.id);
  });
  reviewCount();
  panel.appendChild(reviewBtn);
  const note = document.createElement('p');
  note.className = 'ai-privacy-note';
  note.textContent = t('ai.searchPrivacyNote');
  panel.appendChild(note);
  container.appendChild(panel);
  scrollToBottom();
}

function showSearchPrivacyPreview(data, workspaceId) {
  const container = messagesContainer();
  if (!container) return;
  removeEmptyState();
  const panel = document.createElement('div');
  panel.className = 'ai-search-results';
  const heading = document.createElement('h5');
  heading.textContent = t('ai.previewBeforeSharing');
  panel.appendChild(heading);
  const previews = data.previews ?? [];
  for (const preview of previews) {
    const title = document.createElement('strong');
    title.textContent = preview.title || t('ai.untitled');
    panel.appendChild(title);
    const text = document.createElement('pre');
    text.className = 'ai-search-preview-text';
    text.textContent = preview.excerpt;
    panel.appendChild(text);
  }
  if (data.rejected?.length) {
    const info = document.createElement('p');
    info.className = 'ai-privacy-note';
    info.textContent = t('ai.someNotesExcluded');
    panel.appendChild(info);
  }
  if (previews.length && data.previewToken) {
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'btn btn-primary btn-sm';
    approve.textContent = t('ai.approveAiReading');
    approve.addEventListener('click', async () => {
      const conversation = await ensureConversation();
      if (!conversation) return;
      approve.disabled = true;
      const approval = await apiCall('/api/v1/ai/search/approve', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId, conversationId: conversation.id,
          previewToken: data.previewToken, memoIds: previews.map((p) => p.memoId),
        }),
      });
      if (!approval.ok) {
        approve.disabled = false;
        showToast(approval.data?.message || t('ai.errorSave'), 'error');
        return;
      }
      approve.remove();
      toggleSearchMode(false);
      await sendMessage({
        mode: 'search_read',
        content: t('ai.searchReadPrompt'),
        searchGrantIds: approval.data.grants.map((g) => g.grantId),
      });
    });
    panel.appendChild(approve);
  }
  container.appendChild(panel);
  scrollToBottom();
}

// ---------------------------------------------------------------------------
// Sending messages + SSE
// ---------------------------------------------------------------------------

function maybeShowSecretWarning() {
  const input = qs('ai-composer-input');
  const warning = qs('ai-privacy-warning');
  if (!input || !warning) return;
  const looksSecret = /(sk-[A-Za-z0-9_-]{12,}|nvapi-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|token|passwd|password|pwd)\s*[:=]\s*['"]?[^\s'"]{8,})/i.test(input.value);
  warning.classList.toggle('visible', looksSecret);
}

function discardCurrentNoteGrant() {
  const former = noteGrant;
  noteGrant = null;
  noteGrantMemoId = null;
  // Revocation is server-enforced. Do not send note text or keys in this call.
  if (former?.grantId) {
    void apiCall('/api/v1/ai/current-note/revoke', {
      method: 'POST', body: JSON.stringify({ grantId: former.grantId }),
    });
  }
  updateScopeIndicator();
}

async function grantCurrentNote(conversationId) {
  const memo = currentActiveMemo();
  const workspace = state.get('activeWorkspace');
  if (!memo || !memo.id || !workspace) return null;
  if (memo.aiAccess === 'blocked') {
    showToast(t('ai.noteBlockedToast'), 'error');
    return null;
  }
  // Reuse a still-live grant for this exact note.
  if (noteGrant && noteGrantMemoId === memo.id && noteGrant.expiresAt > Date.now() + 30_000) {
    return noteGrant;
  }
  const res = await apiCall('/api/v1/ai/current-note/grant', {
    method: 'POST',
    body: JSON.stringify({ workspaceId: workspace.id, memoId: memo.id, conversationId, purpose: 'note_task' }),
  });
  if (res.ok) {
    noteGrant = res.data.grant;
    noteGrantMemoId = memo.id;
    updateScopeIndicator();
    return noteGrant;
  }
  showToast(res.data?.message || t('ai.noteAccessDenied'), 'error');
  return null;
}

async function sendMessage(options = {}) {
  const input = qs('ai-composer-input');
  if (!input || generating || sendingInProgress) return;
  const content = typeof options.content === 'string' ? options.content.trim() : input.value.trim();
  if (!content) return;
  // Capture selections synchronously before ANY awaits, so a rapid change
  // from High to Auto (or changing chat/provider) cannot alter a queued send.
  const requestedThinking = qs('ai-thinking-select')?.value || 'auto';
  const requestedProvider = selectedProviderConfigId;
  const requestedMode = options.mode || (searchMode ? 'search' : (scopeInfo().kind === 'note' || requestsOpenNoteTask(content)) ? 'note_task' : 'general');
  sendingInProgress = true;
  const sendButton = qs('ai-send-btn');
  if (sendButton) sendButton.disabled = true;
  try {
  if (providerConfigs.length === 0) {
    // The user may have just added the first key in settings — re-check once
    // before sending them to onboarding.
    await loadProviderConfigs();
    if (providerConfigs.length === 0) {
      showToast(t('ai.noProviderToast'), 'error');
      openAiSettingsDialog();
      return;
    }
  }
  const conversation = await ensureConversation();
  if (!conversation) return;

  const mode = requestedMode;
  if (mode === 'search') lastSearchQuery = content;
  const body = {
    content,
    clientMessageId: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mode,
    providerConfigId: requestedProvider,
    thinking: requestedThinking,
    fullControl: isFullControlEnabled(),
  };
  if (mode === 'note_task') {
    const grant = await grantCurrentNote(conversation.id);
    if (!grant) return; // blocked/refused — do not send
    body.currentNoteGrantId = grant.grantId;
  }
  if (mode === 'search_read') {
    body.searchGrantIds = options.searchGrantIds ?? [];
    if (!body.searchGrantIds.length) return;
  }

  if (options.content === undefined) {
    input.value = '';
    saveDraft();
    maybeShowSecretWarning();
  }

  const pendingBubble = appendMessage({ id: `local-${Date.now()}`, role: 'user', content, status: 'complete' });
  scrollToBottom();

  const res = await apiCall(`/api/v1/ai/conversations/${conversation.id}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    pendingBubble?.remove();
    // A rejected request must not silently destroy the user's typed draft.
    if (options.content === undefined) {
      input.value = content;
      saveDraft();
    }
    showToast(res.data?.message || t('ai.errorSend'), 'error');
    return;
  }
  if (pendingBubble && res.data.userMessage?.id) pendingBubble.dataset.messageId = res.data.userMessage.id;
  activeRequestId = res.data.request.id;
  lastEventId = -1;
  setGenerating(true);
  startStreamingBubble();
  void subscribeToEvents(activeRequestId);
  } finally {
    sendingInProgress = false;
    if (!generating && sendButton) sendButton.disabled = false;
  }
}

function setGenerating(value) {
  generating = value;
  const sendBtn = qs('ai-send-btn');
  const cancelBtn = qs('ai-cancel-btn');
  if (sendBtn) sendBtn.disabled = value;
  const thinkingSelect = qs('ai-thinking-select');
  if (thinkingSelect) thinkingSelect.disabled = value;
  if (cancelBtn) cancelBtn.style.display = value ? '' : 'none';
}

async function cancelGeneration() {
  if (!activeRequestId) return;
  await apiCall(`/api/v1/ai/requests/${activeRequestId}/cancel`, { method: 'POST' });
}

function stopEventStream() {
  if (eventSourceAbort) {
    eventSourceAbort.abort();
    eventSourceAbort = null;
  }
}

async function subscribeToEvents(requestId) {
  stopEventStream();
  eventSourceAbort = new AbortController();
  const controller = eventSourceAbort;
  let buffer = '';
  try {
    const response = await fetch(`/api/v1/ai/requests/${requestId}/events`, {
      method: 'GET',
      credentials: 'include',
      headers: lastEventId >= 0 ? { 'Last-Event-ID': String(lastEventId) } : {},
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) {
      await pollToCompletion(requestId);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        handleSseEvent(rawEvent);
      }
    }
  } catch (err) {
    if (controller.signal.aborted) return; // user closed/switched — server continues
    await pollToCompletion(requestId);
    return;
  }
  // Stream ended without an explicit done (server restart?): reconcile.
  await pollToCompletion(requestId);
}

function handleSseEvent(rawEvent) {
  let eventId = -1;
  let eventName = 'message';
  const dataLines = [];
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('id:')) eventId = parseInt(line.slice(3).trim(), 10);
    else if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (eventId >= 0) lastEventId = Math.max(lastEventId, eventId);
  let data = {};
  try { data = JSON.parse(dataLines.join('\n')); } catch { data = {}; }

  switch (eventName) {
    case 'delta':
      appendStreamDelta(data.text ?? '');
      break;
    case 'search_results':
      finishStreamingBubble();
      renderSearchResults(data);
      break;
    case 'note_saved':
      showToast(t('ai.noteAutoSaved'), 'success');
      if (data.memoId) {
        const container = messagesContainer();
        const wrapper = document.createElement('div');
        wrapper.className = 'ai-saved-note-confirmation';
        savedNoteButton({ id: data.memoId, title: data.title }, wrapper);
        container?.appendChild(wrapper);
        scrollToBottom();
      }
      void broadcastMemosChanged();
      break;
    case 'workspace_changed':
      void broadcastMemosChanged();
      break;
    case 'notifications_changed':
      void import('./notifications.js').then((m) => m.loadNotifications?.()).catch(() => {});
      break;
    case 'message':
      finishStreamingBubble();
      removeTyping();
      if (data.id) appendMessage(data);
      if (data.meta?.proposalIds) void attachProposals(data);
      break;
    case 'error':
      removeTyping();
      showToast(data.message || t('ai.errorSend'), 'error');
      break;
    case 'done':
      finishStreamingBubble();
      removeTyping();
      setGenerating(false);
      stopEventStream();
      // The complete authoritative message (including saved-note links and
      // failure notices) must replace the temporary streaming bubble.
      activeRequestId = null;
      void loadConversation({ force: true, reconnect: false });
      break;
    default:
      break;
  }
}

async function pollToCompletion(requestId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (eventSourceAbort?.signal.aborted) return;
    const res = await apiCall(`/api/v1/ai/requests/${requestId}`);
    if (!res.ok) return;
    const status = res.data.request.status;
    if (['complete', 'failed', 'interrupted', 'canceled'].includes(status)) {
      finishStreamingBubble();
      removeTyping();
      setGenerating(false);
      activeRequestId = null;
      await loadConversation({ force: true, reconnect: false });
      if (['failed', 'interrupted'].includes(status)) {
        showToast(res.data.request.errorMessage || t('ai.errorSend'), 'error');
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

// ---------------------------------------------------------------------------
// Drawer open/close (hide ≠ delete; generation continues server-side)
// ---------------------------------------------------------------------------

function applyExpandedPreference() {
  let expanded = false;
  try { expanded = localStorage.getItem(EXPAND_KEY) === '1'; } catch { expanded = false; }
  const drawer = qs('ai-chat-drawer');
  const btn = qs('ai-expand-btn');
  if (drawer) drawer.classList.toggle('expanded', expanded);
  if (btn) btn.setAttribute('aria-pressed', String(expanded));
}

function toggleExpanded() {
  let expanded = false;
  try { expanded = localStorage.getItem(EXPAND_KEY) === '1'; } catch { expanded = false; }
  expanded = !expanded;
  try { localStorage.setItem(EXPAND_KEY, expanded ? '1' : '0'); } catch { /* private mode */ }
  applyExpandedPreference();
}

function setDrawerOpen(open) {
  drawerOpen = open;
  const drawer = qs('ai-chat-drawer');
  const backdrop = qs('ai-drawer-backdrop');
  const btn = qs('nav-ai-btn');
  if (!drawer) return;
  applyExpandedPreference();
  drawer.classList.toggle('open', open);
  backdrop?.classList.toggle('visible', open);
  if (btn) btn.setAttribute('aria-expanded', String(open));
  if (open) {
    restoreDraft();
    updateScopeIndicator();
    void (async () => {
      await loadProviderConfigs();
      await ensureConversation();
      await loadConversation();
      updateScopeIndicator();
      qs('ai-composer-input')?.focus();
    })();
    document.addEventListener('keydown', onDrawerKeydown);
  } else {
    document.removeEventListener('keydown', onDrawerKeydown);
    toggleHistory(false);
  }
}

function onDrawerKeydown(e) {
  if (e.key === 'Escape' && drawerOpen) {
    // Escape never throws away work: while the composer holds a draft, the
    // first Escape only blurs it; a second Escape (empty composer) closes.
    const composer = qs('ai-composer-input');
    if (e.target === composer && composer.value.trim()) {
      composer.blur();
      e.preventDefault();
      return;
    }
    e.preventDefault();
    setDrawerOpen(false);
  }
}

// ---------------------------------------------------------------------------
// "Find a note / AI Search" explicit mode + current note actions
// ---------------------------------------------------------------------------

function toggleSearchMode(enabled) {
  searchMode = enabled;
  const btn = qs('ai-search-mode-btn');
  if (btn) btn.classList.toggle('active', enabled);
  updateScopeIndicator();
}

async function startNoteTask(promptText) {
  const memo = currentActiveMemo();
  if (!memo || !memo.id) return;
  if (memo.aiAccess === 'blocked') {
    showToast(t('ai.noteBlockedToast'), 'error');
    return;
  }
  // The first click must issue a grant BEFORE sendMessage chooses its mode.
  // Otherwise scopeInfo() reports General Chat and the note is never read.
  const conversation = await ensureConversation();
  if (!conversation || !await grantCurrentNote(conversation.id)) return;
  const input = qs('ai-composer-input');
  if (input) input.value = promptText;
  await sendMessage();
}

// ---------------------------------------------------------------------------
// Init (singleton)
// ---------------------------------------------------------------------------

export function initAiChat() {
  if (initialized) return;
  initialized = true;
  restoreConversationId();
  const thinkingSelect = qs('ai-thinking-select');
  if (thinkingSelect) {
    try {
      const old = sessionStorage.getItem(THINKING_KEY);
      if (['auto', 'low', 'medium', 'high'].includes(old)) thinkingSelect.value = old;
    } catch { /* private browser mode */ }
    thinkingSelect.addEventListener('change', () => {
      try { sessionStorage.setItem(THINKING_KEY, thinkingSelect.value); } catch { /* ignore */ }
      updateThinkingHint();
    });
  }

  syncFullControlButton();
  qs('ai-full-control-toggle')?.addEventListener('click', () => {
    const next = !isFullControlEnabled();
    try { localStorage.setItem(FULL_CONTROL_KEY, next ? 'true' : 'false'); } catch { /* ignore */ }
    syncFullControlButton();
  });

  qs('nav-ai-btn')?.addEventListener('click', () => setDrawerOpen(!drawerOpen));
  qs('ai-drawer-backdrop')?.addEventListener('click', () => setDrawerOpen(false));
  qs('ai-drawer-close-btn')?.addEventListener('click', () => setDrawerOpen(false));
  qs('ai-expand-btn')?.addEventListener('click', () => toggleExpanded());
  qs('ai-new-chat-btn')?.addEventListener('click', async () => {
    stopEventStream();
    activeRequestId = null;
    setGenerating(false);
    currentConversationId = null;
    persistConversationId();
    noteGrant = null;
    noteGrantMemoId = null;
    toggleSearchMode(false);
    ++conversationLoadVersion;
    clearMessages();
    await ensureConversation({ forceNew: true });
    updateScopeIndicator();
  });
  qs('ai-history-btn')?.addEventListener('click', () => toggleHistory());
  qs('ai-provider-select')?.addEventListener('change', (e) => {
    selectedProviderConfigId = e.target.value || null;
    updateThinkingHint();
  });
  qs('ai-send-btn')?.addEventListener('click', () => void sendMessage());
  qs('ai-cancel-btn')?.addEventListener('click', () => void cancelGeneration());
  qs('ai-settings-btn')?.addEventListener('click', () => openAiSettingsDialog());
  // Settings changes (add/delete) refresh the drawer's selector live.
  document.addEventListener('pd:ai-configs-changed', () => {
    void loadProviderConfigs();
  });
  qs('ai-search-mode-btn')?.addEventListener('click', () => toggleSearchMode(!searchMode));
  qs('ai-save-transcript-btn')?.addEventListener('click', async () => {
    if (!currentConversationId) return;
    const res = await apiCall(`/api/v1/ai/conversations/${currentConversationId}/save-as-note`, { method: 'POST' });
    if (res.ok) {
      showToast(t('ai.noteSaved'), 'success');
      await broadcastMemosChanged();
    } else {
      showToast(res.data?.message || t('ai.errorSave'), 'error');
    }
  });
  qs('ai-summarize-note-btn')?.addEventListener('click', () => void startNoteTask(t('ai.summarizePrompt')));
  qs('ai-improve-note-btn')?.addEventListener('click', () => void startNoteTask(t('ai.improvePrompt')));

  const composerInput = qs('ai-composer-input');
  const autosizeComposer = () => {
    if (!composerInput) return;
    composerInput.style.height = 'auto';
    composerInput.style.height = `${Math.min(composerInput.scrollHeight, 220)}px`;
  };
  if (composerInput) {
    composerInput.addEventListener('input', () => { saveDraft(); maybeShowSecretWarning(); autosizeComposer(); });
    composerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    });
  }

  // A grant is scoped to one physically open note, not a stale activeMemo
  // retained by the editor state after navigating to a different view.
  state.on('activeMemo', () => {
    const memo = currentActiveMemo();
    if (noteGrant && (!memo || memo.id !== noteGrantMemoId)) {
      discardCurrentNoteGrant();
    }
    updateScopeIndicator();
  });
  state.on('currentView', (view) => {
    if (view !== 'editor' && noteGrant) discardCurrentNoteGrant();
    updateScopeIndicator();
  });

  // Clear transient client state on sign-out.
  state.on('isAuthenticated', (value) => {
    if (!value) {
      stopEventStream();
      drawerOpen = false;
      setDrawerOpen(false);
      currentConversationId = null;
      activeRequestId = null;
      providerConfigs = [];
      noteGrant = null;
      noteGrantMemoId = null;
      try { sessionStorage.removeItem(DRAFT_KEY); sessionStorage.removeItem(CONV_KEY); } catch { /* ignore */ }
    }
  });

  initAiSettings();
}

export function isAiDrawerOpen() {
  return drawerOpen;
}
