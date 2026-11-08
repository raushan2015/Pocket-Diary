/**
 * OpenAI adapter — Responses API (POST /v1/responses) with server-executed
 * function tools and SSE streaming, per the official function-calling guide.
 *
 * Wire format (verified against https://developers.openai.com/api/docs/guides/function-calling):
 *  - `instructions` carries the system prompt; `input` is an array of items:
 *    {role:'user'|'assistant', content:[{type:'input_text'|'output_text', text}]}.
 *  - Tools: {type:'function', name, description, parameters, strict:false}.
 *  - Streaming SSE events used here: response.output_text.delta,
 *    response.output_item.added (function_call items),
 *    response.function_call_arguments.delta, response.completed.
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

const FIXED_URL = 'https://api.openai.com/v1/responses';
const MODELS_URL = 'https://api.openai.com/v1/models';

interface OpenAiResponsesEvent {
  type?: string;
  delta?: string;
  item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
  item_id?: string;
  response?: {
    output?: Array<{ type?: string; name?: string; call_id?: string; arguments?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}

function buildRequestBody(req: AdapterChatRequest, stream: boolean): string {
  const input: unknown[] = [];
  for (const message of req.messages) {
    const contentType = message.role === 'assistant' ? 'output_text' : 'input_text';
    input.push({ role: message.role, content: [{ type: contentType, text: message.content }] });
  }
  const body: Record<string, unknown> = {
    model: req.config.modelId,
    instructions: req.systemPrompt,
    input,
    stream,
    max_output_tokens: req.maxOutputTokens ?? 2048,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false,
    }));
  }
  return JSON.stringify(body);
}

async function* chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const url = resolveEndpoint('openai', FIXED_URL);
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
        let event: OpenAiResponsesEvent;
        try {
          event = JSON.parse(payload) as OpenAiResponsesEvent;
        } catch {
          yield { type: 'error', code: 'bad_response', message: 'Malformed event from OpenAI' };
          return;
        }
        switch (event.type) {
          case 'response.output_text.delta':
            if (event.delta) yield { type: 'text', delta: event.delta };
            break;
          case 'response.output_item.added':
            if (event.item?.type === 'function_call') {
              yield { type: 'tool_call', index: 0, id: event.item.call_id ?? event.item.id, name: event.item.name, arguments: event.item.arguments ?? '' };
            }
            break;
          case 'response.function_call_arguments.delta':
            if (event.delta) yield { type: 'tool_call', index: 0, argumentsDelta: event.delta };
            break;
          case 'response.completed': {
            if (event.response?.usage) {
              yield { type: 'usage', inputTokens: event.response.usage.input_tokens, outputTokens: event.response.usage.output_tokens };
            }
            // Completed responses may carry complete function calls (when no
            // delta events arrived for them).
            for (const item of event.response?.output ?? []) {
              if (item.type === 'function_call' && item.name) {
                yield { type: 'tool_call', index: 0, id: item.call_id, name: item.name, arguments: item.arguments ?? '' };
              }
            }
            yield { type: 'done', finishReason: 'stop' };
            return;
          }
          case 'response.failed':
          case 'error':
            yield { type: 'error', code: 'provider_error', message: 'OpenAI reported a failed response' };
            return;
          default:
            break;
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

interface OpenAiModelsResponse {
  data?: Array<{ id?: string }>;
}

async function listModels(config: { modelId: string; apiKey: string }): Promise<AdapterModelInfo[]> {
  const url = resolveEndpoint('openai', MODELS_URL);
  const json = await providerFetchJson<OpenAiModelsResponse>({
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
    const url = resolveEndpoint('openai', FIXED_URL);
    const res = await providerFetchStream({
      url,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ model: config.modelId, input: 'ping', max_output_tokens: 16, stream: true }),
      timeoutMs: 20_000,
    });
    for await (const _chunk of res.body) {
      void _chunk;
      break; // any successful stream start means the key + model are accepted
    }
    return { ok: true, message: 'Connection succeeded.', latencyMs: Date.now() - started };
  } catch (err) {
    const code = err instanceof ProviderRequestError ? err.code : 'network_error';
    return { ok: false, message: scrubKeyMaterial(err instanceof Error ? err.message : 'Connection failed'), latencyMs: Date.now() - started, ...(code === 'auth_error' ? {} : {}) };
  }
}

export const openAiAdapter: ProviderAdapter = {
  id: 'openai',
  chat,
  listModels,
  testConnection,
  supportsModelListing: true,
};
