/**
 * Local reminder notifications — BEST EFFORT, BY DESIGN.
 *
 * The backend's reminder push is Web-Push (VAPID, browser-only). For the
 * mobile app the only honest option is scheduling OS *local* notifications
 * while the app is open: after each sync we reconcile the next upcoming note
 * reminders into the OS scheduler. Neither iOS nor Android guarantees
 * background delivery; the OS may delay or coalesce notifications, and this
 * is explicitly NOT a "background sync" guarantee.
 *
 * The interface keeps the domain testable: React Native uses
 * expo-notifications; tests inject a spy.
 */

export interface UpcomingReminder {
  /** Stable scheduling id (per note + reminder time). */
  key: string;
  noteId: string;
  title: string;
  body: string;
  fireAt: number;
}

export interface ReminderScheduler {
  /** True when the OS allows scheduling notifications. Safe to call often. */
  ensurePermission(): Promise<boolean>;
  /** Reconciles scheduled notifications to exactly the given upcoming set. */
  syncScheduled(reminders: UpcomingReminder[]): Promise<void>;
}

export const REMINDER_PREFIX = 'pd-reminder:';

/** Builds the reminder list to schedule: next `days` days, capped at `max`. */
export function collectUpcomingReminders(
  notes: { id: string; title: string; content: string; reminderTime: number | null; deletedAt?: number | null; isArchived?: boolean }[],
  now = Date.now(),
  days = 7,
  max = 25,
): UpcomingReminder[] {
  const horizon = now + days * 24 * 60 * 60 * 1000;
  return notes
    .filter((n) => n.reminderTime != null && !n.deletedAt && !n.isArchived)
    .filter((n) => (n.reminderTime as number) > now && (n.reminderTime as number) <= horizon)
    .sort((a, b) => (a.reminderTime as number) - (b.reminderTime as number))
    .slice(0, max)
    .map((n) => ({
      key: `${REMINDER_PREFIX}${n.id}:${n.reminderTime}`,
      noteId: n.id,
      title: n.title || 'Pocket Diary reminder',
      body: (n.content || '').slice(0, 120) || 'A note is due.',
      fireAt: n.reminderTime as number,
    }));
}
