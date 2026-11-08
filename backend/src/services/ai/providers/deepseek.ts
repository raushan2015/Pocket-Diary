/**
 * DeepSeek adapter — OpenAI-compatible Chat Completions API with tool calling
 * and SSE streaming, per https://api-docs.deepseek.com/ and
 * https://api-docs.deepseek.com/api/create-chat-completion/.
 *
 *  - POST https://api.deepseek.com/chat/completions (Authorization: Bearer).
 *  - tools: [{type:'function', function:{name, description, parameters}}].
 *  - Streaming deltas: choices[0].delta.content / delta.tool_calls[].function.arguments,
 *    finish_reason, optional usage on the final chunk.
 *  - Models: GET https://api.deepseek.com/models → {data:[{id}]}.
 *    NOTE: tool-call support is model-dependent (e.g. deepseek-reasoner has
 *    historically not supported function calling) — the chat service guards
 *    tool use and surfaces an explicit "model lacks tool support" error when
 *    the provider rejects tools.
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

const CHAT_URL = 'https://api.deepseek.com/chat/completions';
const MODELS_URL = 'https://api.deepseek.com/models';

interface OpenAiCompatChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

interface DeepSeekModelsResponse {
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
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  return JSON.stringify(body);
}

async function* chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const url = resolveEndpoint('deepseek', CHAT_URL);
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
          yield { type: 'error', code: 'bad_response', message: 'Malformed event from DeepSeek' };
          return;
        }
        if (event.error) {
          const msg = String(event.error.message ?? '');
          yield {
            type: 'error',
            code: /api key|unauthorized|auth/i.test(msg) ? 'auth_error' : 'provider_error',
            message: /api key|unauthorized|auth/i.test(msg)
              ? 'The provider rejected the API key. Check the key in AI settings.'
              : msg.includes('Function call') || /not support/i.test(msg)
                ? 'The selected model does not support tool calling. Choose a tool-capable model in AI settings.'
                : 'DeepSeek reported an error.',
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
  const url = resolveEndpoint('deepseek', MODELS_URL);
  const json = await providerFetchJson<DeepSeekModelsResponse>({
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
    const url = resolveEndpoint('deepseek', CHAT_URL);
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

export const deepseekAdapter: ProviderAdapter = {
  id: 'deepseek',
  chat,
  listModels,
  testConnection,
  supportsModelListing: true,
};
