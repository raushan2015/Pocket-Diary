/**
 * Voice Typing Engine — speech-to-text note input with English & Japanese support.
 *
 * Upgrades the previous one-shot Web Speech wrapper with:
 *  - Language selection (English / 日本語), persisted per browser.
 *  - Continuous dictation: the engine auto-restarts across pauses, and every
 *    finalized phrase is appended to the target note as it is spoken.
 *  - Actionable diagnostics: explains WHY the microphone is unavailable
 *    (insecure origin, unsupported browser, denied permission, no device,
 *    offline service) instead of failing silently.
 *  - A 2-minute session cap and a restart budget so it can never run away.
 */

import { showToast } from './utils.js';
import { positionPopover, closeKeepPopovers } from './keep-popovers.js';

export const VOICE_LANG_STORAGE_KEY = 'memo_voice_lang';

export const VOICE_LANGUAGES = [
  { code: 'en-US', short: 'EN', label: 'English', nativeLabel: 'English', flag: '🇺🇸' },
  { code: 'ja-JP', short: '日', label: 'Japanese', nativeLabel: '日本語', flag: '🇯🇵' },
];

const DEFAULT_LANGUAGE = 'en-US';
const MAX_SESSION_MS = 2 * 60 * 1000; // hard stop after two minutes of listening
const MAX_RESTARTS = 40;              // budget for engine restarts across pauses

let recognitionInstance = null;
let listening = false;
let manuallyStopped = false;
let restartCount = 0;
let segmentCount = 0;
let sessionDeadlineTimer = null;
let activeButtonEl = null;
let transcriptCallback = null;

function getSpeechApi() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// ==========================================================================
// Language selection
// ==========================================================================

export function getVoiceLanguage() {
  try {
    const stored = localStorage.getItem(VOICE_LANG_STORAGE_KEY);
    if (stored && VOICE_LANGUAGES.some((l) => l.code === stored)) return stored;
  } catch { /* storage unavailable */ }
  return DEFAULT_LANGUAGE;
}

export function getVoiceLanguageInfo(code = getVoiceLanguage()) {
  return VOICE_LANGUAGES.find((l) => l.code === code) || VOICE_LANGUAGES[0];
}

export function setVoiceLanguage(code) {
  const lang = VOICE_LANGUAGES.find((l) => l.code === code);
  if (!lang) return false;
  try { localStorage.setItem(VOICE_LANG_STORAGE_KEY, code); } catch { /* ignore */ }
  updateVoiceLangBadges();
  if (listening) {
    // Recreate the engine so the new language applies mid-session.
    try { recognitionInstance?.stop(); } catch { /* not running */ }
    recognitionInstance = createRecognitionEngine();
    restartCount = 0;
    startRecognitionEngine();
    showToast(`Voice typing switched to ${lang.nativeLabel} (${lang.label})`, 'info', 2200);
  } else {
    showToast(`Voice typing language: ${lang.nativeLabel} (${lang.label})`, 'info', 1800);
  }
  return true;
}

// ==========================================================================
// Availability diagnostics
// ==========================================================================

export function getVoiceSupport() {
  const hasApi = !!getSpeechApi();
  const isSecureContext = window.isSecureContext === true
    || ['localhost', '127.0.0.1', '[::1]'].includes(window.location?.hostname || '');
  return { hasApi, isSecureContext, canListen: hasApi && isSecureContext };
}

// ==========================================================================
// Dictation engine
// ==========================================================================

function createRecognitionEngine() {
  const SpeechApi = getSpeechApi();
  if (!SpeechApi) return null;

  const rec = new SpeechApi();
  rec.lang = getVoiceLanguage();
  rec.continuous = true;
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    // A single event can carry several finalized phrases — deliver them all.
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result?.isFinal) continue;
      const text = String(result[0]?.transcript || '').trim();
      if (text) {
        segmentCount++;
        transcriptCallback?.(text);
      }
    }
  };

  rec.onerror = (event) => {
    const code = event?.error;
    if (code === 'no-speech' || code === 'aborted') {
      // Silence or an abort: the engine restarts via onend — no user noise needed.
      return;
    }
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      manuallyStopped = true;
      stopListening(false);
      showToast('Microphone access was blocked. Allow the microphone for this site in your browser site settings and try again.', 'error', 6500);
      return;
    }
    if (code === 'audio-capture') {
      manuallyStopped = true;
      stopListening(false);
      showToast('No microphone was found on this device.', 'error', 5000);
      return;
    }
    if (code === 'network') {
      manuallyStopped = true;
      stopListening(false);
      showToast('The speech service could not be reached — voice typing needs an internet connection.', 'error', 5000);
      return;
    }
    console.warn('Speech recognition error:', code);
  };

  rec.onend = () => {
    if (manuallyStopped || !listening) return;
    // Chrome ends a session after a pause; restart while the user is still dictating.
    if (restartCount >= MAX_RESTARTS) {
      stopListening(true);
      return;
    }
    restartCount++;
    startRecognitionEngine();
  };

  return rec;
}

function startRecognitionEngine() {
  try { recognitionInstance?.start(); } catch { /* already started */ }
}

function stopListening(notify = true) {
  listening = false;
  manuallyStopped = true;
  clearTimeout(sessionDeadlineTimer);
  try { recognitionInstance?.stop(); } catch { /* not running */ }
  activeButtonEl?.classList.remove('active', 'voice-listening');
  if (notify) {
    showToast(segmentCount > 0
      ? `Voice typing stopped — ${segmentCount} segment${segmentCount === 1 ? '' : 's'} added`
      : 'Voice typing stopped', 'info', 2200);
  }
  activeButtonEl = null;
  transcriptCallback = null;
}

/**
 * Start/stop voice dictation for the button that invoked it.
 * Signature-compatible with the previous implementation so existing call
 * sites (quick capture, keep modal) keep working unchanged.
 */
export function toggleSpeechRecognition(onTranscript, buttonEl) {
  if (listening) {
    stopListening(true);
    return;
  }
  startListening(onTranscript, buttonEl);
}

async function startListening(onTranscript, buttonEl) {
  const support = getVoiceSupport();

  // Browsers refuse microphone APIs on insecure origins. The most common
  // real-world cause of "the mic button doesn't work": opening the app from a
  // LAN IP over plain http:// (e.g. http://192.168.1.10:8080) from a phone.
  if (!support.isSecureContext) {
    showToast('Voice typing needs a secure connection. Open Notes over HTTPS, or from localhost — browsers block the microphone on plain http:// addresses.', 'error', 7000);
    return;
  }
  if (!support.hasApi) {
    showToast('Voice typing is not available in this browser. Chrome and Edge support speech-to-text — you can keep typing normally.', 'error', 5500);
    return;
  }

  // Permission preflight with a clear denial path (SpeechRecognition itself
  // only surfaces a bare not-allowed error).
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      showToast('Microphone access was blocked. Allow the microphone for this site in your browser settings and try again.', 'error', 6500);
    } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      showToast('No microphone was found on this device.', 'error', 5000);
    } else {
      showToast(`Microphone could not be started: ${err?.message || 'unknown error'}`, 'error', 5000);
    }
    return;
  }

  transcriptCallback = typeof onTranscript === 'function' ? onTranscript : null;
  activeButtonEl = buttonEl || null;
  recognitionInstance = createRecognitionEngine();
  if (!recognitionInstance) {
    showToast('Voice typing is not available in this browser.', 'error', 4000);
    return;
  }

  manuallyStopped = false;
  listening = true;
  restartCount = 0;
  segmentCount = 0;
  const lang = getVoiceLanguageInfo();
  activeButtonEl?.classList.add('active', 'voice-listening');
  showToast(`${lang.flag} Listening in ${lang.nativeLabel}… speak now — tap the mic again to stop`, 'info', 3500);
  sessionDeadlineTimer = setTimeout(() => stopListening(true), MAX_SESSION_MS);
  startRecognitionEngine();
}

// ==========================================================================
// Language picker UI
// ==========================================================================

function updateVoiceLangBadges() {
  const lang = getVoiceLanguageInfo();
  ['qc-voice-lang-badge', 'keep-modal-voice-lang-badge'].forEach((id) => {
    const badge = document.getElementById(id);
    if (badge) badge.textContent = lang.short;
  });
}

function renderVoiceLangOptions() {
  const listEl = document.getElementById('voice-lang-list');
  if (!listEl) return;
  const current = getVoiceLanguage();
  listEl.innerHTML = VOICE_LANGUAGES.map((l) => `
    <button type="button" class="voice-lang-option ${l.code === current ? 'selected' : ''}" data-voice-lang="${l.code}" role="menuitemradio" aria-checked="${l.code === current}">
      <span class="voice-lang-flag">${l.flag}</span>
      <span class="voice-lang-name">${l.nativeLabel}</span>
      <span class="voice-lang-alt">${l.label === l.nativeLabel ? '' : l.label}</span>
      <span class="voice-lang-check" aria-hidden="true">✓</span>
    </button>
  `).join('');

  listEl.querySelectorAll('[data-voice-lang]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const changed = setVoiceLanguage(btn.dataset.voiceLang);
      closeKeepPopovers();
      if (!changed) showToast('That language is not available.', 'error');
    });
  });
}

/**
 * Wire the voice language picker (globe buttons in the quick capture bar and
 * the Keep modal) and the shared language popover. Call once at startup.
 */
export function setupVoiceNotes() {
  updateVoiceLangBadges();
  const popover = document.getElementById('keep-popover-voice-language');
  if (!popover) return;

  const openLangPopover = (anchor) => {
    renderVoiceLangOptions();
    positionPopover(popover, anchor);
  };

  document.getElementById('qc-voice-lang-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openLangPopover(e.currentTarget);
  });

  document.getElementById('keep-modal-voice-lang-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openLangPopover(e.currentTarget);
  });
}
