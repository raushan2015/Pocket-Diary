/**
 * OpenRouter provider adapter.
 * Single key for 100+ models. Uses OpenAI-compatible API format.
 */
import { providerFetchStream, providerFetchJson, scrubKeyMaterial } from '../provider-fetch.js';
import { resolveEndpoint } from '../provider-types.js';
import type { ProviderAdapter, AdapterChatRequest, AdapterModelInfo, AdapterTestResult, AdapterConfig, ProviderStreamEvent, ProviderErrorCode } from '../provider-types.js';

const BASE_URL = 'https://openrouter.ai/api/v1';
const MODELS_URL = `${BASE_URL}/models`;
const CHAT_URL = `${BASE_URL}/chat/completions`;

function extractModelId(fullModelId: string): string {
  if (fullModelId.startsWith('openrouter/')) {
    return fullModelId.slice('openrouter/'.length);
  }
  return fullModelId;
}

function buildRequestBody(req: AdapterChatRequest, stream: boolean): string {
  const model = extractModelId(req.config.modelId);

  const body: Record<string, any> = {
    model,
    messages: req.messages.map(m => ({
      role: m.role,
      content: m.content
    })),
    max_tokens: req.maxOutputTokens ?? 4096,
    temperature: 0.7,
    stream
  };

  if (req.systemPrompt) {
    body.messages.unshift({ role: 'system', content: req.systemPrompt });
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
    body.tool_choice = 'auto';
  }

  return JSON.stringify(body);
}

async function* chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const url = resolveEndpoint('openrouter', CHAT_URL);
  let res;
  try {
    res = await providerFetchStream({
      url,
      headers: {
        'Authorization': `Bearer ${req.config.apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'HTTP-Referer': 'https://pocket-diary.local',
        'X-Title': 'Pocket Diary'
      },
      body: buildRequestBody(req, true),
      timeoutMs: req.timeoutMs ?? 120_000,
      signal: req.signal,
      secretsToScrub: [req.config.apiKey]
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'ProviderRequestError') {
      yield { type: 'error', code: (err as any).code, message: err.message };
      return;
    }
    throw err;
  }

  const { SseLineParser } = await import('../provider-types.js');
  const parser = new SseLineParser();

  try {
    for await (const chunk of res.body) {
      for (const payload of parser.push(chunk)) {
        if (payload === '[DONE]') {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
        try {
          const event = JSON.parse(payload);
          const choice = event.choices?.[0];
          if (!choice) continue;

          if (choice.delta?.content) {
            yield { type: 'text', delta: choice.delta.content };
          }

          if (choice.delta?.tool_calls) {
            for (let i = 0; i < choice.delta.tool_calls.length; i++) {
              const toolCall = choice.delta.tool_calls[i];
              if (toolCall.function?.name) {
                yield {
                  type: 'tool_call',
                  index: i,
                  id: toolCall.id,
                  name: toolCall.function.name,
                  argumentsDelta: toolCall.function.arguments
                };
              }
            }
          }

          if (choice.finish_reason) {
            if (choice.finish_reason !== 'tool_calls') {
              if (event.usage) {
                yield { type: 'usage', inputTokens: event.usage.prompt_tokens, outputTokens: event.usage.completion_tokens };
              }
              yield { type: 'done', finishReason: choice.finish_reason };
              return;
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
    yield { type: 'done', finishReason: 'stop' };
  } catch (err) {
    if (err instanceof Error && err.name === 'ProviderRequestError') {
      yield { type: 'error', code: (err as any).code, message: err.message };
      return;
    }
    throw err;
  }
}

async function listModels(config: AdapterConfig): Promise<AdapterModelInfo[]> {
  try {
    const url = resolveEndpoint('openrouter', MODELS_URL);
    const data = await providerFetchJson<{ data?: Array<{ id?: string }> }>({
      url,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      timeoutMs: 15_000
    });
    return (data.data ?? [])
      .map((m: any) => ({
        id: `openrouter/${m.id}`,
        supportsTools: true,
        supportsStreaming: true
      }))
      .filter((m: AdapterModelInfo) => m.id);
  } catch {
    return [];
  }
}

async function testConnection(config: AdapterConfig): Promise<AdapterTestResult> {
  const start = Date.now();
  try {
    const url = resolveEndpoint('openrouter', MODELS_URL);
    await providerFetchJson({
      url,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      timeoutMs: 10_000
    });
    return { ok: true, message: 'Connection successful', latencyMs: Date.now() - start };
  } catch (err) {
    if (err instanceof Error && err.name === 'ProviderRequestError') {
      return {
        ok: false,
        message: scrubKeyMaterial(err.message, [config.apiKey]),
        latencyMs: Date.now() - start
      };
    }
    return { ok: false, message: err instanceof Error ? err.message : 'Connection failed', latencyMs: Date.now() - start };
  }
}

export const openrouterAdapter: ProviderAdapter = {
  id: 'openrouter',
  label: 'OpenRouter',
  supportsStreaming: true,
  supportsTools: true,
  supportsModelListing: true,
  chat,
  listModels,
  testConnection
};