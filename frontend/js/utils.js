/**
 * Utility Functions & Shared Helpers
 * Toast notifications, Modal controllers, Theme manager, Audio & Image pickers
 */

import { api } from './api.js';
import { state } from './state.js';
export { escapeHtml } from './markdown.js';

// ==========================================================================
// Toast Notification Center
// ==========================================================================
export function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast-item toast-${type}`;

  const iconSvg = {
    success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
  }[type] || '';

  toast.innerHTML = `
    ${iconSvg}
    <div class="toast-message">${message}</div>
    <button class="toast-close-btn" aria-label="Close notification">&times;</button>
  `;

  const closeBtn = toast.querySelector('.toast-close-btn');
  const dismiss = () => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 200);
  };

  closeBtn?.addEventListener('click', dismiss);
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(dismiss, duration);
  }
}

// ==========================================================================
// Modal Windows Controller
// ==========================================================================
export function openModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.add('active');
}

export function closeModal(modalId) {
  const el = document.getElementById(modalId);
  if (el) el.classList.remove('active');
}

export function showConfirmDialog(title, message, onConfirm) {
  const modal = document.getElementById('modal-confirm');
  const titleEl = document.getElementById('modal-confirm-title');
  const msgEl = document.getElementById('modal-confirm-msg');
  const okBtn = document.getElementById('modal-confirm-ok-btn');
  const cancelBtn = document.getElementById('modal-confirm-cancel-btn');
  const closeBtn = document.getElementById('modal-confirm-close-btn');

  if (!modal) return;
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  const handleConfirm = () => {
    cleanup();
    closeModal('modal-confirm');
    onConfirm();
  };

  const handleCancel = () => {
    cleanup();
    closeModal('modal-confirm');
  };

  const cleanup = () => {
    okBtn?.removeEventListener('click', handleConfirm);
    cancelBtn?.removeEventListener('click', handleCancel);
    closeBtn?.removeEventListener('click', handleCancel);
  };

  okBtn?.addEventListener('click', handleConfirm);
  cancelBtn?.addEventListener('click', handleCancel);
  closeBtn?.addEventListener('click', handleCancel);

  openModal('modal-confirm');
}

// ==========================================================================
// Theme Management (Light / Dark)
// ==========================================================================
export function initTheme() {
  const savedTheme = localStorage.getItem('memo_theme');
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
  applyTheme(initialTheme);
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('memo_theme', theme);
  state.set('theme', theme);

  const sunIcon = document.querySelector('.theme-icon-sun');
  const moonIcon = document.querySelector('.theme-icon-moon');
  const dropdownThemeLabel = document.getElementById('dropdown-theme-label');

  if (theme === 'dark') {
    if (sunIcon) sunIcon.style.display = 'block';
    if (moonIcon) moonIcon.style.display = 'none';
    if (dropdownThemeLabel) dropdownThemeLabel.textContent = 'Light';
  } else {
    if (sunIcon) sunIcon.style.display = 'none';
    if (moonIcon) moonIcon.style.display = 'block';
    if (dropdownThemeLabel) dropdownThemeLabel.textContent = 'Dark';
  }
}

export function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(newTheme);
  showToast(`Switched to ${newTheme === 'dark' ? 'Dark' : 'Light'} theme`, 'info', 2000);
}

// ==========================================================================
// OpenGraph Link Preview Parser
// ==========================================================================
export const keepUrlRegex = /(https?:\/\/[^\s]+)/g;

export async function checkAndAddLinkPreview(text, memoOrDraft, renderFn) {
  if (!text) return;
  const matches = text.match(keepUrlRegex);
  if (!matches || !matches.length) return;
  const url = matches[0];
  const list = memoOrDraft.linkPreviews || [];
  if (list.some((lp) => lp.url === url)) return;

  try {
    const preview = await api.getLinkPreview(url);
    if (preview && preview.url) {
      memoOrDraft.linkPreviews = [...list, preview];
      renderFn();
      if (memoOrDraft.id) {
        await api.updateMemo(memoOrDraft.id, { linkPreviews: memoOrDraft.linkPreviews, version: memoOrDraft.version });
        memoOrDraft.version = (memoOrDraft.version || 1) + 1;
      }
    }
  } catch (err) {
    console.warn('Link preview fetch error:', err);
  }
}

// ==========================================================================
// Image Picker & File Loader
// ==========================================================================
export function triggerImagePicker(onFilesSelected) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.multiple = true;
  input.onchange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0 && typeof onFilesSelected === 'function') {
      onFilesSelected(files);
    }
  };
  input.click();
}

export function extractImageFilesFromEvent(e) {
  const files = [];
  if (e.dataTransfer && e.dataTransfer.files) {
    for (const f of Array.from(e.dataTransfer.files)) {
      if (f.type.startsWith('image/')) files.push(f);
    }
  } else if (e.clipboardData) {
    if (e.clipboardData.files && e.clipboardData.files.length) {
      for (const f of Array.from(e.clipboardData.files)) {
        if (f.type.startsWith('image/')) files.push(f);
      }
    }
    if (files.length === 0 && e.clipboardData.items) {
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
  }
  return files;
}

export function canvasToBlob(canvas, mimeType = 'image/png') {
  return new Promise((resolve, reject) => {
    if (!canvas) return reject(new Error('Canvas element not found'));
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('Canvas export failed'));
      else resolve(blob);
    }, mimeType);
  });
}

// ==========================================================================
// Speech-to-Text Recognition
// ==========================================================================
let speechRecognitionInstance = null;
let isListeningSpeech = false;

export function toggleSpeechRecognition(onTranscript, buttonEl) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('Speech recognition is not supported in this browser.', 'info', 4000);
    return;
  }

  if (isListeningSpeech) {
    try { speechRecognitionInstance?.stop(); } catch {}
    isListeningSpeech = false;
    buttonEl?.classList.remove('active');
    return;
  }

  try {
    speechRecognitionInstance = new SpeechRecognition();
    speechRecognitionInstance.continuous = false;
    speechRecognitionInstance.interimResults = false;
    speechRecognitionInstance.lang = 'en-US';

    speechRecognitionInstance.onstart = () => {
      isListeningSpeech = true;
      buttonEl?.classList.add('active');
      showToast('Listening... Speak now', 'info', 2500);
    };

    speechRecognitionInstance.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      if (transcript) {
        onTranscript(transcript);
        showToast(`Captured: "${transcript}"`, 'success', 2000);
      }
    };

    speechRecognitionInstance.onerror = (err) => {
      console.warn('Speech recognition error:', err);
      isListeningSpeech = false;
      buttonEl?.classList.remove('active');
    };

    speechRecognitionInstance.onend = () => {
      isListeningSpeech = false;
      buttonEl?.classList.remove('active');
    };

    speechRecognitionInstance.start();
  } catch (err) {
    console.error('Speech start error:', err);
    isListeningSpeech = false;
    buttonEl?.classList.remove('active');
  }
}
