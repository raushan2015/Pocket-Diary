const isProduction = process.env.NODE_ENV === 'production';
const configuredCookieSecret = process.env.COOKIE_SECRET;

if (isProduction && (!configuredCookieSecret || configuredCookieSecret.length < 32)) {
  throw new Error('COOKIE_SECRET must be set to a unique secret of at least 32 characters in production.');
}

// Public URL used in reminder emails, invitations and password-reset links.
//
// Security (audit C-3): APP_URL is REQUIRED in production. Links that are
// emailed to users must never be derived from request headers — a forged
// `Host` or `X-Forwarded-Host` header would otherwise let an attacker
// poison a victim's password-reset link and steal the reset token.
const configuredAppUrl = process.env.APP_URL?.trim() || '';
export const appUrl = configuredAppUrl.replace(/\/$/, '');

if (isProduction && !appUrl) {
  throw new Error(
    'APP_URL must be set in production (e.g. https://notes.example.com). ' +
    'It is the only source for links in reminder emails, invitations and password-reset messages; ' +
    'deriving them from request headers would allow reset-link poisoning.',
  );
}

if (appUrl && !/^https?:\/\/[^\s]+$/i.test(appUrl)) {
  throw new Error('APP_URL must be an absolute http(s) URL, e.g. https://notes.example.com');
}

/** Development-only fallback when APP_URL is unset (production refuses to start). */
const devFallbackAppUrl = `http://localhost:${Number(process.env.PORT ?? 8080)}`;

/**
 * Single source of truth for the public base URL used in every emailed link
 * (password resets, invitations, reminders). Never reads request headers.
 */
export function resolveAppUrl(): string {
  return appUrl || devFallbackAppUrl;
}

// Optional SMTP transport for reminder emails and workspace invitations.
// When SMTP_HOST is not set, email delivery is disabled and the app falls back
// to in-app notifications and copyable invitation links.
const smtpHost = process.env.SMTP_HOST?.trim() || '';
export const smtpConfig = {
  enabled: Boolean(smtpHost),
  host: smtpHost,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER?.trim() || '',
  pass: process.env.SMTP_PASS ?? '',
  from: process.env.SMTP_FROM?.trim() || 'Pocket Diary <no-reply@notes.local>',
};

// Optional Web Push (VAPID) credentials. Generate with:
//   node -e "console.log(require('web-push').generateVAPIDKeys())"
// When unset, push delivery is disabled and clients fall back to in-app notifications.
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY?.trim() || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY?.trim() || '';
export const pushConfig = {
  enabled: Boolean(vapidPublicKey && vapidPrivateKey),
  publicKey: vapidPublicKey,
  privateKey: vapidPrivateKey,
  subject: process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@notes.local',
};

// Off-host backup replication: every new local snapshot is also copied to this
// directory (mount an NFS share or host bind-mount outside the data volume).
const backupReplicationDir = process.env.BACKUP_REPLICATION_DIR?.trim() || '';
export const backupConfig = {
  replicationDir: backupReplicationDir,
  replicationRetention: Math.max(1, Math.floor(Number(process.env.BACKUP_REPLICATION_RETENTION ?? 7) || 7)),
};

export const config = {
  port: Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  // This fallback is development-only. Production refuses to start without a strong secret.
  cookieSecret: configuredCookieSecret ?? 'development-only-cookie-secret-not-for-production',
  sessionDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  cookieName: 'memo_session',
  isProduction,
  /**
   * Proxy trust setting (audit H-1). Only requests from these addresses may
   * rewrite `request.ip` via X-Forwarded-For. Default trusts the loopback
   * reverse proxy this app ships with; set TRUST_PROXY=false when the
   * backend is exposed directly, or to the proxy's address/subnet.
   */
  trustProxy: process.env.TRUST_PROXY ?? '127.0.0.1',
  /**
   * Per-workspace storage quota (audit L-10). Previously hardcoded; now
   * configurable for self-hosters with more or less disk.
   */
  storageQuotaBytes: Math.max(50 * 1024 * 1024, Number(process.env.STORAGE_QUOTA_GB ?? 10) * 1024 * 1024 * 1024),
  /**
   * Reminder freshness window (audit M-9): only reminders that became due
   * within this window trigger a notification, so restarts never spam users
   * with ancient overdue notes. Servers that were down longer silently drop
   * older reminders — configurable here, and the scan logs what it skipped.
   */
  reminderFreshWindowMs: Math.max(60_000, Number(process.env.REMINDER_FRESH_WINDOW_MS ?? 2 * 60 * 60 * 1000) || 2 * 60 * 60 * 1000),
};
