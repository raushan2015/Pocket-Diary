/**
 * expo-notifications implementation of ReminderScheduler.
 *
 * - Android 8+ requires a notification channel; we create a dedicated one.
 * - Permissions are requested once, lazily; if the user denies, scheduling
 *   becomes a no-op (never re-prompted on every sync).
 * - `trigger: { type: DATE, date }` — the SDK 53 typed trigger API.
 */
import * as Notifications from 'expo-notifications';
// SDK 58 moved the channel-importance enum into the channel-manager module.
import { AndroidImportance } from 'expo-notifications/build/NotificationChannelManager.types';
import { REMINDER_PREFIX, type ReminderScheduler, type UpcomingReminder } from './notifications';

const CHANNEL_ID = 'pocket-diary-reminders';
let permissionPromise: Promise<boolean> | null = null;

export class ExpoReminderScheduler implements ReminderScheduler {
  async ensurePermission(): Promise<boolean> {
    if (!permissionPromise) {
      permissionPromise = (async () => {
        try {
          const settings = await Notifications.getPermissionsAsync();
          if (settings.granted) return true;
          if (settings.canAskAgain) {
            const requested = await Notifications.requestPermissionsAsync();
            return Boolean(requested.granted);
          }
          return false;
        } catch {
          return false; // headless/unsupported context — best effort only
        }
      })();
    }
    return permissionPromise;
  }

  async syncScheduled(reminders: UpcomingReminder[]): Promise<void> {
    if (!(await this.ensurePermission())) return;

    try {
      // Android channel (idempotent).
      if (Notifications.setNotificationChannelAsync) {
        await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
          name: 'Note reminders',
          importance: AndroidImportance.DEFAULT,
          vibrationPattern: [0, 250, 250, 250],
        });
      }
    } catch {
      // channel setup is best-effort
    }

    const wanted = new Set(reminders.map((r) => r.key));

    // Cancel stale reminders that are no longer upcoming (edited/cleared/deleted).
    try {
      const scheduled = await Notifications.getAllScheduledNotificationsAsync();
      for (const s of scheduled) {
        if (s.identifier.startsWith(REMINDER_PREFIX) && !wanted.has(s.identifier)) {
          await Notifications.cancelScheduledNotificationAsync(s.identifier);
        }
      }
    } catch {
      // best-effort reconciliation
    }

    const existing = new Set(
      (await Notifications.getAllScheduledNotificationsAsync().catch(() => [] as Notifications.NotificationRequest[])).map(
        (s) => s.identifier,
      ),
    );

    for (const r of reminders) {
      if (existing.has(r.key)) continue;
      try {
        await Notifications.scheduleNotificationAsync({
          identifier: r.key,
          content: {
            title: r.title,
            body: r.body,
            sound: true,
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(r.fireAt),
            channelId: CHANNEL_ID,
          },
        });
      } catch {
        // single-schedule failures never break a sync
      }
    }
  }
}
