/**
 * Shared provider adapter contract (handoff §3).
 *
 * Every provider integration is an independent, server-side adapter behind
 * this interface. Adapters translate between Pocket Diary's normalized
 * chat/tool format and each vendor's native API. They NEVER receive note
 * content from the caller beyond what the privacy pipeline already
 * authorized, and they never expose the API key beyond the Authorization
 * header of their own outbound request.
 *
 * Endpoints are compile-time constants. An operator-level base-URL override
 * (for integration tests against a local mock) is read from the environment
 * ONLY when NODE_ENV !== 'production' — production always talks to the
 * vetted official endpoint and cannot be redirected by user or model input.
 */

export type ProviderId = 'openai' | 'gemini' | 'deepseek' | 'nvidia_nim' | 'anthropic' | 'mistral' | 'groq' | 'openrouter' | 'ollama' | 'antigravity_cli';

export const PROVIDER_IDS: readonly ProviderId[] = ['openai', 'gemini', 'deepseek', 'nvidia_nim', 'anthropic', 'mistral', 'groq', 'openrouter', 'ollama', 'antigravity_cli'];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  nvidia_nim: 'NVIDIA NIM',
  anthropic: 'Anthropic (Claude)',
  mistral: 'Mistral AI',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (Local)',
  antigravity_cli: 'Google Subscription (Antigravity CLI)',
};

/** Normalized chat message handed to an adapter. */
export interface AdapterMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Normalized function-tool definition (JSON Schema parameters). */
export interface AdapterTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AdapterConfig {
  modelId: string;
  apiKey: string;
  /** Pocket Diary user ID (used by local CLI/OAuth adapters such as antigravity_cli). */
  userId?: string;
}

export interface AdapterChatRequest {
  config: AdapterConfig;
  systemPrompt: string;
  messages: AdapterMessage[];
  tools?: AdapterTool[];
  /** Wall-clock budget for the whole call (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Vendor-native reasoning control; null means leave the model default. */
  thinkingEffort?: 'low' | 'medium' | 'high' | null;
  /** Soft cap on generated tokens for the assistant reply. */
  maxOutputTokens?: number;
}

export type ProviderStreamEvent =
  | { type: 'text'; delta: string }
  /** Incremental or complete tool call. `index` groups argument deltas. */
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string; arguments?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
  | { type: 'done'; finishReason?: string }
  | { type: 'error'; code: ProviderErrorCode; message: string };

export type ProviderErrorCode =
  | 'auth_error'
  | 'rate_limited'
  | 'timeout'
  | 'network_error'
  | 'provider_error'
  | 'bad_response'
  | 'canceled';

export interface AdapterModelInfo {
  id: string;
  /** Best-effort capability hints from the vendor listing. */
  supportsTools?: boolean;
  supportsStreaming?: boolean;
}

export interface AdapterTestResult {
  ok: boolean;
  /** Safe, user-visible message. Must never include the API key or raw headers. */
  message: string;
  latencyMs?: number;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly label: string;
  readonly supportsStreaming: boolean;
  readonly supportsTools: boolean;
  readonly supportsModelListing: boolean;
  chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown>;
  listModels(config: AdapterConfig): Promise<AdapterModelInfo[]>;
  testConnection(config: AdapterConfig): Promise<AdapterTestResult>;
}

/**
 * Operator-level, NON-PRODUCTION base-URL override for integration tests.
 * Reads the env once; returns undefined in production so shipped builds
 * always talk to the fixed official endpoints.
 */
export function testBaseUrlOverride(provider: ProviderId): string | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  const envName = {
    openai: 'AI_OPENAI_BASE_URL',
    gemini: 'AI_GEMINI_BASE_URL',
    deepseek: 'AI_DEEPSEEK_BASE_URL',
    nvidia_nim: 'AI_NVIDIA_BASE_URL',
    anthropic: 'AI_ANTHROPIC_BASE_URL',
    mistral: 'AI_MISTRAL_BASE_URL',
    groq: 'AI_GROQ_BASE_URL',
    openrouter: 'AI_OPENROUTER_BASE_URL',
    ollama: 'AI_OLLAMA_BASE_URL',
    antigravity_cli: '',
  }[provider];
  if (!envName) return undefined;
  const value = process.env[envName]?.trim();
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${envName} must be an absolute http(s) URL`);
  }
  return value.replace(/\/+$/, '');
}

/**
 * Resolve the endpoint the adapter will call (fixed in production).
 * With a non-production override, the override acts as the BASE host and the
 * fixed URL's path is preserved, so e.g. AI_DEEPSEEK_BASE_URL=http://127.0.0.1:9999
 * redirects https://api.deepseek.com/chat/completions to http://127.0.0.1:9999/chat/completions.
 */
export function resolveEndpoint(provider: ProviderId, fixedUrl: string): string {
  const override = testBaseUrlOverride(provider);
  if (!override) return fixedUrl;
  const fixed = new URL(fixedUrl);
  const base = new URL(override);
  return `${base.origin}${fixed.pathname}${fixed.search}`;
}

/**
 * Classify an HTTP status / transport failure into a SAFE error category.
 * The raw provider body is deliberately NOT surfaced (it can echo request
 * material); messages are generic per category.
 */
export function classifyHttpFailure(status: number, provider: string): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'provider_error';
}

export const SAFE_ERROR_MESSAGES: Record<ProviderErrorCode, string> = {
  auth_error: 'The provider rejected the API key. Check the key in AI settings.',
  rate_limited: 'The provider rate limit was hit. Try again in a moment.',
  timeout: 'The provider did not respond in time. Try again.',
  network_error: 'Could not reach the provider. Check the server network connection.',
  provider_error: 'The provider reported an error. Try again shortly.',
  bad_response: 'The provider response could not be understood.',
  canceled: 'The request was canceled.',
};

/** 404/410 mean the model id (or endpoint) no longer exists upstream. */
export function providerFailureMessage(status: number): string {
  const code = classifyHttpFailure(status, 'provider');
  if (status === 404 || status === 410) {
    return `The provider returned HTTP ${status} — that model id no longer exists there. Choose a model from the model list in AI settings.`;
  }
  return `${SAFE_STATUS_HINT_PLACEHOLDER[code]} (HTTP ${status})`;
}
const SAFE_STATUS_HINT_PLACEHOLDER = SAFE_ERROR_MESSAGES;

export class ProviderRequestError extends Error {
  code: ProviderErrorCode;
  constructor(code: ProviderErrorCode, message?: string) {
    super(message ?? SAFE_ERROR_MESSAGES[code]);
    this.code = code;
    this.name = 'ProviderRequestError';
  }
}

/**
 * Incremental SSE parser: feeds raw byte/string chunks, emits complete
 * `data:` payload strings. Handles CRLF, multi-line data fields and the
 * `data: [DONE]` sentinel via the callback contract.
 */
export class SseLineParser {
  private buffer = '';
  private dataLines: string[] = [];

  /** Feed a chunk; returns an array of complete SSE data payloads. */
  push(chunk: string | Buffer): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const payloads: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      if (line === '') {
        // End of event: flush accumulated data lines as one payload.
        if (this.dataLines.length > 0) {
          payloads.push(this.dataLines.join('\n'));
          this.dataLines = [];
        }
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice(5).trimStart());
      } else if (line.startsWith(':')) {
        // comment/keep-alive — ignore
      }
      // event:/id:/retry: fields are intentionally ignored.
    }
    return payloads;
  }

  flush(): string[] {
    const payloads = this.dataLines.length > 0 ? [this.dataLines.join('\n')] : [];
    this.dataLines = [];
    this.buffer = '';
    return payloads;
  }
}
