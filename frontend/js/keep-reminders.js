/**
 * Google Keep Live Reminders & Web Notification Watcher
 * Periodically checks for due note reminders and triggers system / toast alerts
 */

import { state } from './state.js';
import { showToast } from './utils.js';

let reminderCheckInterval = null;
const notifiedMemoIds = new Set();

export function setupKeepReminders(onOpenMemo = null) {
  // Request notification permission if available
  if ('Notification' in window && Notification.permission === 'default') {
    // Only request on user interaction
    const requestOnce = () => {
      Notification.requestPermission();
      window.removeEventListener('click', requestOnce);
    };
    window.addEventListener('click', requestOnce);
  }

  // Clear existing interval
  if (reminderCheckInterval) clearInterval(reminderCheckInterval);

  // Check every 25 seconds
  reminderCheckInterval = setInterval(() => {
    checkDueReminders(onOpenMemo);
  }, 25000);

  // Initial check after 3 seconds
  setTimeout(() => checkDueReminders(onOpenMemo), 3000);
}

function checkDueReminders(onOpenMemo) {
  const allMemos = state.get('allWorkspaceMemos') || [];
  const now = Date.now();

  for (const memo of allMemos) {
    if (memo.deletedAt || memo.isArchived) continue;
    const remTime = memo.reminderTime || memo.dueDate;
    if (!remTime) continue;

    const timeNum = Number(remTime);
    // Trigger if due within the last 2 hours and not yet notified
    if (timeNum <= now && now - timeNum <= 2 * 3600000) {
      if (!notifiedMemoIds.has(memo.id)) {
        notifiedMemoIds.add(memo.id);
        fireReminderNotification(memo, onOpenMemo);
      }
    }
  }
}

function fireReminderNotification(memo, onOpenMemo) {
  const title = memo.title ? `Reminder: ${memo.title}` : 'Note Reminder';
  const body = memo.content ? memo.content.slice(0, 120) : 'Your scheduled note reminder is due now.';

  showToast(`⏰ ${title}`, 'warning', 6000);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const notif = new Notification(title, {
        body,
        icon: '/favicon.ico',
        tag: `memo-reminder-${memo.id}`,
      });
      notif.onclick = () => {
        window.focus();
        if (typeof onOpenMemo === 'function') onOpenMemo(memo);
      };
    } catch (err) {
      console.warn('Browser notification error:', err);
    }
  }
}
