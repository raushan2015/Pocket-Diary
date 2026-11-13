/**
 * Anthropic (Claude) provider adapter.
 * Implements the ProviderAdapter interface using the shared provider-fetch utilities.
 */
import { providerFetchStream, providerFetchJson, scrubKeyMaterial } from '../provider-fetch.js';
import { resolveEndpoint } from '../provider-types.js';
import type { ProviderAdapter, AdapterChatRequest, AdapterModelInfo, AdapterTestResult, AdapterConfig, ProviderStreamEvent } from '../provider-types.js';

const BASE_URL = 'https://api.anthropic.com/v1';
const MODELS_URL = `${BASE_URL}/models`;
const CHAT_URL = `${BASE_URL}/messages`;

function toAnthropicMessages(messages: Array<{ role: string; content: string }>) {
  const systemMessage = messages.find(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  return {
    system: systemMessage?.content ?? '',
    messages: conversationMessages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }))
  };
}

function buildRequestBody(req: AdapterChatRequest, stream: boolean): string {
  const { system, messages: anthropicMessages } = toAnthropicMessages(req.messages);

  const body: Record<string, any> = {
    model: req.config.modelId,
    messages: anthropicMessages,
    max_tokens: req.maxOutputTokens ?? 4096,
    temperature: 0.7,
    stream
  };

  if (system) {
    body.system = system;
  }

  if (req.systemPrompt) {
    body.system = (body.system ? body.system + '\n\n' : '') + req.systemPrompt;
  }

  // Thinking budget for reasoning models (Claude 3.7 Sonnet+)
  if (req.thinkingEffort) {
    const budgetMap = { low: 1024, medium: 4096, high: 16384, max: 32768 };
    const budget = budgetMap[req.thinkingEffort] ?? 4096;
    body.thinking = { type: 'enabled', budget_tokens: budget };
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
    body.tool_choice = { type: 'auto' };
  }

  return JSON.stringify(body);
}

async function* chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const url = resolveEndpoint('anthropic', CHAT_URL);
  let res;
  try {
    res = await providerFetchStream({
      url,
      headers: {
        'x-api-key': req.config.apiKey,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'max-tokens-3-5-sonnet-2024-07-15'
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

  let buffer = '';

  try {
    for await (const chunk of res.body) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }

        try {
          const event = JSON.parse(data);

          switch (event.type) {
            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                yield {
                  type: 'tool_call',
                  index: 0,
                  id: event.content_block.id,
                  name: event.content_block.name,
                  arguments: ''
                };
              }
              break;

            case 'content_block_delta':
              if (event.delta?.type === 'text_delta') {
                yield { type: 'text', delta: event.delta.text };
              } else if (event.delta?.type === 'input_json_delta') {
                yield {
                  type: 'tool_call',
                  index: 0,
                  argumentsDelta: event.delta.partial_json
                };
              }
              break;

            case 'content_block_stop':
              // Tool call complete
              break;

            case 'message_delta':
              if (event.usage) {
                yield { type: 'usage', inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens };
              }
              break;

            case 'message_stop':
              yield { type: 'done', finishReason: 'stop' };
              return;

            case 'error':
              yield { type: 'error', code: 'provider_error', message: event.error?.message ?? 'Anthropic error' };
              return;
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
    const url = resolveEndpoint('anthropic', MODELS_URL);
    const data = await providerFetchJson<{ data?: Array<{ id?: string }> }>({
      url,
      method: 'GET',
      headers: {
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01'
      },
      timeoutMs: 15_000
    });
    return (data.data ?? [])
      .map((m: any) => ({
        id: m.id,
        supportsTools: m.id?.includes('3-5') || m.id?.includes('3.7') || m.id?.includes('3-opus') || false,
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
    const url = resolveEndpoint('anthropic', CHAT_URL);
    await providerFetchJson({
      url,
      method: 'POST',
      headers: {
        'x-api-key': config.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10,
        stream: false
      }),
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

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  supportsStreaming: true,
  supportsTools: true,
  supportsModelListing: true,
  chat,
  listModels,
  testConnection
};