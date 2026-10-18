/**
 * Notification service: persisted reminder notifications per user
 * and the server-side reminder scheduler that creates them.
 */
import crypto from 'node:crypto';
import { and, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { memos, notifications, users, workspaceMembers } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';
import { config } from '../config.js';
import { pruneExpiredAuthArtifacts } from './auth.service.js';
import { sendEmail, renderReminderEmail, isEmailEnabled } from './mailer.service.js';
import { sendPushToUser, isPushEnabled } from './push.service.js';

export interface UserNotification {
  id: string;
  workspaceId: string;
  memoId: string;
  type: string;
  title: string;
  body: string | null;
  reminderTime: number | null;
  readAt: number | null;
  createdAt: number;
}

export function listNotifications(
  dbCtx: DatabaseContext,
  userId: string,
  options: { limit?: number; includeRead?: boolean } = {},
): { notifications: UserNotification[]; unread: number } {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 25)), 100);
  const includeRead = options.includeRead !== false;

  const unreadRow = dbCtx.sqlite
    .prepare('SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .get(userId) as { cnt: number };

  const rows = includeRead
    ? dbCtx.db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(sql`CASE WHEN ${notifications.readAt} IS NULL THEN 0 ELSE 1 END`, desc(notifications.createdAt))
        .limit(limit)
        .all()
    : dbCtx.db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
        .orderBy(desc(notifications.createdAt))
        .limit(limit)
        .all();

  return {
    notifications: rows.map((n) => ({
      id: n.id,
      workspaceId: n.workspaceId,
      memoId: n.memoId,
      type: n.type,
      title: n.title,
      body: n.body,
      reminderTime: n.reminderTime,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    unread: unreadRow ? unreadRow.cnt : 0,
  };
}

export function markNotificationRead(dbCtx: DatabaseContext, userId: string, notificationId: string): boolean {
  const result = dbCtx.db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
    .run();
  return result.changes > 0;
}

export function markAllNotificationsRead(dbCtx: DatabaseContext, userId: string): number {
  const result = dbCtx.db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .run();
  return result.changes;
}

export interface ReminderScanResult {
  created: number;
  emailsSent: number;
  pushesSent: number;
}

/**
 * Scan memos for reminders that are due and create one notification per
 * (user, memo, reminder_time). Only freshly-due reminders (within the last
 * `freshWindowMs`) trigger, so a server restart does not spam users with
 * every historical overdue note.
 */
export async function scanDueReminders(
  dbCtx: DatabaseContext,
  options: { now?: number; freshWindowMs?: number; appUrl?: string } = {},
): Promise<ReminderScanResult> {
  const now = options.now ?? Date.now();
  // Audit M-9: the freshness window is configurable (REMINDER_FRESH_WINDOW_MS)
  // and the scan reports how many overdue reminders fell outside it, so an
  // operator notices when downtime swallowed reminders instead of wondering.
  const freshWindowMs = options.freshWindowMs ?? config.reminderFreshWindowMs;
  const appUrl = options.appUrl ?? '';

  // Overdue-but-stale reminders (due before the freshness window): counted
  // for the warning log, never delivered (anti-spam on restart).
  const staleRow = dbCtx.sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM memos
       WHERE deleted_at IS NULL AND is_archived = 0
         AND COALESCE(reminder_time, due_date) IS NOT NULL
         AND COALESCE(reminder_time, due_date) <= ?
         AND COALESCE(reminder_time, due_date) <= ?`,
    )
    .get(now, now - freshWindowMs) as { n: number };
  const skippedStale = Number(staleRow?.n ?? 0);
  if (skippedStale > 0) {
    // Intentionally not delivered (restart anti-spam) — but never silent.
    console.warn(
      `[reminders] ${skippedStale} overdue reminder(s) are older than the ${Math.round(freshWindowMs / 60000)}-minute delivery window and will not be sent. Increase REMINDER_FRESH_WINDOW_MS if your server is often offline for longer.`,
    );
  }

  const dueMemos = dbCtx.sqlite
    .prepare(
      `SELECT m.id, m.workspace_id, m.title, m.content, m.reminder_time, m.due_date, m.created_by,
              COALESCE(m.reminder_set_by, m.created_by) AS reminder_owner_id
       FROM memos m
       WHERE m.deleted_at IS NULL
         AND m.is_archived = 0
         AND COALESCE(m.reminder_time, m.due_date) IS NOT NULL
         AND COALESCE(m.reminder_time, m.due_date) <= ?
         AND COALESCE(m.reminder_time, m.due_date) > ?`,
    )
    .all(now, now - freshWindowMs) as Array<{
    id: string;
    workspace_id: string;
    title: string;
    content: string;
    reminder_time: number | null;
    due_date: number | null;
    created_by: string;
    reminder_owner_id: string;
  }>;

  let created = 0;
  let emailsSent = 0;
  let pushesSent = 0;

  for (const memo of dueMemos) {
    const reminderTime = memo.reminder_time ?? memo.due_date;
    if (reminderTime == null) continue;

    // Audit H-2: a reminder notifies ONLY the user who set it. The previous
    // behavior fanned every due reminder out to every non-viewer member of
    // the workspace — leaking personal note titles and bodies to colleagues.
    // reminder_set_by is backfilled to created_by for legacy rows.
    // Audit L-13: if the owner is no longer a member of the workspace (they
    // left or were removed), the reminder is dropped instead of following them.
    const member = dbCtx.sqlite
      .prepare(
        `SELECT u.id AS user_id, u.email, u.name, u.status, u.timezone
         FROM users u
         JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
         WHERE u.id = ?`,
      )
      .get(memo.workspace_id, memo.reminder_owner_id) as
      | { user_id: string; email: string; name: string; status: string; timezone: string }
      | undefined;

    if (!member || member.status !== 'active') continue;
    const members = [member];

    for (const member of members) {
      const body = (memo.content || '').replace(/[#*`>\-[\]]/g, '').trim().slice(0, 160) || null;
      const notificationId = crypto.randomUUID();
      const insert = dbCtx.sqlite
        .prepare(
          `INSERT OR IGNORE INTO notifications
             (id, user_id, workspace_id, memo_id, type, title, body, reminder_time, read_at, created_at)
           VALUES (?, ?, ?, ?, 'reminder', ?, ?, ?, NULL, ?)`,
        )
        .run(notificationId, member.user_id, memo.workspace_id, memo.id, memo.title || 'Untitled note', body, reminderTime, now);

      if (insert.changes === 0) continue; // already notified for this trigger
      created++;

      // Best-effort email delivery (audit M-16: times render in the user's
      // stored IANA timezone, not the server's UTC)
      if (isEmailEnabled()) {
        const email = renderReminderEmail({
          userName: member.name,
          memoTitle: memo.title || 'Untitled note',
          memoBody: body || '',
          reminderTime,
          appUrl,
          timezone: member.timezone || 'UTC',
        });
        const sent = await sendEmail({ to: member.email, ...email });
        if (sent) {
          emailsSent++;
          dbCtx.sqlite
            .prepare('UPDATE notifications SET email_sent_at = ? WHERE id = ?')
            .run(now, notificationId);
        }
      }

      // Best-effort web push delivery
      if (isPushEnabled()) {
        const delivered = await sendPushToUser(dbCtx, member.user_id, {
          title: `Reminder: ${memo.title || 'Untitled note'}`,
          body: body ?? 'Your scheduled note reminder is due.',
          url: '/',
          memoId: memo.id,
          notificationId,
        });
        if (delivered > 0) {
          pushesSent += delivered;
          dbCtx.sqlite
            .prepare('UPDATE notifications SET push_sent_at = ? WHERE id = ?')
            .run(now, notificationId);
        }
      }
    }
  }

  return { created, emailsSent, pushesSent };
}

/** Drop very old read notifications so the table stays bounded. */
export function pruneNotifications(dbCtx: DatabaseContext, olderThanMs = 90 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  const result = dbCtx.db
    .delete(notifications)
    .where(and(sql`${notifications.readAt} IS NOT NULL`, lte(notifications.createdAt, cutoff)))
    .run();
  return result.changes;
}

export interface ReminderSchedulerOptions {
  intervalMs?: number;
  appUrl?: string;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export function startReminderScheduler(
  dbCtx: DatabaseContext,
  options: ReminderSchedulerOptions = {},
): () => void {
  const intervalMs = Math.max(10_000, options.intervalMs ?? 30_000);
  const appUrl = options.appUrl ?? '';

  // Audit M-9: an async tick that outlives its interval could previously
  // overlap with the next one (duplicate scans under load). One tick at a time.
  let scanInFlight = false;
  const tick = async () => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const result = await scanDueReminders(dbCtx, { appUrl });
      if (result.created > 0) {
        options.logger?.info?.(
          `reminder scan: created ${result.created} notification(s), sent ${result.emailsSent} email(s), ${result.pushesSent} push(es)`,
        );
      }
    } catch (error) {
      options.logger?.error?.('reminder scan failed:', error);
    } finally {
      scanInFlight = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();

  // Nightly cleanup alongside scans
  const pruneTimer = setInterval(() => {
    try { pruneNotifications(dbCtx); } catch { /* non-fatal */ }
    // Audit L-7: expired sessions, spent/expired password resets and dead
    // invitations no longer accumulate forever.
    try { pruneExpiredAuthArtifacts(dbCtx.db); } catch { /* non-fatal */ }
  }, 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  return () => {
    clearInterval(timer);
    clearInterval(pruneTimer);
  };
}
