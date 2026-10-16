const isProduction = process.env.NODE_ENV === 'production';
const configuredCookieSecret = process.env.COOKIE_SECRET;

if (isProduction && (!configuredCookieSecret || configuredCookieSecret.length < 32)) {
  throw new Error('COOKIE_SECRET must be set to a unique secret of at least 32 characters in production.');
}

// Public URL used in reminder emails, invitations and password-reset links.
// When unset, request handlers fall back to the request's own host header.
const configuredAppUrl = process.env.APP_URL?.trim() || '';
export const appUrl = configuredAppUrl.replace(/\/$/, '');
export function resolveAppUrlForRequest(requestProtocol: string, requestHost: string | undefined): string {
  if (appUrl) return appUrl;
  return `${requestProtocol}://${String(requestHost || 'localhost').split(',')[0].trim()}`;
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
  from: process.env.SMTP_FROM?.trim() || 'Notes <no-reply@notes.local>',
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
};
