const isProduction = process.env.NODE_ENV === 'production';
const configuredCookieSecret = process.env.COOKIE_SECRET;

if (isProduction && (!configuredCookieSecret || configuredCookieSecret.length < 32)) {
  throw new Error('COOKIE_SECRET must be set to a unique secret of at least 32 characters in production.');
}

export const config = {
  port: Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  // This fallback is development-only. Production refuses to start without a strong secret.
  cookieSecret: configuredCookieSecret ?? 'development-only-cookie-secret-not-for-production',
  sessionDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  cookieName: 'memo_session',
  isProduction,
};
