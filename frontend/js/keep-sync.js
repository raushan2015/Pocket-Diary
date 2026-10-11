/**
 * Google Keep Multi-Tab Live Synchronization Controller
 * Uses BroadcastChannel (with localStorage event fallback) to keep multiple open browser tabs in instant sync
 */

const CHANNEL_NAME = 'notes_multitab_sync';
let channel = null;

if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch (err) {
    console.warn('BroadcastChannel initialization failed, falling back to storage events:', err);
  }
}

let syncCallbacks = {};

export function setupMultiTabSync(callbacks = {}) {
  syncCallbacks = callbacks;

  if (channel) {
    channel.onmessage = (event) => {
      handleSyncMessage(event.data);
    };
  } else if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key === CHANNEL_NAME && event.newValue) {
        try {
          const data = JSON.parse(event.newValue);
          handleSyncMessage(data);
        } catch {}
      }
    });
  }
}

function handleSyncMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'memos_changed':
      if (typeof syncCallbacks.onMemosChanged === 'function') {
        syncCallbacks.onMemosChanged(msg.data);
      }
      break;
    case 'labels_changed':
      if (typeof syncCallbacks.onLabelsChanged === 'function') {
        syncCallbacks.onLabelsChanged(msg.data);
      }
      break;
    case 'workspace_changed':
      if (typeof syncCallbacks.onWorkspaceChanged === 'function') {
        syncCallbacks.onWorkspaceChanged(msg.data);
      }
      break;
    default:
      if (typeof syncCallbacks.onSync === 'function') {
        syncCallbacks.onSync(msg);
      }
  }
}

export function broadcastSync(type, data = {}) {
  const message = { type, timestamp: Date.now(), data };

  if (channel) {
    try {
      channel.postMessage(message);
    } catch (err) {
      console.warn('Failed to post BroadcastChannel message:', err);
    }
  } else if (typeof window !== 'undefined' && window.localStorage) {
    try {
      localStorage.setItem(CHANNEL_NAME, JSON.stringify(message));
    } catch {}
  }
}
