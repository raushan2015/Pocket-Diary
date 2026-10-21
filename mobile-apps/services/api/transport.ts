/**
 * HTTP transport abstraction + error taxonomy.
 *
 * The domain layer (API client, sync engine, server probe) depends only on
 * `HttpTransport`, so tests script a fake transport while production uses
 * React Native's fetch with `credentials: 'omit'`.
 *
 * `credentials: 'omit'` matters: React Native otherwise keeps an implicit
 * OS-level cookie jar. This app manages its single `memo_session` cookie
 * explicitly (stored in SecureStore) and must never race a stale jar cookie
 * on the wire.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface HttpTransportRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string | FormData;
  timeoutMs: number;
}

export interface HttpTransportResponse {
  status: number;
  ok: boolean;
  /** Response headers, lower-cased keys. Multiple set-cookie values are joined with '\n'. */
  headers: Record<string, string>;
  text(): Promise<string>;
}

export interface HttpTransport {
  request(req: HttpTransportRequest): Promise<HttpTransportResponse>;
}

export type ApiErrorKind =
  | 'network' // request never completed (DNS, refused, TLS, airplane mode)
  | 'timeout'
  | 'not-json' // responded, but not the Pocket Diary API (e.g. an HTML page)
  | 'http' // completed with a non-2xx API status
  | 'parse'; // API-shaped but the payload failed contract validation

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  /** Server `message` when the API returned a typed error body. */
  readonly serverMessage?: string;
  /** Present on 409 memo conflicts: the version currently stored server-side. */
  readonly currentVersion?: number;

  constructor(opts: {
    kind: ApiErrorKind;
    status?: number;
    message: string;
    serverMessage?: string;
    currentVersion?: number;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.kind = opts.kind;
    this.status = opts.status ?? 0;
    this.serverMessage = opts.serverMessage;
    this.currentVersion = opts.currentVersion;
  }

  get isAuthExpired(): boolean {
    return this.kind === 'http' && this.status === 401;
  }

  get isConflict(): boolean {
    return this.kind === 'http' && this.status === 409;
  }

  get isRetryable(): boolean {
    if (this.kind === 'network' || this.kind === 'timeout') return true;
    if (this.kind === 'http') return this.status === 408 || this.status === 429 || this.status >= 500;
    return false;
  }

  /** Human-facing message. */
  userMessage(): string {
    if (this.serverMessage) return this.serverMessage;
    switch (this.kind) {
      case 'network':
        return 'Could not reach the server. Check your connection and the server address.';
      case 'timeout':
        return 'The server took too long to respond.';
      case 'not-json':
        return 'The server responded with a web page instead of the Pocket Diary API.';
      case 'parse':
        return 'The server sent an unexpected response.';
      default:
        return this.message;
    }
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Extracts the session cookie token from a set-cookie header value. */
export function extractSessionToken(setCookie: string | undefined | null, cookieName: string): string | null {
  if (!setCookie) return null;
  // Multiple set-cookie headers may arrive joined with '\n' (transport detail).
  const candidates = setCookie.split('\n');
  for (const raw of candidates) {
    const [pair] = raw.split(';');
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name === cookieName) {
      const value = pair.slice(eq + 1).trim();
      if (value) return value;
    }
  }
  return null;
}
