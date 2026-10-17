/**
 * Pinned-DNS outbound fetch for server-side URL fetching (audit M-11).
 *
 * The SSRF guard resolves and validates a hostname, but `fetch()` performs its
 * OWN DNS resolution at connect time — with a DNS-rebinding attacker, the
 * address that got connected could differ from the one that was checked.
 *
 * guardedFetch closes that gap: it resolves + validates the URL, then connects
 * DIRECTLY to the validated IP (with the correct Host header and TLS SNI), so
 * the address that was checked is exactly the address that is used.
 */
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { resolvePublicHttpAddresses } from './url-guard.js';

export interface GuardedFetchOptions {
  /** Total request timeout in milliseconds (default 4000). */
  timeoutMs?: number;
  /** Response body byte cap — reading stops once reached (default 256 KB). */
  maxBytes?: number;
  /** User-Agent header (default a harmless bot string). */
  userAgent?: string;
  /** Extra headers to send. */
  headers?: Record<string, string>;
  method?: string;
}

export interface GuardedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** Decoded body text, capped at maxBytes. */
  body: string;
  /** The URL actually fetched (after validation). */
  url: URL;
}

export { UrlGuardError, UrlResolutionError } from './url-guard.js';

export async function guardedFetch(rawUrl: string | URL, options: GuardedFetchOptions = {}): Promise<GuardedResponse> {
  const url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl;
  const {
    timeoutMs = 4000,
    maxBytes = 256 * 1024,
    userAgent = 'Mozilla/5.0 (compatible; NotesBot/1.0)',
    headers: extraHeaders = {},
    method = 'GET',
  } = options;

  // Resolve + validate ONCE here; the connection below uses these exact IPs,
  // so a rebinding DNS server cannot redirect the actual request.
  const addresses = await resolvePublicHttpAddresses(url);
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = Number(url.port || (isHttps ? 443 : 80));

  const attemptAddress = (address: string): Promise<GuardedResponse> =>
    new Promise<GuardedResponse>((resolve, reject) => {
      // Hard deadline for the whole request (connect + headers + body):
      // req.setTimeout() measures socket *inactivity* and starts late for
      // pending connections; a wall-clock timer bounds the attempt exactly.
      let deadlineFired = false;
      let req: http.ClientRequest;
      const timeoutId = setTimeout(() => {
        deadlineFired = true;
        req.destroy(new Error(`upstream timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      req = lib.request(
        {
          host: address, // pinned: connect to the validated IP, not the hostname
          port,
          method,
          path: `${url.pathname}${url.search}`,
          headers: {
            host: url.host, // correct virtual host for the origin server
            'user-agent': userAgent,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            ...extraHeaders,
          },
          // SNI must match the original hostname for TLS (and certificate
          // validation still verifies the requested host, not the IP).
          ...(isHttps ? { servername: url.hostname } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          let settled = false;

          res.on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received <= maxBytes) {
              chunks.push(chunk);
            }
            if (received >= maxBytes) {
              res.destroy(); // cap reached — we have enough
              settled = true;
              clearTimeout(timeoutId);
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf-8'),
                url,
              });
            }
          });
          res.on('end', () => {
            if (settled) return;
            clearTimeout(timeoutId);
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf-8'),
              url,
            });
          });
          res.on('error', (err) => {
            if (!settled) {
              clearTimeout(timeoutId);
              reject(err);
            }
          });
        }
      );

      req.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(deadlineFired ? new Error(`upstream timeout after ${timeoutMs}ms`) : err);
      });
      req.end();
    });

  // Try each validated address in order; connection errors fall through to
  // the next one (mirrors fetch()'s happy-eyeballs behaviour, pinned).
  let lastError: unknown = new Error('no addresses resolved');
  for (const address of addresses) {
    try {
      return await attemptAddress(address);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}
