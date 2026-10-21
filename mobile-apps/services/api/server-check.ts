/**
 * First-launch server validation.
 *
 * A fresh install knows nothing about the server except what the user types.
 * `probeServer` classifies what actually answers at that URL so the setup
 * screen can show a precise, actionable state. The ladder is:
 *
 *   1. GET <base>/api/v1/system/info   → current server: full capability set
 *   2. GET <base>/health               → older Pocket Diary: connect allowed,
 *                                        degraded capabilities (documented)
 *   3. anything else                   → incompatible / unreachable
 *
 * Network-level failures (DNS, TLS, refused) are surfaced as `unreachable`
 * — React Native does not expose a machine-readable TLS/DNS error code, so
 * the message enumerates the likely causes instead of pretending to know.
 */
import type { ApiClient } from './client';
import { ApiError } from './transport';
import { getHealth, getSystemInfo } from './endpoints';
import type { ApiSystemInfo } from './contracts';

export interface ProbeSuccess {
  status: 'ok' | 'legacy-ok';
  /** Present for current servers; null for legacy ones. */
  info: ApiSystemInfo | null;
}

export interface ProbeFailure {
  status: 'unreachable' | 'incompatible';
  /** Stable machine code for tests. */
  code:
    | 'network'
    | 'server-error'
    | 'wrong-product'
    | 'not-json'
    | 'auth-required'
    | 'parse';
  message: string;
}

export type ProbeResult = ProbeSuccess | ProbeFailure;

export async function probeServer(api: ApiClient): Promise<ProbeResult> {
  // --- 1. Capability endpoint (current servers) --------------------------
  try {
    const info = await getSystemInfo(api);
    return { status: 'ok', info };
  } catch (err) {
    if (err instanceof ApiError && err.kind === 'http' && err.status === 404) {
      // 404 on /api/v1/system/info: older server, fall through to legacy ladder (/health)
    } else if (err instanceof ApiError) {
      switch (err.kind) {
        case 'http':
          if (err.status === 401 || err.status === 403) {
            return {
              status: 'incompatible',
              code: 'auth-required',
              message: 'The server demands sign-in before it will identify itself, which Pocket Diary servers never do. Double-check the address.',
            };
          }
          if (err.status >= 500) {
            return {
              status: 'unreachable',
              code: 'server-error',
              message: 'The server answered with an error. It may be starting up or misconfigured — try again in a moment.',
            };
          }
          return {
            status: 'incompatible',
            code: 'wrong-product',
            message: 'The server rejected the request in an unexpected way. This does not look like a Pocket Diary API.',
          };
        case 'network':
        case 'timeout':
          return {
            status: 'unreachable',
            code: 'network',
            message:
              'Could not reach the server. Check the address and port, that the server is running, ' +
              'and — for HTTPS servers — that their certificate is valid.',
          };
        case 'not-json':
          return {
            status: 'incompatible',
            code: 'not-json',
            message: 'This address serves a web page, not a Pocket Diary API. Make sure you are using the server URL, not the docs page.',
          };
        case 'parse':
          return {
            status: 'incompatible',
            code: 'parse',
            message: 'The server responded, but not with Pocket Diary system information. This is probably not a Pocket Diary server.',
          };
      }
    } else {
      throw err;
    }
  }

  // --- 2. Legacy ladder: /health -----------------------------------------
  try {
    const health = await getHealth(api);
    if (health.status === 'ok') {
      return {
        status: 'legacy-ok',
        info: null,
        // Older server: no capability endpoint. The app still works; offline
        // note creation falls back to content-match dedupe on ambiguous
        // retries (see features/sync/engine.ts).
      };
    }
    return {
      status: 'incompatible',
      code: 'parse',
      message: 'The server responded, but not like a Pocket Diary server.',
    };
  } catch (err: any) {
    if (err instanceof ApiError) {
      if (err.kind === 'network') {
        return {
          status: 'unreachable',
          code: 'network',
          message: 'Could not reach the server. Check the address and port, and that the server is running.',
        };
      }
      if (err.kind === 'not-json') {
        return {
          status: 'incompatible',
          code: 'not-json',
          message: 'This address serves a web page, not a Pocket Diary API.',
        };
      }
    }
    return {
      status: 'incompatible',
      code: 'parse',
      message: 'The server responded, but not like a Pocket Diary server.',
    };
  }
}
