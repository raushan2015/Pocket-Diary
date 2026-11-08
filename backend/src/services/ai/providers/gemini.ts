/**
 * Google Gemini adapter — native Gemini API (NOT an OpenAI-compatible
 * assumption), per https://ai.google.dev/gemini-api/docs/function-calling and
 * /streaming.
 *
 * Wire format:
 *  - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
 *    auth via `x-goog-api-key` header.
 *  - Body: {systemInstruction:{parts:[{text}]}, contents:[{role:'user'|'model',
 *    parts:[{text}|{functionCall:{name,args}}|{functionResponse:{name,response}}]}],
 *    tools:[{functionDeclarations:[…]}], generationConfig:{maxOutputTokens}}.
 *  - SSE data chunks: {candidates:[{content:{parts:[{text}|{functionCall}]},
 *    finishReason}], usageMetadata:{promptTokenCount,candidatesTokenCount}}.
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

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
  functionResponse?: { name?: string; response?: Record<string, unknown> };
}

interface GeminiChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string };
}

function buildRequestBody(req: AdapterChatRequest): string {
  const contents = req.messages.map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.content }],
  }));
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: req.maxOutputTokens ?? 2048 },
  };
  if (req.thinkingEffort) {
    const config = body.generationConfig as Record<string, unknown>;
    config.thinkingConfig = /^gemini-2\.5(?:-|$)/i.test(req.config.modelId)
      ? { thinkingBudget: { low: 1024, medium: 8192, high: 16384 }[req.thinkingEffort] }
      : { thinkingLevel: req.thinkingEffort };
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      },
    ];
  }
  return JSON.stringify(body);
}

async function* chat(req: AdapterChatRequest): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const base = resolveEndpoint('gemini', BASE);
  const url = `${base}/${encodeURIComponent(req.config.modelId)}:streamGenerateContent?alt=sse`;
  let res;
  try {
    res = await providerFetchStream({
      url,
      headers: {
        'x-goog-api-key': req.config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: buildRequestBody(req),
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
  let toolCallIndex = 0;
  try {
    for await (const chunk of res.body) {
      for (const payload of parser.push(chunk)) {
        let event: GeminiChunk;
        try {
          event = JSON.parse(payload) as GeminiChunk;
        } catch {
          yield { type: 'error', code: 'bad_response', message: 'Malformed event from Gemini' };
          return;
        }
        if (event.error) {
          const code = event.error.code === 401 || event.error.code === 403 ? 'auth_error' : 'provider_error';
          yield { type: 'error', code, message: code === 'auth_error' ? 'The provider rejected the API key. Check the key in AI settings.' : 'Gemini reported an error.' };
          return;
        }
        for (const candidate of event.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (typeof part.text === 'string' && part.text.length > 0) {
              yield { type: 'text', delta: part.text };
            }
            if (part.functionCall?.name) {
              yield {
                type: 'tool_call',
                index: toolCallIndex++,
                id: `gemini-call-${toolCallIndex}`,
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args ?? {}),
              };
            }
          }
          if (candidate.finishReason) {
            if (event.usageMetadata) {
              yield {
                type: 'usage',
                inputTokens: event.usageMetadata.promptTokenCount,
                outputTokens: event.usageMetadata.candidatesTokenCount,
              };
            }
            yield { type: 'done', finishReason: candidate.finishReason };
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

interface GeminiModelsResponse {
  models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
}

async function listModels(config: { modelId: string; apiKey: string }): Promise<AdapterModelInfo[]> {
  const url = resolveEndpoint('gemini', `${MODELS_URL}?pageSize=200`);
  const json = await providerFetchJson<GeminiModelsResponse>({
    url,
    headers: { 'x-goog-api-key': config.apiKey },
    timeoutMs: 15_000,
  });
  return (json.models ?? [])
    .filter((m) => typeof m.name === 'string')
    .map((m) => {
      const id = (m.name as string).replace(/^models\//, '');
      const methods = m.supportedGenerationMethods ?? [];
      return {
        id,
        supportsTools: methods.includes('generateContent'),
        supportsStreaming: methods.includes('streamGenerateContent') || methods.includes('generateContent'),
      };
    });
}

async function testConnection(config: { modelId: string; apiKey: string }): Promise<AdapterTestResult> {
  const started = Date.now();
  try {
    const base = resolveEndpoint('gemini', BASE);
    const url = `${base}/${encodeURIComponent(config.modelId)}:streamGenerateContent?alt=sse`;
    const res = await providerFetchStream({
      url,
      headers: {
        'x-goog-api-key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 16 } }),
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

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  chat,
  listModels,
  testConnection,
  supportsModelListing: true,
};
