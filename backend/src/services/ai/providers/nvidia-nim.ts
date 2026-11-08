/**
 * NVIDIA NIM adapter — hosted NIM chat completions with tool calling where
 * the selected model supports it, per https://docs.api.nvidia.com/nim/reference/llm-apis.
 *
 *  - POST https://integrate.api.nvidia.com/v1/chat/completions
 *    (Authorization: Bearer nvapi-…, OpenAI-compatible messages/tools/stream).
 *  - Model capabilities vary across the NIM catalog: when a model rejects
 *    tools, the error is surfaced as an explicit "model lacks tool support"
 *    message — never silently faked.
 *  - Models: GET https://integrate.api.nvidia.com/v1/models.
 */
import {
  ProviderRequestError,
  SseLineParser,
  resolveEndpoint,
  type AdapterChatRequest,
  type AdapterModelInfo,
  type AdapterTestResult,
  type ProviderAdapter,
  type ProviderStreamEvent,
} from '../provider-types.js';
import { providerFetchStream, providerFetchJson, scrubKeyMaterial } from '../provider-fetch.js';
import { isNvidiaGlm53 } from '../thinking.service.js';

const CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';

interface OpenAiCompatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  detail?: string | { message?: string };
  title?: string;
}

interface NimModelsResponse {
  data?: Array<{ id?: string }>;
}

function buildRequestBody(req: AdapterChatRequest, stream: boolean): string {
  const messages: unknown[] = [{ role: 'system', content: req.systemPrompt }];
  for (const message of req.messages) {
    messages.push({ role: message.role, content: message.content });
  }
  const body: Record<string, unknown> = {
    model: req.config.modelId,
    messages,
    stream,
    max_tokens: req.maxOutputTokens ?? 2048,
  };
  if (req.thinkingEffort) {
    // NVIDIA GLM-5.3 implements low/high/max, not Pocket Diary's
    // low/medium/high. Sending 'medium' silently selects max, so explicitly
    // map all three user choices to distinct documented native levels.
    body.reasoning_effort = isNvidiaGlm53(req.config.modelId)
      ? ({ low: 'low', medium: 'high', high: 'max' } as const)[req.thinkingEffort]
      : req.thinkingEffort;
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  return JSON.stringify(body);
}

function isToolUnsupportedMessage(message: string): boolean {
  return /(does not|doesn't|cannot|can't|not) (support|supported).*tool|tool.*not.*support|Function call/i.test(message);
}

async function* chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const url = resolveEndpoint('nvidia_nim', CHAT_URL);
  let res;
  try {
    res = await providerFetchStream({
      url,
      headers: {
        Authorization: `Bearer ${req.config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: buildRequestBody(req, true),
      timeoutMs: req.timeoutMs ?? 120_000,
      signal: req.signal,
    });
  } catch (err) {
    if (err instanceof ProviderRequestError) {
      yield { type: 'error', code: err.code, message: err.message };
      return;
    }
    throw err;
  }

  const parser = new SseLineParser();
  try {
    for await (const chunk of res.body) {
      for (const payload of parser.push(chunk)) {
        if (payload === '[DONE]') {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        let event: OpenAiCompatChunk;
        try {
          event = JSON.parse(payload) as OpenAiCompatChunk;
        } catch {
          yield { type: 'error', code: 'bad_response', message: 'Malformed event from NVIDIA NIM' };
          return;
        }
        const detailMessage = typeof event.detail === 'string' ? event.detail : (event.detail?.message ?? '');
        if (detailMessage) {
          yield {
            type: 'error',
            code: /api key|unauthorized|auth/i.test(detailMessage) ? 'auth_error' : 'provider_error',
            message: isToolUnsupportedMessage(detailMessage)
              ? 'The selected model does not support tool calling. Choose a tool-capable model in AI settings.'
              : /api key|unauthorized|auth/i.test(detailMessage)
                ? 'The provider rejected the API key. Check the key in AI settings.'
                : 'NVIDIA NIM reported an error.',
          };
          return;
        }
        for (const choice of event.choices ?? []) {
          const delta = choice.delta;
          if (delta?.content) yield { type: 'text', delta: delta.content };
          for (const toolCall of delta?.tool_calls ?? []) {
            yield {
              type: 'tool_call',
              index: toolCall.index ?? 0,
              id: toolCall.id,
              name: toolCall.function?.name,
              argumentsDelta: toolCall.function?.arguments,
            };
          }
          if (choice.finish_reason) {
            if (event.usage) {
              yield { type: 'usage', inputTokens: event.usage.prompt_tokens, outputTokens: event.usage.completion_tokens };
            }
            yield { type: 'done', finishReason: choice.finish_reason };
            return;
          }
        }
      }
    }
    yield { type: 'done', finishReason: 'stop' };
  } catch (err) {
    if (err instanceof ProviderRequestError) {
      yield { type: 'error', code: err.code, message: err.message };
      return;
    }
    throw err;
  }
}

async function listModels(config: { modelId: string; apiKey: string }): Promise<AdapterModelInfo[]> {
  const url = resolveEndpoint('nvidia_nim', MODELS_URL);
  const json = await providerFetchJson<NimModelsResponse>({
    url,
    headers: { Authorization: `Bearer ${config.apiKey}` },
    timeoutMs: 15_000,
  });
  return (json.data ?? [])
    .filter((m) => typeof m.id === 'string')
    .map((m) => ({ id: m.id as string, supportsTools: true, supportsStreaming: true }));
}

async function testConnection(config: { modelId: string; apiKey: string }): Promise<AdapterTestResult> {
  const started = Date.now();
  try {
    const url = resolveEndpoint('nvidia_nim', CHAT_URL);
    const res = await providerFetchStream({
      url,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: buildRequestBody(
        { config: { modelId: config.modelId, apiKey: config.apiKey }, systemPrompt: 'ping', messages: [{ role: 'user', content: 'ping' }] },
        true
      ),
      timeoutMs: 20_000,
    });
    for await (const _chunk of res.body) {
      void _chunk;
      break;
    }
    return { ok: true, message: 'Connection succeeded.', latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, message: scrubKeyMaterial(err instanceof Error ? err.message : 'Connection failed'), latencyMs: Date.now() - started };
  }
}

export const nvidiaNimAdapter: ProviderAdapter = {
  id: 'nvidia_nim',
  chat,
  listModels,
  testConnection,
  supportsModelListing: true,
};
