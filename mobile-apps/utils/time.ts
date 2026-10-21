/** Time helpers. All backend timestamps are Unix epoch milliseconds. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** "2h ago"-style relative label (pure; screen-friendly and testable). */
export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 0) return formatClock(ts, now);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m}m ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h}h ago`;
  }
  if (diff < 7 * DAY) {
    const d = Math.floor(diff / DAY);
    return `${d}d ago`;
  }
  return formatDate(ts, now);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Locale-independent date: "Oct 21, 2026". */
export function formatDate(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sameYear = new Date(now).getFullYear() === d.getFullYear();
  const base = `${months[d.getMonth()]} ${d.getDate()}`;
  return sameYear ? base : `${base}, ${d.getFullYear()}`;
}

/** Time of day: "14:05". */
export function formatClock(ts: number, _now = Date.now()): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Oct 21, 14:05" — used in reminders and sync screens. */
export function formatDateTime(ts: number, now = Date.now()): string {
  return `${formatDate(ts, now)}, ${formatClock(ts, now)}`;
}

/** Bytes → human readable ("1.4 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Exponential backoff with jitter: base * 2^attempt, ±30%, capped. */
export function backoffDelay(attempt: number, opts?: { baseMs?: number; capMs?: number; random?: () => number }): number {
  const base = opts?.baseMs ?? 2_000;
  const cap = opts?.capMs ?? 10 * 60_000;
  const random = opts?.random ?? Math.random;
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jitter = 1 + (random() * 0.6 - 0.3);
  return Math.min(cap, Math.round(exp * jitter));
}
