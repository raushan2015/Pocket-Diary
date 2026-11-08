/**
 * Pocket Diary AI — mobile API contract tests.
 *
 * Verifies the typed endpoint layer against mock server responses:
 *  - provider config listing masks keys (keyLast4 only, never a full key),
 *  - the send-message flow returns a durable request for polling,
 *  - request status polling reaches terminal states,
 *  - note privacy values round-trip,
 *  - a full "send → poll → completed conversation" flow.
 */
import { describe, it, expect } from 'vitest';
import { ApiClient } from '@/services/api/client';
import { MockHttpTransport } from './helpers/mock-transport';
import {
  listAiProviders,
  previewAiModels,
  createAiProvider,
  createAiConversation,
  getAiConversation,
  sendAiMessage,
  getAiRequest,
  grantCurrentNoteToConversation,
  getAiNotePrivacy,
  setAiNotePrivacy,
} from '@/services/api/endpoints';

const config = {
  id: 'cfg-1',
  provider: 'deepseek',
  label: 'Main',
  modelId: 'deepseek-chat',
  keyLast4: 'a1b2',
  hasKey: true,
  isDefault: true,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

function makeApi(handlers: (t: MockHttpTransport) => void): ApiClient {
  const transport = new MockHttpTransport();
  handlers(transport);
  return new ApiClient({ baseUrl: 'https://notes.example.com', transport, token: 'session-token' });
}

describe('AI provider endpoints', () => {
  it('loads a real provider model list using the typed key without storing it', async () => {
    const requests: unknown[] = [];
    const api = makeApi((t) =>
      t.post('/api/v1/ai/providers/models-preview', (req) => {
        requests.push(req.body);
        return MockHttpTransport.json(200, {
          models: [{ id: 'mock-chat-1', supportsTools: true }, { id: 'mock-chat-2' }],
          manualEntryOnly: false,
        });
      }),
    );
    const models = await previewAiModels(api, 'nvidia_nim', 'nvapi-qa-model-list-key');
    expect(models.models.map((m) => m.id)).toEqual(['mock-chat-1', 'mock-chat-2']);
    expect(JSON.stringify(requests)).toContain('nvapi-qa-model-list-key');
    expect(JSON.stringify(models)).not.toContain('nvapi-qa-model-list-key');
  });

  it('lists provider configs with masked keys only', async () => {
    const api = makeApi((t) =>
      t.get('/api/v1/ai/providers', () =>
        MockHttpTransport.json(200, { configs: [config], vault: { configured: true } }),
      ),
    );
    const res = await listAiProviders(api);
    expect(res.configs).toHaveLength(1);
    expect(res.configs[0]?.keyLast4).toBe('a1b2');
    expect(JSON.stringify(res)).not.toContain('sk-');
    expect(res.vault.configured).toBe(true);
  });

  it('surfaces a disabled vault (missing server encryption key)', async () => {
    const api = makeApi((t) =>
      t.get('/api/v1/ai/providers', () =>
        MockHttpTransport.json(200, { configs: [], vault: { configured: false, hint: 'set AI_CREDENTIAL_ENCRYPTION_KEY' } }),
      ),
    );
    const res = await listAiProviders(api);
    expect(res.configs).toHaveLength(0);
    expect(res.vault.configured).toBe(false);
  });

  it('creates a provider and never returns the key', async () => {
    const seenBodies: unknown[] = [];
    const api = makeApi((t) =>
      t.post('/api/v1/ai/providers', (req) => {
        seenBodies.push(req.body);
        return MockHttpTransport.json(201, { config });
      }),
    );
    const created = await createAiProvider(api, {
      provider: 'openai',
      label: 'Mine',
      modelId: 'gpt-4o-mini',
      apiKey: 'sk-very-secret-key-42',
    });
    expect(created.id).toBe('cfg-1');
    // Request went through with the key (server encrypts it) but the RESPONSE has none.
    expect(JSON.stringify(seenBodies)).toContain('sk-very-secret-key-42');
    expect(JSON.stringify(created)).not.toContain('sk-very-secret-key-42');
  });
});

describe('AI chat flow', () => {
  it('create → send → poll → completed conversation', async () => {
    const conversation = { id: 'conv-1', workspaceId: 'ws-1', title: 'New chat', autoSaveNotes: false };
    const userMessage = { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'hello', status: 'complete', createdAt: 1 };
    const assistantMessage = { id: 'm2', conversationId: 'conv-1', role: 'assistant', content: 'MOCK_REPLY', status: 'complete', createdAt: 2 };

    // NOTE: the mock matches by substring and checks newest-first, so
    // GENERIC routes are registered first and SPECIFIC routes last.
    const api = makeApi((t) =>
      t
        .post('/api/v1/ai/conversations', () => MockHttpTransport.json(201, { conversation }))
        .get('/api/v1/ai/conversations', () => MockHttpTransport.json(200, { conversations: [conversation], total: 1 }))
        .post('/api/v1/ai/conversations/conv-1/messages', () =>
          MockHttpTransport.json(202, {
            userMessage,
            request: { id: 'req-1', conversationId: 'conv-1', status: 'queued', createdAt: 1, updatedAt: 1, finishedAt: null },
          }),
        )
        .get('/api/v1/ai/requests/req-1', () =>
          MockHttpTransport.json(200, {
            request: { id: 'req-1', conversationId: 'conv-1', status: 'complete', createdAt: 1, updatedAt: 2, finishedAt: 2 },
          }),
        )
        .get('/api/v1/ai/conversations/conv-1', () =>
          MockHttpTransport.json(200, { conversation, messages: [userMessage, assistantMessage], total: 2 }),
        ),
    );

    const created = await createAiConversation(api, 'ws-1');
    expect(created.id).toBe('conv-1');

    const sent = await sendAiMessage(api, 'conv-1', { content: 'hello', clientMessageId: 'rn-1' });
    expect(sent.request.id).toBe('req-1');
    expect(sent.request.status).toBe('queued');

    const status = await getAiRequest(api, 'req-1');
    expect(status.status).toBe('complete');

    const detail = await getAiConversation(api, 'conv-1');
    expect(detail.messages).toHaveLength(2);
    expect(detail.messages[1]?.role).toBe('assistant');
  });

  it('reports failed generation states honestly', async () => {
    const api = makeApi((t) =>
      t.get('/api/v1/ai/requests/req-x', () =>
        MockHttpTransport.json(200, {
          request: {
            id: 'req-x',
            conversationId: 'conv-1',
            status: 'interrupted',
            errorCode: 'interrupted',
            errorMessage: 'The server restarted while generating this reply. Send your message again.',
            createdAt: 1,
            updatedAt: 2,
            finishedAt: 2,
          },
        }),
      ),
    );
    const status = await getAiRequest(api, 'req-x');
    expect(status.status).toBe('interrupted');
    expect(status.errorMessage).toContain('Send your message again');
  });
});

describe('AI note privacy + grants', () => {
  it('issues a current-note grant with version and expiry', async () => {
    const api = makeApi((t) =>
      t.post('/api/v1/ai/current-note/grant', () =>
        MockHttpTransport.json(200, { grant: { grantId: 'g-1', memoId: 'memo-1', version: 3, expiresAt: Date.now() + 900_000 } }),
      ),
    );
    const grant = await grantCurrentNoteToConversation(api, {
      workspaceId: 'ws-1',
      memoId: 'memo-1',
      conversationId: 'conv-1',
      purpose: 'note_task',
    });
    expect(grant.grantId).toBe('g-1');
    expect(grant.version).toBe(3);
  });

  it('refuses grants for blocked notes with the server message', async () => {
    const api = makeApi((t) =>
      t.post('/api/v1/ai/current-note/grant', () =>
        MockHttpTransport.json(403, {
          error: 'Forbidden',
          message: 'This note is marked "never share with AI". You can keep chatting generally — the note content will not be sent.',
          code: 'note_blocked',
        }),
      ),
    );
    await expect(
      grantCurrentNoteToConversation(api, { workspaceId: 'ws-1', memoId: 'memo-blocked', conversationId: 'conv-1' }),
    ).rejects.toMatchObject({ status: 403, serverMessage: expect.stringMatching(/never share with AI/i) });
  });

  it('reads and updates the per-note AI privacy policy', async () => {
    let currentAccess = 'current_only';
    const api = makeApi((t) =>
      t
        .get('/api/v1/ai/memos/memo-1/protected-sections', () =>
          MockHttpTransport.json(200, { sections: [], aiAccess: currentAccess }),
        )
        .patch('/api/v1/ai/memos/memo-1/privacy', (req) => {
          const body = JSON.parse(String(req.body)) as { aiAccess: string };
          currentAccess = body.aiAccess;
          return MockHttpTransport.json(200, { memoId: 'memo-1', aiAccess: currentAccess });
        }),
    );
    const before = await getAiNotePrivacy(api, 'memo-1', 'ws-1');
    expect(before.aiAccess).toBe('current_only');
    const after = await setAiNotePrivacy(api, 'memo-1', 'ws-1', 'blocked');
    expect(after.aiAccess).toBe('blocked');
    const now = await getAiNotePrivacy(api, 'memo-1', 'ws-1');
    expect(now.aiAccess).toBe('blocked');
  });
});
