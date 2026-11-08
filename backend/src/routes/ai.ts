/**
 * AI assistant routes (handoff §5). All endpoints require an authenticated
 * session (fastify.authenticate). Every authorization decision is made here
 * or in the services — never from model output or client-supplied IDs alone.
 *
 * SSE transport note: GET /ai/requests/:id/events streams server-sent events
 * for a durable generation job. Subscribing is decoupled from job creation,
 * so hiding the chat drawer or refreshing the browser never cancels
 * generation; reopening reconnects (Last-Event-ID replay from an in-memory
 * buffer, or final-state replay for finished requests).
 */
import type { FastifyPluginAsync } from 'fastify';
import crypto from 'node:crypto';
import {
  AiChatError,
  createConversation,
  getConversation,
  listConversations,
  renameConversation,
  deleteConversation,
  listMessages,
  sendMessage,
  getRequest,
  subscribeToRequest,
  cancelRequest,
  recoverInterruptedRequests,
  buildTranscriptNote,
  type ChatMode,
  type MessageDto,
} from '../services/ai/chat.service.js';
import {
  listConfigs,
  createConfig,
  updateConfig,
  deleteConfig,
  setDefault,
  getOwnedConfigRow,
  decryptConfigKey,
  AiConfigError,
  vaultStatus,
} from '../services/ai/provider-config.service.js';
import { getAdapter } from '../services/ai/registry.js';
import { scrubKeyMaterial } from '../services/ai/provider-fetch.js';
import {
  isAiAccessState,
  getNoteAiAccess,
  setNoteAiAccess,
  createGrant,
  revokeGrant,
  revokeGrantsForMemo,
  getLiveGrant,
  listProtectedSections,
  addProtectedSections,
  removeProtectedSection,
  CURRENT_NOTE_GRANT_TTL_MS,
} from '../services/ai/privacy.service.js';
import { searchNotesLocally, expandQueryLocally } from '../services/ai/search.service.js';
import {
  getProposal,
  approveProposal,
  rejectProposal,
  ProposalError,
  PROPOSAL_TTL_MS,
} from '../services/ai/proposal.service.js';
import { createMemo } from '../services/memo.service.js';
import { verifyWorkspaceMembership } from '../services/workspace.service.js';
import { SESSION_SECURITY, jsonResponse, errorResponses } from '../openapi.js';

const idSchema = { type: 'string', minLength: 1, maxLength: 64 };

const CHAT_MODES: readonly string[] = ['general', 'note_task', 'search', 'search_read'];

/**
 * Consistent OpenAPI metadata for AI routes (tag, auth, documented 2xx +
 * error responses). The generated spec contains route shapes only — never
 * secrets (verified by test/docs.test.ts).
 */
const aiMeta = (
  summary: string,
  description: string,
  success: { code: number; schema: object; description: string }
) => ({
  tags: ['AI'],
  summary,
  description,
  security: SESSION_SECURITY,
  openapi: {
    responses: {
      [success.code]: jsonResponse(success.schema, success.description),
      ...errorResponses([400, 401, 403, 404, 500]),
    },
  },
});

const maskedConfigSchema = {
  type: 'object',
  required: ['id', 'provider', 'label', 'modelId', 'keyLast4', 'hasKey', 'isDefault'],
  properties: {
    id: { type: 'string' },
    provider: { type: 'string' },
    label: { type: 'string' },
    modelId: { type: 'string' },
    keyLast4: { type: 'string', description: 'Masked last 4 characters only.' },
    hasKey: { type: 'boolean' },
    isDefault: { type: 'boolean' },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
  },
};

const errorBodySchema = {
  type: 'object',
  required: ['error', 'message'],
  properties: { error: { type: 'string' }, message: { type: 'string' }, code: { type: 'string' } },
};

const conversationDtoSchema = {
  type: 'object',
  required: ['id', 'workspaceId', 'title', 'autoSaveNotes'],
  properties: {
    id: { type: 'string' },
    workspaceId: { type: 'string' },
    title: { type: 'string' },
    providerConfigId: { type: ['string', 'null'] },
    autoSaveNotes: { type: 'boolean' },
    createdAt: { type: ['integer', 'null'] },
    updatedAt: { type: ['integer', 'null'] },
    messageCount: { type: 'integer' },
  },
};

const messageDtoSchema = {
  type: 'object',
  required: ['id', 'conversationId', 'role', 'content', 'status'],
  properties: {
    id: { type: 'string' },
    conversationId: { type: 'string' },
    role: { type: 'string' },
    content: { type: 'string' },
    status: { type: 'string' },
    provider: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
    meta: { type: 'object', additionalProperties: true },
    errorCode: { type: ['string', 'null'] },
    createdAt: { type: 'integer' },
  },
};

const requestDtoSchema = {
  type: 'object',
  required: ['id', 'conversationId', 'status'],
  properties: {
    id: { type: 'string' },
    conversationId: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'running', 'complete', 'failed', 'interrupted', 'canceled'] },
    errorCode: { type: ['string', 'null'] },
    errorMessage: { type: ['string', 'null'] },
    messageId: { type: ['string', 'null'] },
    createdAt: { type: 'integer' },
    updatedAt: { type: 'integer' },
    finishedAt: { type: ['integer', 'null'] },
  },
};

const ERRORS_401_403 = errorResponses([401, 403, 500]);

function mapServiceError(err: unknown): { statusCode: number; body: { error: string; message: string; code?: string; currentVersion?: number } } {
  // ProviderRequestError carries a safe, pre-scrubbed message (HTTP status
  // included) — surface it as a gateway-class failure, never a raw 500.
  if (err instanceof Error && err.name === 'ProviderRequestError') {
    const code = (err as { code?: string }).code ?? 'provider_error';
    return { statusCode: 502, body: { error: 'Bad Gateway', message: err.message, code } };
  }
  if (err instanceof AiChatError) {
    return { statusCode: err.statusCode, body: { error: err.statusCode === 404 ? 'Not Found' : err.statusCode === 401 ? 'Unauthorized' : 'Bad Request', message: err.message, code: err.code } };
  }
  if (err instanceof AiConfigError) {
    return { statusCode: err.statusCode, body: { error: 'Bad Request', message: err.message, code: err.code } };
  }
  if (err instanceof ProposalError) {
    return {
      statusCode: err.statusCode,
      body: { error: 'Bad Request', message: err.message, code: err.code, ...(err.currentVersion !== undefined ? { currentVersion: err.currentVersion } : {}) },
    };
  }
  if (err instanceof Error && (err as { statusCode?: number }).statusCode) {
    const statusCode = (err as { statusCode?: number }).statusCode ?? 400;
    return { statusCode, body: { error: statusCode === 404 ? 'Not Found' : statusCode === 403 ? 'Forbidden' : 'Bad Request', message: err.message } };
  }
  return { statusCode: 500, body: { error: 'Internal Server Error', message: 'The AI request failed.' } };
}

export const aiRoutes: FastifyPluginAsync = async (fastify) => {
  // Boot recovery: mark jobs orphaned by a restart as interrupted (accurate
  // retry state, never a fake complete answer).
  try {
    recoverInterruptedRequests(fastify.dbCtx);
  } catch (err) {
    fastify.log.warn(err, 'AI request recovery failed');
  }

  const authenticated = { preHandler: [fastify.authenticate] };

  // =========================================================================
  // Provider configurations (BYOK)
  // =========================================================================

  fastify.get('/providers', {
    ...authenticated,
    schema: {
      ...aiMeta(
        'List AI provider configurations',
        "Returns only the signed-in user's configurations. API keys are encrypted at rest and are NEVER included — only a masked last-4 fragment.",
        {
          code: 200,
          schema: {
            type: 'object',
            required: ['configs', 'vault'],
            properties: {
              configs: { type: 'array', items: maskedConfigSchema },
              vault: { type: 'object', required: ['configured'], properties: { configured: { type: 'boolean' }, hint: { type: 'string' } } },
            },
          },
          description: 'Provider configurations (masked keys).',
        }
      ),
    },
  }, async (request) => {
    return { configs: listConfigs(fastify.dbCtx, request.user!.id), vault: vaultStatus() };
  });

  fastify.post('/providers', {
    ...authenticated,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['provider', 'modelId', 'apiKey'],
        properties: {
          provider: { type: 'string', enum: ['openai', 'gemini', 'deepseek', 'nvidia_nim'] },
          label: { type: 'string', maxLength: 80 },
          modelId: { type: 'string', minLength: 1, maxLength: 160 },
          apiKey: { type: 'string', minLength: 8, maxLength: 4096 },
          isDefault: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'Create an AI provider configuration',
        'Stores a user-supplied provider API key encrypted with AES-256-GCM. The key is never returned again — only its masked last-4. Responds 503 while the server has no AI_CREDENTIAL_ENCRYPTION_KEY configured.',
        { code: 201, schema: { type: 'object', required: ['config'], properties: { config: maskedConfigSchema } }, description: 'Created configuration (masked key).' }
      ),
    },
  }, async (request, reply) => {
    try {
      const config = createConfig(fastify.dbCtx, request.user!.id, request.body as Record<string, unknown> as any);
      return reply.status(201).send({ config });
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.patch('/providers/:id', {
    ...authenticated,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      body: {
        type: 'object',
        properties: {
          label: { type: 'string', maxLength: 80 },
          modelId: { type: 'string', maxLength: 160 },
          apiKey: { type: 'string', minLength: 8, maxLength: 4096 },
          isDefault: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'Update an AI provider configuration',
        'Owner-only. Updates label/model, optionally replaces the API key (re-encrypted at rest), or moves the default flag.',
        { code: 200, schema: { type: 'object', required: ['config'], properties: { config: maskedConfigSchema } }, description: 'Updated configuration.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const config = updateConfig(fastify.dbCtx, id, request.user!.id, request.body as Record<string, unknown> as any);
      return { config };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.delete('/providers/:id', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Delete an AI provider configuration',
        'Owner-only. Removes the config and its encrypted key; conversations fall back to another configured provider at send time.',
        { code: 200, schema: { type: 'object', required: ['success'], properties: { success: { type: 'boolean', enum: [true] } } }, description: 'Deleted.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      deleteConfig(fastify.dbCtx, id, request.user!.id);
      return { success: true };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.post('/providers/:id/test', {
    ...authenticated,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Test an AI provider connection',
        'Server-side minimal round trip to the provider. Error messages are scrubbed of key material; the API key is never exposed.',
        { code: 200, schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, message: { type: 'string' }, latencyMs: { type: 'integer' } } }, description: 'Test result (no key material).' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const row = getOwnedConfigRow(fastify.dbCtx, id, request.user!.id);
      const adapter = getAdapter(row.provider);
      if (!adapter) throw new AiConfigError('invalid_provider', 'Unknown provider');
      const apiKey = decryptConfigKey(fastify.dbCtx, row, request.user!.id);
      const result = await adapter.testConnection({ modelId: row.model_id, apiKey });
      // Never echo the key or raw headers; messages are scrubbed server-side.
      return { ok: result.ok, message: scrubKeyMaterial(result.message), latencyMs: result.latencyMs };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.get('/providers/:id/models', {
    ...authenticated,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'List models for a provider configuration',
        'Provider model capability choices fetched server-side with the stored key; safe fallback to manual entry when the provider does not support listing.',
        { code: 200, schema: { type: 'object', required: ['models', 'manualEntryOnly'], properties: { models: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, supportsTools: { type: 'boolean' }, supportsStreaming: { type: 'boolean' } } } }, manualEntryOnly: { type: 'boolean' } } }, description: 'Model list.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const row = getOwnedConfigRow(fastify.dbCtx, id, request.user!.id);
      const adapter = getAdapter(row.provider);
      if (!adapter || !adapter.supportsModelListing) {
        return { models: [], manualEntryOnly: true };
      }
      const apiKey = decryptConfigKey(fastify.dbCtx, row, request.user!.id);
      const models = await adapter.listModels({ modelId: row.model_id, apiKey });
      return { models, manualEntryOnly: false };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  /**
   * Model catalog for the model dropdown. Works in three ways:
   *  - apiKey supplied  -> the key is used ONCE in memory (never persisted);
   *  - no key + public catalog (e.g. NVIDIA NIM) -> listed without auth;
   *  - key-required providers without a key -> the adapter call fails with a
   *    safe 401 and the UI falls back to manual entry.
   * The vault is deliberately NOT involved: nothing is stored here.
   */
  fastify.post('/providers/models-preview', {
    ...authenticated,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['provider'],
        properties: {
          provider: { type: 'string', enum: ['openai', 'gemini', 'deepseek', 'nvidia_nim'] },
          apiKey: { type: 'string', minLength: 0, maxLength: 4096 },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'Preview the model catalog for the model dropdown',
        'Fetches the provider model list. With an apiKey it is used once in memory and never stored; public catalogs (e.g. NVIDIA NIM) list without a key. Powers the automatic model dropdown while configuring a provider.',
        { code: 200, schema: { type: 'object', required: ['models', 'manualEntryOnly'], properties: { models: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, supportsTools: { type: 'boolean' }, supportsStreaming: { type: 'boolean' } } } }, manualEntryOnly: { type: 'boolean' } } }, description: 'Model list for the dropdown.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { provider, apiKey } = request.body as { provider: string; apiKey?: string };
      const adapter = getAdapter(provider);
      if (!adapter || !adapter.supportsModelListing) {
        return { models: [], manualEntryOnly: true };
      }
      const models = await adapter.listModels({ modelId: '', apiKey: apiKey ?? '' });
      return { models, manualEntryOnly: false };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  // =========================================================================
  // Conversations
  // =========================================================================

  fastify.post('/conversations', {
    ...authenticated,
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: idSchema, title: { type: 'string', maxLength: 120 } },
        additionalProperties: false,
      },
      ...aiMeta(
        'Create an AI conversation',
        'Creates a server-persisted conversation in the given workspace (any member may chat; note writes still require write roles at approval time).',
        { code: 201, schema: { type: 'object', required: ['conversation'], properties: { conversation: conversationDtoSchema } }, description: 'The new conversation.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const body = request.body as { workspaceId: string; title?: string };
      const conversation = createConversation(fastify.dbCtx, request.user!.id, body.workspaceId, body.title);
      return reply.status(201).send({ conversation });
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.get('/conversations', {
    ...authenticated,
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: idSchema, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
        additionalProperties: false,
      },
      ...aiMeta(
        'List AI conversations',
        'Paginated conversation history for the signed-in user in one workspace. Strictly user-scoped and workspace-membership checked.',
        { code: 200, schema: { type: 'object', required: ['conversations', 'total'], properties: { conversations: { type: 'array', items: conversationDtoSchema }, total: { type: 'integer' } } }, description: 'Conversation page.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const query = request.query as { workspaceId: string; page?: number; limit?: number };
      const result = listConversations(fastify.dbCtx, request.user!.id, query.workspaceId, query.page ?? 1, query.limit ?? 20);
      return result;
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.get('/conversations/:id', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      querystring: {
        type: 'object',
        properties: { messagePage: { type: 'integer', minimum: 1 }, messageLimit: { type: 'integer', minimum: 1, maximum: 200 } },
        additionalProperties: false,
      },
      ...aiMeta(
        'Get an AI conversation with messages',
        'Owner-only metadata plus paginated messages.',
        { code: 200, schema: { type: 'object', required: ['conversation', 'messages', 'total'], properties: { conversation: conversationDtoSchema, messages: { type: 'array', items: messageDtoSchema }, total: { type: 'integer' } } }, description: 'Conversation with a message page.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const query = request.query as { messagePage?: number; messageLimit?: number };
      const conversation = getConversation(fastify.dbCtx, id, request.user!.id);
      const messages = listMessages(fastify.dbCtx, id, request.user!.id, query.messagePage ?? 1, query.messageLimit ?? 100);
      return { conversation, ...messages };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.patch('/conversations/:id', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      body: {
        type: 'object',
        properties: { title: { type: 'string', maxLength: 120 }, autoSaveNotes: { type: 'boolean' } },
        additionalProperties: false,
      },
      ...aiMeta(
        'Rename an AI conversation / set auto-save preference',
        'Owner-only. Optionally toggles the auto-save-new-notes preference for this conversation.',
        { code: 200, schema: { type: 'object', required: ['conversation'], properties: { conversation: conversationDtoSchema } }, description: 'Updated conversation.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { title?: string; autoSaveNotes?: boolean };
      const conversation = renameConversation(fastify.dbCtx, id, request.user!.id, body.title ?? 'New chat', body.autoSaveNotes);
      return { conversation };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.delete('/conversations/:id', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Delete an AI conversation',
        'Owner-only. Soft-deletes the conversation and cascades messages/requests; pending proposals are rejected.',
        { code: 200, schema: { type: 'object', required: ['success'], properties: { success: { type: 'boolean', enum: [true] } } }, description: 'Deleted.' }
      ),
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    deleteConversation(fastify.dbCtx, id, request.user!.id);
    return { success: true };
  });

  // =========================================================================
  // Messages (job creation) — POST returns immediately with a request id;
  // generation continues server-side regardless of the UI lifecycle.
  // =========================================================================

  fastify.post('/conversations/:id/messages', {
    ...authenticated,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 32_000 },
          clientMessageId: { type: 'string', maxLength: 64 },
          mode: { type: 'string', enum: ['general', 'note_task', 'search', 'search_read'] },
          currentNoteGrantId: { type: ['string', 'null'], maxLength: 64 },
          searchGrantIds: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 64 } },
          providerConfigId: { type: ['string', 'null'], maxLength: 64 },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'Send a chat message (starts a durable generation job)',
        "Persists the user message and returns 202 immediately with a request id; generation continues server-side even if the chat panel is closed. Idempotent on clientMessageId. Modes: general (no notes), note_task (requires a live current-note grant), search (phrase suggestions only), search_read (requires approved excerpt grants).",
        {
          code: 202,
          schema: { type: 'object', required: ['userMessage', 'request'], properties: { userMessage: messageDtoSchema, request: requestDtoSchema } },
          description: 'Accepted; subscribe to /ai/requests/{id}/events for the reply.',
        }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as {
        content: string;
        clientMessageId?: string;
        mode?: string;
        currentNoteGrantId?: string | null;
        searchGrantIds?: string[];
        providerConfigId?: string | null;
      };
      if (body.mode !== undefined && !CHAT_MODES.includes(body.mode)) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Invalid mode' });
      }
      const result = sendMessage(fastify.dbCtx, {
        conversationId: id,
        userId: request.user!.id,
        content: body.content,
        clientMessageId: body.clientMessageId ?? null,
        mode: (body.mode ?? 'general') as ChatMode,
        currentNoteGrantId: body.currentNoteGrantId ?? null,
        searchGrantIds: body.searchGrantIds ?? [],
        providerConfigId: body.providerConfigId ?? null,
      });
      return reply.status(202).send(result);
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  /** Save conversation as note (explicit user action — no model involvement). */
  fastify.post('/conversations/:id/save-as-note', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Save a conversation as a note',
        'Explicit user action (no model involvement): writes the transcript as a structured note through the ordinary note service. Workspace write roles apply; viewers are rejected.',
        { code: 201, schema: { type: 'object', required: ['memo'], properties: { memo: { type: 'object', required: ['id', 'workspaceId'], properties: { id: { type: 'string' }, title: { type: 'string' }, workspaceId: { type: 'string' } } } } }, description: 'The created note reference.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const conversation = getConversation(fastify.dbCtx, id, request.user!.id);
      // Write-permission check mirrors ordinary note creation (viewers denied).
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, conversation.workspaceId, ['owner', 'admin', 'editor']);
      const messages = listMessages(fastify.dbCtx, id, request.user!.id, 1, 200);
      const transcript = buildTranscriptNote(conversation, messages.messages);
      const memo = createMemo(
        fastify.dbCtx,
        {
          workspaceId: conversation.workspaceId,
          title: transcript.title.slice(0, 200),
          content: transcript.content,
          clientId: `ai-transcript-${id}`.slice(0, 64),
        },
        request.user!.id
      );
      return reply.status(201).send({ memo: { id: memo.id, title: memo.title, workspaceId: memo.workspaceId } });
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  // =========================================================================
  // Requests (durable jobs): status, SSE stream, cancellation
  // =========================================================================

  fastify.get('/requests/:id', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Get AI request status',
        'Recovery/reconciliation endpoint: poll a durable generation job. Returns an accurate status — queued, running, complete, failed, interrupted or canceled — never a fabricated completion.',
        { code: 200, schema: { type: 'object', required: ['request'], properties: { request: requestDtoSchema } }, description: 'The request.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return { request: getRequest(fastify.dbCtx, id, request.user!.id) };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.get('/requests/:id/events', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Stream AI request events (SSE)',
        'Authenticated server-sent events for a generation job: status, delta, tool, proposal, message, error, done. Reconnect with Last-Event-ID; finished requests replay their final state. Closing the chat panel never cancels the job.',
        { code: 200, schema: { type: 'object', properties: {} }, description: 'text/event-stream. Schema intentionally empty — the body is an SSE stream.' }
      ),
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.user!.id;
    const lastEventIdHeader = Number(request.headers['last-event-id'] ?? -1);
    const lastEventId = Number.isFinite(lastEventIdHeader) ? lastEventIdHeader : -1;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(':ok\n\n');

    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const send = (event: string, data: unknown, eventId?: number) => {
      if (closed) return;
      try {
        const idPart = eventId !== undefined && eventId >= 0 ? `id: ${eventId}\n` : '';
        reply.raw.write(`${idPart}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };

    const subscription = subscribeToRequest(id, userId, fastify.dbCtx, (event, data, eventId) => {
      send(event, data, eventId);
    }, lastEventId);

    if (subscription.terminal) {
      reply.raw.end();
      return reply;
    }

    heartbeat = setInterval(() => {
      if (closed) return;
      try { reply.raw.write(':hb\n\n'); } catch { closed = true; }
    }, 15_000);

    request.raw.on('close', () => {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      subscription.unsubscribe();
    });

    return reply;
  });

  fastify.post('/requests/:id/cancel', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Cancel an AI request',
        'Owner-only cooperative cancellation: aborts the provider stream at the next step and marks the job canceled.',
        { code: 200, schema: { type: 'object', required: ['request'], properties: { request: requestDtoSchema } }, description: 'The canceled request.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const dto = cancelRequest(fastify.dbCtx, id, request.user!.id);
      return { request: dto };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  // =========================================================================
  // Two-stage AI search
  // =========================================================================

  /** Stage A: private LOCAL search. Results are returned to the browser only. */
  fastify.post('/search', {
    ...authenticated,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'query'],
        properties: {
          workspaceId: idSchema,
          query: { type: 'string', minLength: 1, maxLength: 200 },
          phrases: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 120 } },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'AI search — stage A (private local search)',
        "Runs a bounded local SQLite FTS search across the workspace and returns results ONLY to the authorized browser. Results are never placed into any LLM-visible structure; blocked/current_only hits are flagged llmEligible=false.",
        { code: 200, schema: { type: 'object', required: ['hits', 'total', 'page', 'limit', 'executed'], properties: { hits: { type: 'array', items: { type: 'object', required: ['id', 'title', 'llmEligible', 'eligibility'], properties: { id: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' }, updatedAt: { type: 'integer' }, llmEligible: { type: 'boolean' }, eligibility: { type: 'string', enum: ['search_allowed', 'blocked', 'current_only'] }, workspaceId: { type: 'string' } } } }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, executed: { type: 'boolean' } } }, description: 'Local search results for the human UI.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const body = request.body as { workspaceId: string; query: string; phrases?: string[]; page?: number; limit?: number };
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, body.workspaceId);
      const result = searchNotesLocally(fastify.dbCtx, {
        userId: request.user!.id,
        workspaceId: body.workspaceId,
        isMember: true,
        queries: expandQueryLocally(body.query, Array.isArray(body.phrases) ? body.phrases : []),
        page: body.page ?? 1,
        limit: body.limit ?? 25,
      });
      return result;
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  /** Stage B step 1: build redacted previews for user-selected notes. */
  fastify.post('/search/preview', {
    ...authenticated,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'memoIds'],
        properties: {
          workspaceId: idSchema,
          memoIds: { type: 'array', minItems: 1, maxItems: 10, items: idSchema },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'AI search — stage B step 1 (redacted reading previews)',
        'Builds bounded, redacted previews for the user-selected notes. Only search_allowed notes are previewable; everything else is rejected with a reason shown to the user.',
        { code: 200, schema: { type: 'object', required: ['previews', 'rejected'], properties: { previews: { type: 'array', items: { type: 'object', required: ['memoId', 'excerpt'], properties: { memoId: { type: 'string' }, version: { type: 'integer' }, title: { type: 'string' }, excerpt: { type: 'string' }, truncated: { type: 'boolean' }, redactedBytes: { type: 'integer' } } } }, rejected: { type: 'array', items: { type: 'object', required: ['memoId', 'reason'], properties: { memoId: { type: 'string' }, reason: { type: 'string' } } } }, previewToken: { type: ['string', 'null'] } } }, description: 'Redacted previews for the user to review.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const body = request.body as { workspaceId: string; memoIds: string[] };
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, body.workspaceId);
      const { prepareNoteForProvider } = await import('../services/ai/privacy.service.js');
      const previews: Array<Record<string, unknown>> = [];
      const rejected: Array<{ memoId: string; reason: string }> = [];
      for (const memoId of body.memoIds.slice(0, 10)) {
        const policy = getNoteAiAccess(fastify.dbCtx, memoId, body.workspaceId);
        if (policy !== 'search_allowed') {
          rejected.push({ memoId, reason: policy === 'blocked' ? 'blocked' : 'current_only' });
          continue;
        }
        // Synthetic grant ONLY for building the preview — never usable for sending.
        const previewGrant = {
          id: 'preview-only',
          userId: request.user!.id,
          workspaceId: body.workspaceId,
          conversationId: null,
          memoId,
          noteVersion: 0,
          kind: 'preview' as const,
          purpose: 'preview',
          expiresAt: 0,
          revokedAt: null,
        };
        const memoRow = fastify.dbCtx.sqlite.prepare('SELECT version FROM memos WHERE id = ? AND workspace_id = ?').get(memoId, body.workspaceId) as { version: number } | undefined;
        if (!memoRow) {
          rejected.push({ memoId, reason: 'not_found' });
          continue;
        }
        previewGrant.noteVersion = memoRow.version;
        const prepared = prepareNoteForProvider(fastify.dbCtx, { memoId, workspaceId: body.workspaceId, grant: previewGrant, maxChars: 4000 });
        if (prepared.withheld) {
          rejected.push({ memoId, reason: prepared.withheldReason ?? 'withheld' });
          continue;
        }
        previews.push({
          memoId: prepared.memoId,
          version: prepared.version,
          title: prepared.title,
          excerpt: prepared.excerpt,
          truncated: prepared.truncated,
          redactedBytes: prepared.redactedBytes,
        });
      }
      const previewToken = previews.length > 0 ? crypto.randomBytes(24).toString('hex') : null;
      if (previewToken) {
        // Short-lived preview state so approval matches exactly what was reviewed.
        previewRegistry.set(previewToken, {
          userId: request.user!.id,
          workspaceId: body.workspaceId,
          memos: previews.map((p) => ({ memoId: p.memoId as string, version: p.version as number })),
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
      }
      return { previews, rejected, previewToken };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  /** Stage B step 2: approve the reviewed selection -> short-lived reading grants. */
  fastify.post('/search/approve', {
    ...authenticated,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'conversationId', 'previewToken', 'memoIds'],
        properties: {
          workspaceId: idSchema,
          conversationId: idSchema,
          previewToken: { type: 'string', minLength: 16, maxLength: 128 },
          memoIds: { type: 'array', minItems: 1, maxItems: 10, items: idSchema },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'AI search — stage B step 2 (consent grants)',
        'Creates short-lived, selected-notes-only AI reading grants after the user reviewed the preview. The approved set must exactly match the reviewed set; policy changes after preview cause a 409.',
        { code: 200, schema: { type: 'object', required: ['grants'], properties: { grants: { type: 'array', items: { type: 'object', required: ['grantId', 'memoId', 'version'], properties: { grantId: { type: 'string' }, memoId: { type: 'string' }, version: { type: 'integer' } } } } } }, description: 'Consent grants for this task.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const body = request.body as { workspaceId: string; conversationId: string; previewToken: string; memoIds: string[] };
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, body.workspaceId);
      const conversation = getConversation(fastify.dbCtx, body.conversationId, request.user!.id);
      const preview = previewRegistry.get(body.previewToken);
      if (!preview || preview.userId !== request.user!.id || preview.workspaceId !== body.workspaceId || preview.expiresAt < Date.now()) {
        return reply.status(409).send({ error: 'Conflict', message: 'Preview expired — review the notes again.', code: 'preview_expired' });
      }
      // The approved set must exactly match the reviewed set (no additions).
      const reviewedIds = preview.memos.map((m) => m.memoId).sort().join(',');
      const requestedIds = [...body.memoIds].sort().join(',');
      if (reviewedIds !== requestedIds) {
        return reply.status(409).send({ error: 'Conflict', message: 'Selection changed since preview — review the notes again.', code: 'selection_changed' });
      }
      const grants: Array<{ grantId: string; memoId: string; version: number }> = [];
      for (const reviewed of preview.memos) {
        const policy = getNoteAiAccess(fastify.dbCtx, reviewed.memoId, body.workspaceId);
        if (policy !== 'search_allowed') {
          return reply.status(409).send({ error: 'Conflict', message: 'A selected note is no longer eligible for AI reading.', code: 'policy_changed' });
        }
        const grant = createGrant(fastify.dbCtx, {
          userId: request.user!.id,
          workspaceId: body.workspaceId,
          conversationId: conversation.id,
          memoId: reviewed.memoId,
          kind: 'search_excerpts',
          purpose: 'ai_search_reading',
          ttlMs: 10 * 60 * 1000,
        });
        grants.push({ grantId: grant.id, memoId: grant.memoId, version: grant.noteVersion });
      }
      previewRegistry.delete(body.previewToken);
      return { grants };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  // =========================================================================
  // Current-note grants + per-note privacy controls
  // =========================================================================

  fastify.post('/current-note/grant', {
    ...authenticated,
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'memoId', 'conversationId'],
        properties: { workspaceId: idSchema, memoId: idSchema, conversationId: idSchema, purpose: { type: 'string', maxLength: 200 } },
        additionalProperties: false,
      },
      ...aiMeta(
        'Issue a current-note AI grant',
        'Explicit user-initiated, short-lived (15 min), task-scoped authorization to read ONE note for one conversation. Blocked notes are refused; membership and conversation ownership are validated server-side.',
        { code: 200, schema: { type: 'object', required: ['grant'], properties: { grant: { type: 'object', required: ['grantId', 'memoId', 'version', 'expiresAt'], properties: { grantId: { type: 'string' }, memoId: { type: 'string' }, version: { type: 'integer' }, expiresAt: { type: 'integer' } } } } }, description: 'The live grant.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const body = request.body as { workspaceId: string; memoId: string; conversationId: string; purpose?: string };
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, body.workspaceId);
      const conversation = getConversation(fastify.dbCtx, body.conversationId, request.user!.id);
      if (conversation.workspaceId !== body.workspaceId) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Conversation belongs to a different workspace' });
      }
      const policy = getNoteAiAccess(fastify.dbCtx, body.memoId, body.workspaceId);
      if (policy === 'blocked') {
        return reply.status(403).send({
          error: 'Forbidden',
          message: 'This note is marked "never share with AI". You can keep chatting generally — the note content will not be sent.',
          code: 'note_blocked',
        });
      }
      const grant = createGrant(fastify.dbCtx, {
        userId: request.user!.id,
        workspaceId: body.workspaceId,
        conversationId: conversation.id,
        memoId: body.memoId,
        kind: 'current_note',
        purpose: (body.purpose ?? 'current_note_assistance').slice(0, 200),
        ttlMs: CURRENT_NOTE_GRANT_TTL_MS,
      });
      return { grant: { grantId: grant.id, memoId: grant.memoId, version: grant.noteVersion, expiresAt: grant.expiresAt } };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  // The browser revokes its task-scoped grant on leaving/switching the
  // editor. This is best-effort client delivery; the 15-minute TTL remains
  // the fail-safe if a device suddenly disconnects.
  fastify.post('/current-note/revoke', {
    ...authenticated,
    config: { rateLimit: { max: 90, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['grantId'],
        properties: { grantId: idSchema },
        additionalProperties: false,
      },
      ...aiMeta(
        'Revoke current-note AI authorization',
        'Revoke a task-scoped grant owned by the authenticated user. This does not reveal whether another user owns the supplied identifier.',
        { code: 200, schema: { type: 'object', required: ['revoked'], properties: { revoked: { type: 'boolean' } } }, description: 'Grant revocation result.' }
      ),
    },
  }, async (request) => {
    const body = request.body as { grantId: string };
    return { revoked: revokeGrant(fastify.dbCtx, body.grantId, request.user!.id) };
  });

  fastify.patch('/memos/:id/privacy', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      body: {
        type: 'object',
        required: ['workspaceId', 'aiAccess'],
        properties: { workspaceId: idSchema, aiAccess: { type: 'string', enum: ['blocked', 'current_only', 'search_allowed'] } },
        additionalProperties: false,
      },
      ...aiMeta(
        'Set a note AI privacy policy',
        'Edit-roles-only (viewers rejected). blocked = never shared (also revokes live grants); current_only = default explicit-task sharing; search_allowed = opt-in to cross-note AI search previews.',
        { code: 200, schema: { type: 'object', required: ['memoId', 'aiAccess'], properties: { memoId: { type: 'string' }, aiAccess: { type: 'string', enum: ['blocked', 'current_only', 'search_allowed'] } } }, description: 'The stored policy.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { workspaceId: string; aiAccess: string };
      // Edit authorization: viewers cannot change policy.
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, body.workspaceId, ['owner', 'admin', 'editor']);
      const noteRow = fastify.dbCtx.sqlite.prepare('SELECT id FROM memos WHERE id = ? AND workspace_id = ?').get(id, body.workspaceId);
      if (!noteRow) {
        return reply.status(404).send({ error: 'Not Found', message: 'Note not found' });
      }
      if (!isAiAccessState(body.aiAccess)) {
        return reply.status(400).send({ error: 'Bad Request', message: 'Invalid AI access state' });
      }
      setNoteAiAccess(fastify.dbCtx, id, body.workspaceId, body.aiAccess);
      if (body.aiAccess !== 'search_allowed') {
        // Downgrading search_allowed -> current_only must revoke search grants;
        // revoke all existing grants rather than risk stale permission reuse.
        const revoked = revokeGrantsForMemo(fastify.dbCtx, id);
        if (revoked > 0) {
          const { audit } = await import('../services/ai/privacy.service.js');
          audit(fastify.dbCtx, request.user!.id, body.workspaceId, 'revoke', id, null, 0);
        }
      }
      return { memoId: id, aiAccess: body.aiAccess };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.put('/memos/:id/protected-sections', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      body: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: idSchema,
          add: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 3, maxLength: 20_000 } },
          removeSectionIds: { type: 'array', maxItems: 50, items: idSchema },
        },
        additionalProperties: false,
      },
      ...aiMeta(
        'Manage protected passages of a note',
        'Edit-roles-only. Adds "never share with AI" passages (stored as salted hashes bound to the note version — the text itself is never persisted) or removes existing ones.',
        { code: 200, schema: { type: 'object', required: ['sections'], properties: { sections: { type: 'array', items: { type: 'object', required: ['id', 'noteVersion', 'passageLength', 'createdAt'], properties: { id: { type: 'string' }, noteVersion: { type: 'integer' }, passageLength: { type: 'integer' }, createdAt: { type: 'integer' } } } } } }, description: 'The stored protections (hashes only, no passage text).' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { workspaceId: string; add?: string[]; removeSectionIds?: string[] };
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, body.workspaceId, ['owner', 'admin', 'editor']);
      if (body.add && body.add.length > 0) {
        addProtectedSections(fastify.dbCtx, id, body.workspaceId, body.add, request.user!.id);
      }
      if (body.removeSectionIds) {
        for (const sectionId of body.removeSectionIds) {
          removeProtectedSection(fastify.dbCtx, id, sectionId, request.user!.id, body.workspaceId);
        }
      }
      const sections = listProtectedSections(fastify.dbCtx, id);
      return { sections: sections.map((s) => ({ id: s.id, noteVersion: s.noteVersion, passageLength: s.passageLength, createdAt: s.createdAt })) };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.get('/memos/:id/protected-sections', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      querystring: { type: 'object', required: ['workspaceId'], properties: { workspaceId: idSchema }, additionalProperties: false },
      ...aiMeta(
        'List protected passages and AI policy of a note',
        'Workspace-membership checked. Returns protection metadata (no passage text) and the current AI access policy.',
        { code: 200, schema: { type: 'object', required: ['sections', 'aiAccess'], properties: { sections: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, noteVersion: { type: 'integer' }, passageLength: { type: 'integer' }, createdAt: { type: 'integer' } } } }, aiAccess: { type: 'string', enum: ['blocked', 'current_only', 'search_allowed'] } } }, description: 'Protections and policy.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { workspaceId } = request.query as { workspaceId: string };
      verifyWorkspaceMembership(fastify.dbCtx.db, request.user!.id, workspaceId);
      const sections = listProtectedSections(fastify.dbCtx, id);
      const policy = getNoteAiAccess(fastify.dbCtx, id, workspaceId);
      return { sections: sections.map((s) => ({ id: s.id, noteVersion: s.noteVersion, passageLength: s.passageLength, createdAt: s.createdAt })), aiAccess: policy };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  // =========================================================================
  // Proposals
  // =========================================================================

  fastify.get('/proposals/:id', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Get an AI action proposal',
        'Owner-only view of a drafted note create/update with its validation status and remaining TTL.',
        { code: 200, schema: { type: 'object', required: ['proposal'], properties: { proposal: { type: 'object', additionalProperties: true } } }, description: 'The proposal.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const proposal = getProposal(fastify.dbCtx, id);
      if (!proposal || proposal.userId !== request.user!.id) {
        return reply.status(404).send({ error: 'Not Found', message: 'Proposal not found' });
      }
      return { proposal: { ...proposal, expiresInSeconds: Math.max(0, Math.floor((proposal.expiresAt - Date.now()) / 1000)), ttlMs: PROPOSAL_TTL_MS } };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.post('/proposals/:id/approve', {
    ...authenticated,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Approve and execute an AI action proposal (exactly once)',
        'Transactional one-time execution through the existing note service with workspace write-role and optimistic-version checks. Replay returns the original result; a version conflict marks the proposal conflict and writes nothing.',
        { code: 200, schema: { type: 'object', required: ['memo'], properties: { memo: { type: ['object', 'null'], properties: { id: { type: 'string' }, title: { type: 'string' }, workspaceId: { type: 'string' } } }, conflict: { type: ['object', 'null'], properties: { currentVersion: { type: 'integer' } } } } }, description: 'The created/updated note, or conflict info.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const result = approveProposal(fastify.dbCtx, id, request.user!.id);
      return { memo: result.memo, conflict: result.conflict ?? null };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });

  fastify.post('/proposals/:id/reject', {
    ...authenticated,
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: idSchema }, additionalProperties: false },
      ...aiMeta(
        'Reject an AI action proposal',
        'Owner-only. Marks the proposal rejected; no note write ever happens.',
        { code: 200, schema: { type: 'object', required: ['proposal'], properties: { proposal: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string' } } } } }, description: 'The rejected proposal.' }
      ),
    },
  }, async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const proposal = rejectProposal(fastify.dbCtx, id, request.user!.id);
      return { proposal: { id: proposal.id, status: proposal.status } };
    } catch (err) {
      const mapped = mapServiceError(err);
      return reply.status(mapped.statusCode).send(mapped.body);
    }
  });
};

/** In-memory preview registry (single-instance deployments; previews expire in 10 minutes). */
const previewRegistry = new Map<string, {
  userId: string;
  workspaceId: string;
  memos: Array<{ memoId: string; version: number }>;
  expiresAt: number;
}>();

// Periodic cleanup of expired preview tokens.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of previewRegistry) {
    if (entry.expiresAt < now) previewRegistry.delete(token);
  }
}, 60_000).unref();
