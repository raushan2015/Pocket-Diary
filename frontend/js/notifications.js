/**
 * Server-side Reminder Notifications UI
 * - Polls /api/v1/notifications for the signed-in user
 * - Renders the bell dropdown with unread badges and mark-read actions
 * - Fires browser Notifications for newly delivered server reminders
 * - Manages Web Push subscription (subscribe / unsubscribe / renewal)
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { openKeepNoteModal } from './keep-modal.js';

let pollTimer = null;
let panelOpen = false;
let lastKnownIds = new Set();
let onOpenMemoCallback = null;

const POLL_INTERVAL_MS = 30_000;

export function setupServerNotifications(callbacks = {}) {
  onOpenMemoCallback = callbacks.onOpenMemo || null;

  const bellBtn = document.getElementById('nav-notifications-btn');
  const panel = document.getElementById('notifications-panel');
  const listEl = document.getElementById('notifications-panel-list');
  const readAllBtn = document.getElementById('notifications-read-all-btn');
  const enablePushBtn = document.getElementById('notifications-enable-push-btn');
  if (!bellBtn || !panel) return;

  // Bell click toggles the dropdown and refreshes it
  bellBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    panelOpen = !panelOpen;
    panel.style.display = panelOpen ? 'block' : 'none';
    bellBtn.setAttribute('aria-expanded', String(panelOpen));
    if (panelOpen) {
      await refreshNotifications();
      updateEnablePushButton();
    }
  });

  document.addEventListener('click', (e) => {
    if (!panelOpen) return;
    if (!panel.contains(e.target) && !bellBtn.contains(e.target)) {
      panelOpen = false;
      panel.style.display = 'none';
      bellBtn.setAttribute('aria-expanded', 'false');
    }
  });

  readAllBtn?.addEventListener('click', async () => {
    try {
      await api.markAllNotificationsRead();
      await refreshNotifications();
      showToast('All notifications marked read', 'success', 1500);
    } catch (err) {
      showToast(err.message || 'Failed to mark notifications read', 'error');
    }
  });

  enablePushBtn?.addEventListener('click', () => enablePushNotifications());

  if (pollTimer) clearInterval(pollTimer);
  const poll = async () => {
    if (state.get('isAuthenticated')) await refreshNotifications();
  };
  pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  void poll();

  // Sign-out clears the badge and any leftover remembered notifications
  state.on('isAuthenticated', (authed) => {
    if (!authed) {
      lastKnownIds = new Set();
      updateBadge(0);
      panelOpen = false;
      if (panel) panel.style.display = 'none';
      const listEl2 = document.getElementById('notifications-panel-list');
      if (listEl2) listEl2.innerHTML = '<div class="notifications-empty">Sign in to see your reminders here.</div>';
    }
  });

  // Renew push subscription when the browser says it changed
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then((reg) => {
      if (!reg.pushManager) return;
      reg.addEventListener('pushsubscriptionchange', () => {
        void syncPushSubscription(reg);
      });
    }).catch(() => {});
  }

  // A push notification was clicked in a closed/hidden window: open the note.
  navigator.serviceWorker?.addEventListener?.('message', (event) => {
    const msg = event.data;
    if (msg?.type === 'open-notification' && msg.memoId) {
      void openNotification({ id: 'sw', memoId: msg.memoId, title: '' });
    }
  });
}

/** Fetch notifications, update the badge/panel, fire browser alerts for new items. */
export async function refreshNotifications() {
  if (!state.get('isAuthenticated')) return;
  try {
    const data = await api.listNotifications({ limit: 25, includeRead: 'true' });
    const notifications = data.notifications || [];
    const unread = data.unread || 0;

    updateBadge(unread);
    renderPanelList(notifications);

    // First poll seeds "known" IDs without alerting (avoid toast storm on load)
    if (lastKnownIds.size === 0 && notifications.length) {
      notifications.forEach((n) => lastKnownIds.add(n.id));
    } else {
      for (const n of notifications) {
        if (!lastKnownIds.has(n.id)) {
          lastKnownIds.add(n.id);
          fireBrowserNotification(n);
        }
      }
    }

    // Keep the known set bounded
    if (lastKnownIds.size > 300) {
      lastKnownIds = new Set(notifications.map((n) => n.id));
    }
  } catch {
    // Offline or signed out — silently skip; badge shows nothing.
  }
}

function updateBadge(unread) {
  const dot = document.getElementById('notification-badge-dot');
  const count = document.getElementById('notification-badge-count');
  if (!dot || !count) return;

  if (unread > 0) {
    dot.style.display = 'none';
    count.style.display = 'inline-flex';
    count.textContent = unread > 99 ? '99+' : String(unread);
  } else {
    dot.style.display = 'none';
    count.style.display = 'none';
  }
}

function timeAgo(ts) {
  const diff = Date.now() - Number(ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(Number(ts)).toLocaleDateString();
}

function renderPanelList(notifications) {
  const listEl = document.getElementById('notifications-panel-list');
  if (!listEl) return;

  if (!notifications.length) {
    listEl.innerHTML = '<div class="notifications-empty">No notifications yet. Reminders you set on notes will appear here.</div>';
    return;
  }

  listEl.innerHTML = notifications.map((n) => `
    <button type="button" class="notification-item ${n.readAt ? 'read' : ''}" data-notification-id="${n.id}" data-memo-id="${n.memoId}">
      <span class="notification-icon">⏰</span>
      <span class="notification-info">
        <span class="notification-title"></span>
        <span class="notification-body"></span>
        <span class="notification-time">${n.reminderTime ? timeAgo(n.reminderTime) : timeAgo(n.createdAt)}</span>
      </span>
      ${n.readAt ? '' : '<span class="notification-unread-dot"></span>'}
    </button>
  `).join('');

  // Fill titles/bodies via textContent to avoid HTML injection
  listEl.querySelectorAll('.notification-item').forEach((item, idx) => {
    const n = notifications[idx];
    item.querySelector('.notification-title').textContent = n.title || 'Reminder';
    item.querySelector('.notification-body').textContent = n.body || '';
    item.addEventListener('click', () => openNotification(n));
  });
}

async function openNotification(n) {
  try {
    await api.markNotificationRead(n.id);
  } catch { /* non-fatal */ }
  panelOpen = false;
  document.getElementById('notifications-panel')?.style.setProperty('display', 'none');
  document.getElementById('nav-notifications-btn')?.setAttribute('aria-expanded', 'false');

  if (state.get('currentView') !== 'dashboard') {
    if (typeof onOpenMemoCallback === 'function') onOpenMemoCallback(n);
    return;
  }

  // Open the note in the Keep in-place modal
  try {
    const res = await api.getMemo(n.memoId);
    if (res?.memo) {
      openKeepNoteModal(res.memo, {
        onChanged: () => { import('./search-filter.js').then(m => m.filterAndRenderMemos()); },
      });
    }
  } catch {
    showToast('This note is no longer available', 'info', 2500);
  }
  void refreshNotifications();
}

function fireBrowserNotification(n) {
  const title = `Reminder: ${n.title}`;
  showToast(`⏰ ${title}`, 'warning', 6000);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notif = new Notification(title, {
        body: n.body || 'Your scheduled note reminder is due now.',
        icon: '/icons/icon.svg',
        tag: `note-reminder-${n.id}`,
      });
      notif.onclick = () => {
        window.focus();
        openNotification(n);
      };
    } catch (err) {
      console.warn('Browser notification error:', err);
    }
  }
}

// ==========================================================================
// Web Push subscription management
// ==========================================================================

async function getVapidConfig() {
  try {
    const res = await api.getPushPublicKey();
    return res;
  } catch {
    return { enabled: false, publicKey: null };
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function syncPushSubscription(registration) {
  const { enabled, publicKey } = await getVapidConfig();
  if (!enabled || !publicKey || !registration?.pushManager) return false;

  try {
    let subscription = await registration.pushManager.getSubscription();
    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    if (subscription) {
      // Ensure it belongs to the currently configured VAPID key
      try {
        const currentKey = btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey)));
        const wantedKey = btoa(String.fromCharCode(...applicationServerKey));
        if (currentKey !== wantedKey) {
          await subscription.unsubscribe().catch(() => {});
          subscription = null;
        }
      } catch { /* keep existing */ }
    }

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    const json = subscription.toJSON();
    await api.pushSubscribe({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    });
    return true;
  } catch (err) {
    console.warn('Push subscription failed:', err);
    return false;
  }
}

/** Ask permission and subscribe this browser for push notifications. */
export async function enablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    showToast('Push notifications are not supported by this browser. In-app notifications still work.', 'info', 4000);
    return;
  }

  const { enabled } = await getVapidConfig();
  if (!enabled) {
    showToast('Push is not configured on this server (VAPID keys missing). In-app notifications still work.', 'info', 4500);
    updateEnablePushButton();
    return;
  }

  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    showToast('Notification permission was not granted.', 'info', 3000);
    updateEnablePushButton();
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const ok = await syncPushSubscription(reg);
    showToast(ok ? 'Push notifications enabled for this browser 🔔' : 'Could not enable push. Try again later.', ok ? 'success' : 'error');
    updateEnablePushButton();
  } catch {
    showToast('Could not enable push notifications.', 'error');
  }
}

function updateEnablePushButton() {
  const btn = document.getElementById('notifications-enable-push-btn');
  if (!btn) return;
  void (async () => {
    const { enabled } = await getVapidConfig();
    const supported = 'serviceWorker' in navigator && 'PushManager' in window;
    if (!enabled || !supported) {
      btn.style.display = enabled ? 'none' : 'none';
      return;
    }
    if (Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      const sub = reg ? await reg.pushManager.getSubscription().catch(() => null) : null;
      if (sub) {
        btn.style.display = 'none';
        return;
      }
    }
    btn.style.display = 'inline-flex';
  })();
}
