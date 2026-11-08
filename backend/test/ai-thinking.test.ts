import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolveThinkingEffort, ThinkingUnavailableError } from '../src/services/ai/thinking.service.js';
import { getAdapter } from '../src/services/ai/registry.js';
import { MockProviderServer } from './helpers/ai-mock-provider.js';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { TEST_ENCRYPTION_KEY } from './helpers/ai-mock-provider.js';

describe('AI thinking effort is forwarded to the actual provider', () => {
  let server: MockProviderServer;
  beforeAll(async () => {
    server = new MockProviderServer();
    const origin = await server.listen();
    process.env.AI_OPENAI_BASE_URL = origin;
    process.env.AI_GEMINI_BASE_URL = origin;
    process.env.AI_DEEPSEEK_BASE_URL = origin;
    process.env.AI_NVIDIA_BASE_URL = origin;
  });
  afterAll(async () => {
    delete process.env.AI_OPENAI_BASE_URL;
    delete process.env.AI_GEMINI_BASE_URL;
    delete process.env.AI_DEEPSEEK_BASE_URL;
    delete process.env.AI_NVIDIA_BASE_URL;
    await server.close();
  });

  const cases: Array<[string, string, 'low'|'medium'|'high', Record<string, unknown>]> = [
    ['openai', 'gpt-5.5', 'medium', { reasoning: { effort: 'medium' } }],
    ['gemini', 'gemini-3-flash-preview', 'high', { generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: 'high' } } }],
    ['gemini', 'gemini-2.5-flash', 'low', { generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 1024 } } }],
    ['deepseek', 'deepseek-chat', 'medium', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    ['nvidia_nim', 'openai/gpt-oss-20b', 'high', { reasoning_effort: 'high' }],
    ['nvidia_nim', 'z-ai/glm-5.3-flash', 'low', { reasoning_effort: 'low' }],
    ['nvidia_nim', 'z-ai/glm-5.3-flash', 'medium', { reasoning_effort: 'high' }],
    ['nvidia_nim', 'z-ai/glm-5.3-flash', 'high', { reasoning_effort: 'max' }],
    ['nvidia_nim', 'z-ai/glm-5.3', 'high', { reasoning_effort: 'max' }],
    ['nvidia_nim', 'zai-org/glm-5.3-flash', 'medium', { reasoning_effort: 'high' }],
  ];
  for (const [provider, modelId, selection, expected] of cases) {
    it(`${provider} / ${modelId} sends ${selection} as native reasoning control`, async () => {
      server.clearRecorded();
      const adapter = getAdapter(provider);
      expect(adapter).toBeTruthy();
      for await (const _event of adapter!.chat({
        config: { modelId, apiKey: 'sk-test-only-never-log' },
        systemPrompt: 'Answer normally',
        messages: [{ role: 'user', content: 'Hello' }],
        thinkingEffort: resolveThinkingEffort(provider, modelId, selection),
        maxOutputTokens: 2048,
      })) { /* consume mock streamed response */ }
      const recorded = await server.getRecorded();
      expect(recorded.length).toBeGreaterThan(0);
      const body = JSON.parse(recorded[0].body);
      for (const [key, value] of Object.entries(expected)) expect(body[key]).toEqual(value);
      expect(JSON.stringify(body)).not.toContain('sk-test-only-never-log');
    });
  }

  it('does not send a fake reasoning control to non-reasoning models', () => {
    expect(resolveThinkingEffort('nvidia_nim', 'meta/llama-3.3-70b-instruct', 'auto')).toBeNull();
    expect(() => resolveThinkingEffort('nvidia_nim', 'meta/llama-3.3-70b-instruct', 'high')).toThrow(ThinkingUnavailableError);
    expect(() => resolveThinkingEffort('nvidia_nim', 'z-ai/glm-4.7', 'high')).toThrow(ThinkingUnavailableError);
    expect(() => resolveThinkingEffort('openai', 'gpt-4o-mini', 'medium')).toThrow(ThinkingUnavailableError);
    expect(() => resolveThinkingEffort('gemini', 'gemini-2.0-flash', 'low')).toThrow(ThinkingUnavailableError);
    expect(() => resolveThinkingEffort('nvidia_nim', 'nvidia/nemotron-3-super-120b-a12b', 'medium')).toThrow(ThinkingUnavailableError);
  });

  it('accepts GLM High from the real chat endpoint and sends NVIDIA max', async () => {
    const dbCtx = createDatabase(':memory:');
    const app = buildApp({ dbCtx, logger: false });
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    try {
      await app.ready();
      server.clearRecorded();
      const user = await createTestUser(app, 'glm-thinking-qa@example.test', 'GLM Thinking QA');
      const provider = await app.inject({
        method: 'POST', url: '/api/v1/ai/providers',
        headers: { cookie: user.cookieHeader },
        payload: { provider: 'nvidia_nim', label: 'GLM', modelId: 'z-ai/glm-5.3-flash', apiKey: 'nvapi-glm-qa-fake-123456789' },
      });
      expect(provider.statusCode).toBe(201);
      const created = await app.inject({
        method: 'POST', url: '/api/v1/ai/conversations',
        headers: { cookie: user.cookieHeader }, payload: { workspaceId: user.workspace.id },
      });
      const id = created.json().conversation.id;
      const sent = await app.inject({
        method: 'POST', url: `/api/v1/ai/conversations/${id}/messages`,
        headers: { cookie: user.cookieHeader },
        payload: { content: 'Please answer this short question about my plan', thinking: 'high' },
      });
      expect(sent.statusCode).toBe(202);
      const requestId = sent.json().request.id;
      let status = '';
      for (let attempt = 0; attempt < 90; attempt++) {
        const result = await app.inject({
          method: 'GET', url: `/api/v1/ai/requests/${requestId}`,
          headers: { cookie: user.cookieHeader },
        });
        status = result.json().request.status;
        if (['complete', 'failed', 'interrupted'].includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      expect(status).toBe('complete');
      const recorded = await server.getRecorded();
      expect(recorded.length).toBeGreaterThan(0);
      const body = JSON.parse(recorded[0].body);
      expect(body.model).toBe('z-ai/glm-5.3-flash');
      expect(body.reasoning_effort).toBe('max');
      const history = await app.inject({
        method: 'GET', url: `/api/v1/ai/conversations/${id}`,
        headers: { cookie: user.cookieHeader },
      });
      expect(history.json().messages).toHaveLength(2);
    } finally {
      await app.close();
      dbCtx.sqlite.close();
      delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    }
  });

  it('rejects unsupported thinking before saving the user message', async () => {
    const dbCtx = createDatabase(':memory:');
    const app = buildApp({ dbCtx, logger: false });
    process.env.AI_CREDENTIAL_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    try {
      await app.ready();
      const user = await createTestUser(app, 'think-qa@example.test', 'Think QA');
      const provider = await app.inject({
        method: 'POST', url: '/api/v1/ai/providers', headers: { cookie: user.cookieHeader },
        payload: { provider: 'nvidia_nim', label: 'Testing', modelId: 'meta/llama-3.3-70b-instruct', apiKey: 'nvapi-qa-fake-123456789' },
      });
      expect(provider.statusCode).toBe(201);
      const created = await app.inject({
        method: 'POST', url: '/api/v1/ai/conversations', headers: { cookie: user.cookieHeader },
        payload: { workspaceId: user.workspace.id },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().conversation.id;
      const rejected = await app.inject({
        method: 'POST', url: `/api/v1/ai/conversations/${id}/messages`, headers: { cookie: user.cookieHeader },
        payload: { content: 'Complex idea', thinking: 'high' },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().code).toBe('thinking_not_supported');
      expect(rejected.json().message).toContain('thinking');
      const history = await app.inject({
        method: 'GET', url: `/api/v1/ai/conversations/${id}`, headers: { cookie: user.cookieHeader },
      });
      expect(history.json().messages).toHaveLength(0);
    } finally {
      await app.close();
      dbCtx.sqlite.close();
      delete process.env.AI_CREDENTIAL_ENCRYPTION_KEY;
    }
  });
});
