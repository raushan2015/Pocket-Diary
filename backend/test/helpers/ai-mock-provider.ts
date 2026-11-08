/**
 * Scriptable mock AI provider for security & functional tests.
 *
 * The mock implements THREE wire shapes so every adapter is exercised
 * against its real protocol:
 *   - OpenAI Responses API SSE        (POST /v1/responses)
 *   - OpenAI-compatible chat completions SSE (POST /chat/completions and /v1/chat/completions)
 *   - Gemini streamGenerateContent SSE (POST /v1beta/models/:model:streamGenerateContent?alt=sse)
 * plus GET model listing endpoints for each shape.
 *
 * Every received request body is recorded and retrievable via
 * GET /__recorded — tests assert on EXACTLY what the provider received,
 * never on what the UI displays.
 */
import http from 'node:http';
import crypto from 'node:crypto';

export interface RecordedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  at: number;
}

export interface MockBehavior {
  /** Emit a function/tool call named `tool` with `args` instead of plain text. */
  toolCall?: { name: string; args: unknown } | null;
  /** Plain text reply (default echo). */
  text?: string;
  status?: number;
  statusBody?: string;
  /** Stream N text chunks then abort the connection abruptly (simulates dropped stream). */
  abortAfterChunks?: number;
  /** Delay before responding (ms). */
  delayMs?: number;
}

export class MockProviderServer {
  private server: http.Server;
  private recorded: RecordedRequest[] = [];
  behavior: MockBehavior = {};
  private port = 0;
  private sockets = new Set<import('node:net').Socket>();

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.recorded.push({ path: req.url ?? '', headers: req.headers, body, at: Date.now() });
        void this.handle(req, res, body).catch(() => {
          try { res.destroy(); } catch { /* ignore */ }
        });
      });
    });
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): Promise<void> {
    const url = req.url ?? '';
    if (url.startsWith('/__recorded')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ recorded: this.recorded }));
      return;
    }

    const behavior = this.behavior;
    if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
    if (behavior.status && behavior.status !== 200) {
      res.writeHead(behavior.status, { 'Content-Type': 'application/json' });
      res.end(behavior.statusBody ?? JSON.stringify({ error: { message: behavior.status === 401 ? 'Incorrect API key' : 'mock error' } }));
      return;
    }

    const isResponses = url.includes('/responses');
    const isGemini = url.includes('streamGenerateContent');
    const isModels = url.includes('/models');
    const isGeminiShape = isGemini || url.includes('/v1beta/');
    if (isModels) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const data = [{ id: 'mock-model-a' }, { id: 'mock-model-b' }];
      if (isGeminiShape) {
        res.end(JSON.stringify({ models: data.map((d) => ({ name: `models/${d.id}`, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] })) }));
      } else {
        res.end(JSON.stringify({ data }));
      }
      return;
    }

    let parsed: any = {};
    try { parsed = JSON.parse(body); } catch { /* leave empty */ }

    // Derive the last user text (all three shapes).
    let lastUser = '';
    if (isResponses) {
      const input = parsed.input ?? [];
      for (const item of input) {
        if (item.role === 'user') {
          const content = Array.isArray(item.content) ? item.content : [];
          lastUser = content.map((c: any) => c?.text ?? '').join(' ') || lastUser;
        }
      }
      if (parsed.instructions) lastUser = `${lastUser} ${parsed.instructions}`.trim();
    } else if (isGemini) {
      const contents = parsed.contents ?? [];
      for (const c of contents) {
        if (c.role !== 'user') continue;
        for (const p of c.parts ?? []) {
          if (p?.text) lastUser = p.text;
          else if (p?.functionResponse) lastUser = '[tool-result]';
        }
      }
    } else {
      const messages = parsed.messages ?? [];
      for (const m of messages) {
        if (m.role === 'user') lastUser = String(m.content ?? '');
      }
    }

    const wantsToolCall = behavior.toolCall && /__TOOL__/.test(lastUser);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });

    if (behavior.abortAfterChunks) {
      for (let i = 0; i < behavior.abortAfterChunks; i++) {
        res.write(sseFor(isResponses, isGemini, { text: `chunk ${i} ` }));
        await new Promise((r) => setTimeout(r, 20));
      }
      res.destroy(); // drop connection mid-stream
      return;
    }

    if (wantsToolCall && behavior.toolCall) {
      const { name, args } = behavior.toolCall;
      const argsJson = JSON.stringify(args);
      if (isResponses) {
        // Responses API: emit function_call item + completed event.
        res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_mock_1', name, arguments: '' } })}\n\n`);
        res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: argsJson })}\n\n`);
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 12, output_tokens: 8 } } })}\n\n`);
      } else if (isGemini) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_mock_1', function: { name, arguments: '' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argsJson } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }

    // Default: text echo behavior.
    const text = behavior.text ?? `MOCK_REPLY:${lastUser.slice(0, 80)}`;
    const parts = text.match(/[\s\S]{1,20}/g) ?? [];
    for (const part of parts) {
      res.write(sseFor(isResponses, isGemini, { text: part }));
    }
    if (isResponses) {
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 20, output_tokens: 10 } } })}\n\n`);
    } else if (isGemini) {
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
    res.end();
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  async getRecorded(): Promise<RecordedRequest[]> {
    return this.recorded;
  }

  clearRecorded(): void {
    this.recorded = [];
  }
}

function sseFor(isResponses: boolean, isGemini: boolean, payload: { text: string }): string {
  if (isResponses) {
    return `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: payload.text })}\n\n`;
  }
  if (isGemini) {
    return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: payload.text }] } }] })}\n\n`;
  }
  return `data: ${JSON.stringify({ choices: [{ delta: { content: payload.text } }] })}\n\n`;
}

export const TEST_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

/** Sensible test env: vault key + non-production base URL overrides set by the caller. */
export function withAiTestEnv<T>(fn: () => Promise<T>): Promise<T> {
  const prevKey = process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
  process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  return fn().finally(() => {
    if (prevKey === undefined) delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.AI_CREDENTIAL_ENCRYPTION_KEY = prevKey;
  });
}
