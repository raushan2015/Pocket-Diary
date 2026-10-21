import type { HttpTransport, HttpTransportRequest, HttpTransportResponse } from '@/services/api/transport';

export type MockHandler = (req: HttpTransportRequest) => Promise<HttpTransportResponse> | HttpTransportResponse;

export class MockHttpTransport implements HttpTransport {
  private handlers: {
    method?: string;
    matcher: (req: HttpTransportRequest) => boolean;
    handler: MockHandler;
  }[] = [];

  on(urlMatch: string | RegExp, handler: MockHandler, method?: string): this {
    this.handlers.unshift({
      method: method?.toUpperCase(),
      matcher: (req) => {
        if (method && req.method.toUpperCase() !== method.toUpperCase()) {
          return false;
        }
        return typeof urlMatch === 'string' ? req.url.includes(urlMatch) : urlMatch.test(req.url);
      },
      handler,
    });
    return this;
  }

  get(urlMatch: string | RegExp, handler: MockHandler): this {
    return this.on(urlMatch, handler, 'GET');
  }

  post(urlMatch: string | RegExp, handler: MockHandler): this {
    return this.on(urlMatch, handler, 'POST');
  }

  patch(urlMatch: string | RegExp, handler: MockHandler): this {
    return this.on(urlMatch, handler, 'PATCH');
  }

  delete(urlMatch: string | RegExp, handler: MockHandler): this {
    return this.on(urlMatch, handler, 'DELETE');
  }

  async request(req: HttpTransportRequest): Promise<HttpTransportResponse> {
    for (const h of this.handlers) {
      if (h.matcher(req)) {
        return h.handler(req);
      }
    }
    // Default 404
    return {
      status: 404,
      ok: false,
      headers: { 'content-type': 'application/json' },
      text: async () => JSON.stringify({ error: 'Not Found', message: `No mock handler for ${req.url}` }),
    };
  }

  static json(status: number, data: unknown, headers: Record<string, string> = {}): HttpTransportResponse {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { 'content-type': 'application/json', ...headers },
      text: async () => JSON.stringify(data),
    };
  }

  static html(status: number, body = '<!doctype html><html><body>Page</body></html>'): HttpTransportResponse {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { 'content-type': 'text/html' },
      text: async () => body,
    };
  }
}
