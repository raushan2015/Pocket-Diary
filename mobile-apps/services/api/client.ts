/**
 * API client. One instance per server; a session token may be attached and
 * rotated (login sets it, logout clears it). All endpoint functions live in
 * endpoints.ts and go through this client so cookie handling, timeouts and
 * error classification are uniform.
 */
import { ApiError } from './transport';
import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from './transport';
import { SESSION_COOKIE_NAME } from './contracts';

export interface ApiClientOptions {
  /** Normalized base URL, e.g. https://notes.example.com or http://192.168.1.4:8080 */
  baseUrl: string;
  transport: HttpTransport;
  /** Session token (cookie value), or null before sign-in. */
  token?: string | null;
  defaultTimeoutMs?: number;
}

export class ApiClient {
  readonly baseUrl: string;
  private transport: HttpTransport;
  private token: string | null;
  private readonly defaultTimeoutMs: number;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.transport = opts.transport;
    this.token = opts.token ?? null;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async rawRequest(req: Omit<HttpTransportRequest, 'url'> & { path: string }): Promise<HttpTransportResponse> {
    const full: HttpTransportRequest = {
      url: this.url(req.path),
      method: req.method,
      headers: { ...req.headers },
      body: req.body,
      timeoutMs: req.timeoutMs ?? this.defaultTimeoutMs,
    };
    if (this.token) {
      full.headers.Cookie = `${SESSION_COOKIE_NAME}=${this.token}`;
    }
    let res: HttpTransportResponse;
    try {
      res = await this.transport.request(full);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort|timeout|timed out/i.test(message)) {
        throw new ApiError({ kind: 'timeout', message: `Request timed out (${req.method} ${req.path})` });
      }
      throw new ApiError({
        kind: 'network',
        message: `Network request failed (${req.method} ${req.path}): ${message}`,
      });
    }
    return res;
  }

  /**
   * JSON request. Throws ApiError for network/timeout/HTTP/not-json failures.
   * Note: does NOT 401-manage — callers decide (the sync engine treats 401 as
   * session-expiry and stops; screens show sign-in prompts).
   */
  async requestJson<T>(
    method: HttpTransportRequest['method'],
    path: string,
    opts?: { body?: unknown; query?: Record<string, string | number | boolean | undefined>; timeoutMs?: number },
  ): Promise<{ data: T; headers: Record<string, string> }> {
    const query = opts?.query
      ? `?${Object.entries(opts.query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')}`
      : '';
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (opts?.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await this.rawRequest({ path: `${path}${query}`, method, headers, body, timeoutMs: opts?.timeoutMs ?? this.defaultTimeoutMs });

    const text = await res.text();
    if (!res.ok) {
      let serverMessage: string | undefined;
      let currentVersion: number | undefined;
      try {
        const parsed = JSON.parse(text) as { message?: string; currentVersion?: number };
        if (typeof parsed.message === 'string') serverMessage = parsed.message;
        if (typeof parsed.currentVersion === 'number') currentVersion = parsed.currentVersion;
      } catch {
        // non-JSON error body — fall through with the raw status
      }
      throw new ApiError({
        kind: 'http',
        status: res.status,
        message: `${method} ${path} failed with ${res.status}`,
        serverMessage,
        currentVersion,
      });
    }
    const contentType = res.headers['content-type'] ?? '';
    if (contentType.includes('text/html')) {
      throw new ApiError({
        kind: 'not-json',
        status: res.status,
        message: `${method} ${path} returned HTML, not the Pocket Diary API`,
      });
    }
    let parsed: unknown;
    try {
      parsed = text.length ? JSON.parse(text) : {};
    } catch {
      throw new ApiError({ kind: 'not-json', status: res.status, message: `Invalid JSON from ${path}` });
    }
    return { data: parsed as T, headers: res.headers };
  }

  /**
   * Multipart upload. `form` is a FormData (RN supports {uri,name,type} parts).
   * Returns raw response for callers that need headers/status.
   */
  async requestMultipart(
    path: string,
    form: FormData,
    opts?: { timeoutMs?: number },
  ): Promise<HttpTransportResponse> {
    return this.rawRequest({
      path,
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
      timeoutMs: opts?.timeoutMs ?? 90_000,
    });
  }
}
