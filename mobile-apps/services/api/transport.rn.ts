/**
 * React Native fetch transport.
 *
 * - `credentials: 'omit'`: never read/write the OS cookie jar — the session
 *   cookie is managed explicitly by the API client.
 * - AbortController timeouts.
 * - Response headers flattened to a lower-cased record; 'set-cookie' joined.
 */
import type {
  HttpTransport,
  HttpTransportRequest,
  HttpTransportResponse,
} from './transport';

export class FetchTransport implements HttpTransport {
  async request(req: HttpTransportRequest): Promise<HttpTransportResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        credentials: 'omit',
        signal: controller.signal,
      });
      const headers: Record<string, string> = {};
      const setCookies: string[] = [];
      if (typeof res.headers?.forEach === 'function') {
        res.headers.forEach((value: string, key: string) => {
          const lower = key.toLowerCase();
          if (lower === 'set-cookie') setCookies.push(value);
          else headers[lower] = value;
        });
      }
      if (setCookies.length > 0) headers['set-cookie'] = setCookies.join('\n');
      return {
        status: res.status,
        ok: res.ok,
        headers,
        text: () => res.text(),
      };
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TimeoutError(req.url);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class TimeoutError extends Error {
  constructor(url: string) {
    super(`Request timed out: ${url}`);
    this.name = 'TimeoutError';
  }
}
