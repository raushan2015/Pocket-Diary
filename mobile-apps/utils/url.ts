/**
 * Server URL normalization + HTTP/HTTPS transport policy.
 *
 * Pocket Diary is self-hosted: users may point the app at anything from a
 * laptop on the LAN to a public HTTPS domain. The policy implemented here is
 * deliberately strict about credentials in transit:
 *
 *  - HTTPS is always allowed.
 *  - Plain HTTP is allowed ONLY for loopback-style development targets
 *    (localhost, 127.0.0.0/8, ::1, the Android-emulator host aliases) and,
 *    with an explicit user-acknowledged warning, for RFC1918 LAN addresses —
 *    a common local-development scenario.
 *  - Plain HTTP to anything else (public hosts) is rejected outright:
 *    passwords and the session cookie must never cross the internet in clear.
 */

export type UrlCheckCode =
  | 'empty'
  | 'invalid'
  | 'scheme'
  | 'https-required'
  | 'host-missing';

export interface UrlCheck {
  ok: boolean;
  /** Machine-readable failure reason (stable for tests/i18n). */
  code: UrlCheckCode;
  /** Human-readable failure reason (English). */
  message: string;
  /** Normalized absolute URL (no trailing slash) when ok. */
  normalized: string;
  /** Origin-only form (scheme://host[:port]) — used for display. */
  origin: string;
  /** True when the URL is a loopback/private target where HTTP is tolerated. */
  insecureAllowed: boolean;
  /** True when HTTP is permitted but the user must acknowledge the risk (LAN). */
  requiresAcknowledgement: boolean;
}

const LOOPBACK_ALIASES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '10.0.2.2', '10.0.3.2']);

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOOPBACK_ALIASES.has(host)) return true;
  if (host.startsWith('127.')) return true; // 127.0.0.0/8
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // mDNS-style development hosts
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;
  // IPv4 private ranges (RFC1918) + link-local
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local (esp. iOS tethering)
  }
  // IPv6 private-ish (fc00::/7, fe80::/10) — coarse textual check
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  return false;
}

const fail = (code: UrlCheckCode, message: string): UrlCheck => ({
  ok: false,
  code,
  message,
  normalized: '',
  origin: '',
  insecureAllowed: false,
  requiresAcknowledgement: false,
});

/**
 * Normalizes user input into an absolute server URL and applies the
 * transport-security policy.
 *
 * Examples:
 *   'notes.example.com'        → https://notes.example.com        (secure)
 *   'http://localhost:8080'     → http://localhost:8080           (loopback ok)
 *   '192.168.1.20:3000'         → http://192.168.1.20:3000        (LAN + warning)
 *   'http://notes.example.com'  → rejected (https-required)
 */
export function normalizeServerUrl(raw: string): UrlCheck {
  const input = (raw ?? '').trim();
  if (!input) return fail('empty', 'Enter the address of your Pocket Diary server.');

  // Scheme-less input: private/loopback hosts are almost certainly local dev
  // servers (plain HTTP); anything else defaults to HTTPS.
  let candidate = input;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    const hostPart = candidate.split('/')[0] ?? candidate;
    let host = hostPart.split(':')[0] ?? '';
    host = host.toLowerCase();
    if (!host) host = candidate.toLowerCase();
    const guessLocal = isLoopbackHost(host) || isPrivateHost(host);
    candidate = `${guessLocal ? 'http' : 'https'}://${candidate}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return fail('invalid', 'That does not look like a valid server address.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail('scheme', 'Only http and https server addresses are supported.');
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname) {
    return fail('host-missing', 'The server address is missing a host name.');
  }

  // Users may enter a path (e.g. a reverse-proxy subpath); keep it, drop the
  // trailing slash so `${base}/api/v1/...` concatenation is predictable.
  let path = url.pathname.replace(/\/+$/, '');
  if (path === '/') path = '';
  if (path.length > 128) {
    return fail('invalid', 'The path portion of the address is too long.');
  }

  const normalized = `${url.protocol}//${url.host}${path}`;
  const isHttps = url.protocol === 'https:';
  const loopback = isLoopbackHost(hostname);
  const priv = isPrivateHost(hostname);

  if (!isHttps && !loopback && !priv) {
    return fail(
      'https-required',
      'HTTPS is required for remote servers. Passwords and sessions are never sent over plain HTTP to public addresses.',
    );
  }

  return {
    ok: true,
    code: 'empty', // unused on success
    message: '',
    normalized,
    origin: url.origin,
    insecureAllowed: !isHttps,
    requiresAcknowledgement: !isHttps && !loopback,
  };
}

/** Stable scope key for a server: the normalized, lowercased URL itself. */
export function serverKeyForUrl(normalizedUrl: string): string {
  return normalizedUrl.toLowerCase();
}

/** True when the URL points at a loopback development target. */
export function isLoopbackUrl(normalizedUrl: string): boolean {
  try {
    return isLoopbackHost(new URL(normalizedUrl).hostname);
  } catch {
    return false;
  }
}
