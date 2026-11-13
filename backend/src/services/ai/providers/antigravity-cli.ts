/**
 * Antigravity CLI (`agy`) provider adapter — lets authenticated Pocket Diary
 * users chat using their personal Google Subscription plan via the local
 * Antigravity CLI installed inside the container.
 *
 * Isolation & safety:
 *  - Each user has an isolated HOME directory (`agy-homes/<userId>`), so OAuth
 *    tokens are strictly per-user.
 *  - Spawned inside an empty sandbox directory with `--sandbox` and
 *    `--disable-slash-commands`, never exposing container files or secrets.
 *  - Supports all Pocket Diary server tools via an inline `<<<PD_TOOL>>>`
 *    block protocol so Google Subscription models get full workspace control.
 */
import { spawn } from 'node:child_process';
import {
  ProviderRequestError,
  type AdapterChatRequest,
  type AdapterConfig,
  type AdapterModelInfo,
  type AdapterTestResult,
  type AdapterTool,
  type ProviderAdapter,
  type ProviderStreamEvent,
} from '../provider-types.js';
import {
  checkAgyInstalled,
  getAntigravityStatus,
  getAgySandboxDir,
  getUserAgyHome,
  listAntigravityModels,
  resolveAgyBinary,
} from '../antigravity-cli.service.js';

const TOOL_START = '<<<PD_TOOL>>>';
const TOOL_END = '<<<END_PD_TOOL>>>';

function summarizeToolSchema(tool: AdapterTool): string {
  const params = (tool.parameters ?? {}) as {
    properties?: Record<string, { type?: string; enum?: string[]; description?: string }>;
    required?: string[];
  };
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);
  const argSpecs = Object.entries(props).map(([k, v]) => {
    const typeLabel = v.enum ? v.enum.join('|') : (v.type ?? 'any');
    return `${k}${required.has(k) ? '' : '?'}:${typeLabel}`;
  });
  return `- ${tool.name}(${argSpecs.join(', ')}): ${tool.description}`;
}

export function compileAntigravityPrompt(req: AdapterChatRequest): string {
  const parts: string[] = [
    req.systemPrompt.trim(),
    'RUNTIME: You are running inside Pocket Diary AI chat. Respond in concise Markdown. Do NOT call CLI, shell, filesystem, or browser tools.',
  ];

  if (req.tools && req.tools.length > 0) {
    const toolLines = req.tools.map(summarizeToolSchema).join('\n');
    parts.push(
      [
        'POCKET DIARY SERVER TOOLS (emit one block per tool call, NO prose inside the block):',
        `${TOOL_START}\n{"name":"tool_name","arguments":{...}}\n${TOOL_END}`,
        'Wait for tool results before reporting completed mutations. Available tools:',
        toolLines,
      ].join('\n')
    );
  }

  parts.push('--- CONVERSATION ---');
  for (const msg of req.messages) {
    const label = msg.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`${label}:\n${msg.content.trim()}`);
  }
  parts.push('--- END ---\nReply as Assistant (or emit <<<PD_TOOL>>> calls):');
  return parts.join('\n\n');
}

interface StreamJsonLine {
  event?: string;
  step_update?: {
    state?: string;
    step_type?: string;
    text_delta?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
    };
  };
  result?: {
    status?: string;
    response?: string;
    error?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
    };
  };
}

/**
 * Stateful parser separating plain assistant text from inline
 * `<<<PD_TOOL>>>...<<<END_PD_TOOL>>>` JSON calls without leaking marker chunks.
 */
export class ToolStreamSplitter {
  private buf = '';
  private inTool = false;
  private toolIndex = 0;

  push(chunk: string): ProviderStreamEvent[] {
    this.buf += chunk;
    return this.drain(false);
  }

  flush(): ProviderStreamEvent[] {
    return this.drain(true);
  }

  private drain(finalFlush: boolean): ProviderStreamEvent[] {
    const events: ProviderStreamEvent[] = [];
    while (this.buf.length > 0) {
      if (!this.inTool) {
        const startIdx = this.buf.indexOf(TOOL_START);
        if (startIdx !== -1) {
          if (startIdx > 0) {
            events.push({ type: 'text', delta: this.buf.slice(0, startIdx) });
          }
          this.buf = this.buf.slice(startIdx + TOOL_START.length);
          this.inTool = true;
          continue;
        }
        if (!finalFlush) {
          // Hold back up to TOOL_START.length - 1 chars only if suffix matches prefix of TOOL_START.
          const safeLen = this.safePlainPrefixLength(this.buf, TOOL_START);
          if (safeLen > 0) {
            events.push({ type: 'text', delta: this.buf.slice(0, safeLen) });
            this.buf = this.buf.slice(safeLen);
          }
          break;
        }
        events.push({ type: 'text', delta: this.buf });
        this.buf = '';
        break;
      } else {
        const endIdx = this.buf.indexOf(TOOL_END);
        if (endIdx !== -1) {
          const rawJson = this.buf.slice(0, endIdx).trim();
          this.buf = this.buf.slice(endIdx + TOOL_END.length);
          this.inTool = false;
          const parsed = this.tryParseTool(rawJson);
          if (parsed) {
            const idx = this.toolIndex++;
            events.push({
              type: 'tool_call',
              index: idx,
              id: `agy-tool-${idx}`,
              name: parsed.name,
              arguments: JSON.stringify(parsed.arguments ?? {}),
            });
          } else if (rawJson) {
            events.push({ type: 'text', delta: rawJson });
          }
          continue;
        }
        if (!finalFlush) break;
        // Unclosed block on EOF: try parsing if it is valid JSON, else emit as text.
        const trailing = this.buf.trim();
        this.buf = '';
        this.inTool = false;
        const parsed = this.tryParseTool(trailing);
        if (parsed) {
          const idx = this.toolIndex++;
          events.push({
            type: 'tool_call',
            index: idx,
            id: `agy-tool-${idx}`,
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments ?? {}),
          });
        } else if (trailing) {
          events.push({ type: 'text', delta: trailing });
        }
        break;
      }
    }
    return events;
  }

  private safePlainPrefixLength(text: string, marker: string): number {
    const maxHold = Math.min(text.length, marker.length - 1);
    for (let len = maxHold; len > 0; len--) {
      if (marker.startsWith(text.slice(text.length - len))) {
        return text.length - len;
      }
    }
    return text.length;
  }

  private tryParseTool(raw: string): { name: string; arguments?: Record<string, unknown> } | null {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!cleaned) return null;
    try {
      const obj = JSON.parse(cleaned) as { name?: unknown; arguments?: unknown; args?: unknown };
      if (obj && typeof obj.name === 'string' && obj.name.trim()) {
        const rawArgs = obj.arguments ?? obj.args;
        const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
        return { name: obj.name.trim(), arguments: args };
      }
    } catch {
      // ignore invalid tool json
    }
    return null;
  }
}

function mapCliError(rawMessage: string): { code: 'auth_error' | 'rate_limited' | 'provider_error'; message: string } {
  if (/RESOURCE_EXHAUSTED|Individual quota reached|quota reached|\b429\b|rate.?limit/i.test(rawMessage)) {
    const resetMatch = rawMessage.match(/Resets in\s+([^\.\n]+)/i);
    const resetHint = resetMatch ? ` (Resets in ${resetMatch[1].trim()})` : '';
    return {
      code: 'rate_limited',
      message: `Google Subscription model quota reached${resetHint}. Switch to another model in AI Settings (for example Gemini 4 Argon, Gemini 4 Hydrogen, or Claude Sonnet) or use an API key.`,
    };
  }
  if (/authentication required|please sign in|oauth|unauthorized|\b401\b/i.test(rawMessage)) {
    return {
      code: 'auth_error',
      message: 'Google Subscription session expired or requires sign-in. Reconnect in AI Settings.',
    };
  }
  return {
    code: 'provider_error',
    message: rawMessage || 'Antigravity CLI failed to generate a response.',
  };
}

async function* chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const userId = req.config.userId;
  if (!userId) {
    yield { type: 'error', code: 'auth_error', message: 'User context missing for Google Subscription chat.' };
    return;
  }

  const status = await getAntigravityStatus(userId);
  if (!status.installed) {
    yield { type: 'error', code: 'provider_error', message: 'Antigravity CLI (agy) is not installed in this container.' };
    return;
  }
  if (!status.authenticated) {
    yield { type: 'error', code: 'auth_error', message: 'Google Subscription is not connected. Open AI Settings to sign in with Google.' };
    return;
  }

  const bin = resolveAgyBinary();
  const userHome = getUserAgyHome(userId);
  const sandboxDir = getAgySandboxDir();
  const prompt = compileAntigravityPrompt(req);

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--disable-slash-commands',
    '--sandbox',
  ];
  if (req.config.modelId) {
    args.push('--model', req.config.modelId);
  }
  if (req.thinkingEffort) {
    args.push('--effort', req.thinkingEffort);
  }
  const timeoutSec = Math.max(15, Math.round((req.timeoutMs ?? 120_000) / 1000));
  args.push('--print-timeout', `${timeoutSec}s`);

  const proc = spawn(bin, args, {
    cwd: sandboxDir,
    env: {
      ...process.env,
      HOME: userHome,
      NO_COLOR: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-8192);
  });

  const onAbort = () => {
    try {
      if (!proc.killed) proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  };
  if (req.signal?.aborted) {
    onAbort();
    yield { type: 'error', code: 'canceled', message: 'The request was canceled.' };
    return;
  }
  req.signal?.addEventListener('abort', onAbort, { once: true });

  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  let spawnErrMessage: string | null = null;
  let exitCode: number | null = null;
  let lineBuffer = '';

  const wake = () => {
    if (notify) {
      const fn = notify;
      notify = null;
      fn();
    }
  };

  proc.stdout.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = lineBuffer.indexOf('\n')) !== -1) {
      const line = lineBuffer.slice(0, nl).trim();
      lineBuffer = lineBuffer.slice(nl + 1);
      if (line) queue.push(line);
    }
    if (queue.length > 0) wake();
  });

  proc.on('error', (err) => {
    spawnErrMessage = err.message;
    ended = true;
    wake();
  });

  proc.on('close', (code) => {
    exitCode = code;
    if (lineBuffer.trim()) {
      queue.push(lineBuffer.trim());
      lineBuffer = '';
    }
    ended = true;
    wake();
  });

  let sawAnyText = false;
  let sawAnyTool = false;
  let sawDone = false;
  let lastUsage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } | null = null;
  const splitter = req.tools && req.tools.length > 0 ? new ToolStreamSplitter() : null;

  const emitChunk = function* (text: string): Generator<ProviderStreamEvent, void, unknown> {
    if (!splitter) {
      sawAnyText = true;
      yield { type: 'text', delta: text };
      return;
    }
    for (const ev of splitter.push(text)) {
      if (ev.type === 'text') sawAnyText = true;
      if (ev.type === 'tool_call') sawAnyTool = true;
      yield ev;
    }
  };

  try {
    while (!ended || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }

      const raw = queue.shift()!;
      if (req.signal?.aborted) {
        yield { type: 'error', code: 'canceled', message: 'The request was canceled.' };
        return;
      }

      let parsed: StreamJsonLine;
      try {
        parsed = JSON.parse(raw) as StreamJsonLine;
      } catch {
        continue;
      }

      if (parsed.event === 'step_update' && parsed.step_update?.step_type === 'agent_response') {
        const delta = parsed.step_update.text_delta;
        if (typeof delta === 'string' && delta.length > 0) {
          yield* emitChunk(delta);
        }
        if (parsed.step_update.usage) {
          lastUsage = {
            inputTokens: parsed.step_update.usage.input_tokens,
            outputTokens: parsed.step_update.usage.output_tokens,
            cacheReadTokens: parsed.step_update.usage.cache_read_tokens,
          };
        }
      } else if (parsed.event === 'result' && parsed.result) {
        if (parsed.result.usage) {
          lastUsage = {
            inputTokens: parsed.result.usage.input_tokens,
            outputTokens: parsed.result.usage.output_tokens,
            cacheReadTokens: parsed.result.usage.cache_read_tokens,
          };
        }
        if (parsed.result.status === 'SUCCESS') {
          if (!sawAnyText && !sawAnyTool && typeof parsed.result.response === 'string' && parsed.result.response) {
            yield* emitChunk(parsed.result.response);
          }
          if (splitter) {
            for (const ev of splitter.flush()) {
              if (ev.type === 'text') sawAnyText = true;
              if (ev.type === 'tool_call') sawAnyTool = true;
              yield ev;
            }
          }
          if (lastUsage) {
            yield { type: 'usage', ...lastUsage };
          }
          sawDone = true;
          yield { type: 'done', finishReason: sawAnyTool ? 'tool_calls' : 'stop' };
        } else {
          const mapped = mapCliError(parsed.result.error || stderrBuf);
          yield { type: 'error', code: mapped.code, message: mapped.message };
          return;
        }
      }
    }

    if (req.signal?.aborted) {
      yield { type: 'error', code: 'canceled', message: 'The request was canceled.' };
      return;
    }

    if (spawnErrMessage !== null) {
      yield { type: 'error', code: 'provider_error', message: `Antigravity CLI failed to start: ${spawnErrMessage}` };
      return;
    }

    if (!sawDone) {
      if (splitter) {
        for (const ev of splitter.flush()) {
          if (ev.type === 'text') sawAnyText = true;
          if (ev.type === 'tool_call') sawAnyTool = true;
          yield ev;
        }
      }
      if (sawAnyText || sawAnyTool) {
        if (lastUsage) yield { type: 'usage', ...lastUsage };
        yield { type: 'done', finishReason: sawAnyTool ? 'tool_calls' : 'stop' };
      } else if (stderrBuf.trim()) {
        const mapped = mapCliError(stderrBuf);
        yield { type: 'error', code: mapped.code, message: mapped.message };
      } else if (exitCode && exitCode !== 0) {
        yield { type: 'error', code: 'provider_error', message: 'Antigravity CLI exited unexpectedly. Check your Google Subscription connection in AI Settings.' };
      } else {
        yield { type: 'error', code: 'bad_response', message: 'Antigravity CLI closed without returning a response.' };
      }
    }
  } finally {
    req.signal?.removeEventListener('abort', onAbort);
    try {
      if (!proc.killed && proc.exitCode === null) proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}

async function listModels(config: AdapterConfig): Promise<AdapterModelInfo[]> {
  if (!config.userId) {
    throw new ProviderRequestError('auth_error', 'Sign in with Google Subscription first.');
  }
  try {
    const models = await listAntigravityModels(config.userId);
    return models.map((m) => ({
      id: m.id,
      supportsStreaming: true,
      supportsTools: true,
    }));
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === 'auth_required') {
      throw new ProviderRequestError('auth_error', (err as Error).message);
    }
    throw new ProviderRequestError('provider_error', (err as Error).message || 'Failed to list Antigravity models.');
  }
}

async function testConnection(config: AdapterConfig): Promise<AdapterTestResult> {
  const started = Date.now();
  const install = await checkAgyInstalled();
  if (!install.installed) {
    return { ok: false, message: 'Antigravity CLI (agy) is not installed in this container.' };
  }
  if (!config.userId) {
    return { ok: false, message: 'Missing user context.' };
  }
  const status = await getAntigravityStatus(config.userId);
  if (!status.authenticated) {
    return { ok: false, message: 'Not signed in with Google Subscription. Use "Generate Login Link" in AI Settings.' };
  }
  try {
    const models = await listAntigravityModels(config.userId);
    const latencyMs = Date.now() - started;
    const who = status.email ? ` as ${status.email}` : '';
    return {
      ok: true,
      message: `Connected${who} (${models.length} models available)`,
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      message: (err as Error).message || 'Antigravity CLI authentication check failed.',
      latencyMs: Date.now() - started,
    };
  }
}

export const antigravityCliAdapter: ProviderAdapter = {
  id: 'antigravity_cli',
  label: 'Google Subscription (Antigravity CLI)',
  supportsStreaming: true,
  supportsTools: true,
  supportsModelListing: true,
  chat,
  listModels,
  testConnection,
};
