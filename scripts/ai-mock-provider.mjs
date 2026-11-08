#!/usr/bin/env node
/**
 * Standalone mock AI provider for end-to-end runs (Pocket Diary AI).
 *
 * Implements the same three wire shapes as the backend test helper:
 *   - POST /v1/responses                       (OpenAI Responses API, SSE)
 *   - POST /chat/completions, /v1/chat/completions (OpenAI-compatible, SSE)
 *   - POST /v1beta/models/:model:streamGenerateContent?alt=sse (Gemini, SSE)
 *   - GET  /models, /v1/models, /v1beta/models (model listings)
 *   - GET  /__recorded                          (introspection for tests)
 *
 * Scripted behavior:
 *   - Default: echoes the user's last message as "MOCK_REPLY:…".
 *   - If the last user message contains "__TOOL__": emits a draft_new_note
 *     function/tool call with a small project-plan payload.
 *   - If the last user message contains "__DENY__": emits a plain refusal text.
 *
 * Start:  node scripts/ai-mock-provider.mjs   (port via MOCK_PROVIDER_PORT, default 9971)
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PROVIDER_PORT ?? 9971);
const recorded = [];

const TOOL_ARGS = JSON.stringify({
  title: 'E-commerce Shop Plan',
  content: [
    '# Overview',
    'From our discussion: an online electronics shop.',
    '',
    '## Requirements',
    '- Next.js storefront',
    '- Stripe checkout',
    '',
    '## Stages',
    '1. Catalog and cart',
    '2. Payments',
    '',
    '## Checklist',
    '- [ ] Register domain',
    '- [ ] Stripe account',
    '',
    '## Open questions',
    '- Which shipping providers?',
  ].join('\n'),
  tags: ['project'],
});

function lastUserText(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return ''; }
  let last = '';
  if (Array.isArray(parsed?.input)) {
    for (const item of parsed.input) {
      if (item?.role === 'user') {
        const content = Array.isArray(item.content) ? item.content : [];
        for (const c of content) if (c?.text) last = c.text;
      }
    }
  } else if (Array.isArray(parsed?.contents)) {
    for (const c of parsed.contents) {
      if (c?.role === 'user') for (const p of c.parts ?? []) if (p?.text) last = p.text;
    }
  } else if (Array.isArray(parsed?.messages)) {
    for (const m of parsed.messages) if (m?.role === 'user') last = String(m.content ?? '');
  }
  return last;
}

function sseChunk(kind, payload) {
  if (kind === 'openai') return `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: payload })}\n\n`;
  if (kind === 'gemini') return `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: payload }] } }] })}\n\n`;
  return `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const url = req.url ?? '';
    recorded.push({ path: url, body, at: Date.now() });

    if (url.startsWith('/__recorded')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ recorded }));
      return;
    }
    if (url.startsWith('/__reset')) {
      recorded.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (url.includes('/v1beta/')) {
        res.end(JSON.stringify({ models: [{ name: 'models/mock-model-a', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] }] }));
      } else {
        res.end(JSON.stringify({ data: [{ id: 'mock-model-a' }, { id: 'mock-model-b' }] }));
      }
      return;
    }

    const isResponses = url.includes('/responses');
    const isGemini = url.includes('streamGenerateContent');
    const kind = isResponses ? 'openai' : isGemini ? 'gemini' : 'compat';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });

    const userText = lastUserText(body);
    // E2E-only search fixture: the assistant can suggest a local phrase,
    // but it never receives a search result or note content in this step.
    if (userText.includes('__SEARCH__')) {
      const name = 'suggest_search_phrases';
      const args = JSON.stringify({ phrases: ['webshop'] });
      if (isResponses) {
        res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_search', call_id: 'call_search_1', name, arguments: '' } })}\n\n`);
        res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_search', delta: args })}\n\n`);
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`);
      } else if (isGemini) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name, args: JSON.parse(args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_search_1', function: { name, arguments: args } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }
    if (userText.includes('__TOOL__')) {
      if (isResponses) {
        res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_e2e_1', name: 'draft_new_note', arguments: '' } })}\n\n`);
        res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: TOOL_ARGS })}\n\n`);
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`);
      } else if (isGemini) {
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { name: 'draft_new_note', args: JSON.parse(TOOL_ARGS) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e2e_1', function: { name: 'draft_new_note', arguments: '' } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: TOOL_ARGS } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }

    const reply = userText.includes('__DENY__')
      ? 'I cannot share that content.'
      : `MOCK_REPLY: ${userText.slice(0, 60)}`;
    for (const part of reply.match(/[\s\S]{1,16}/g) ?? []) {
      res.write(sseChunk(kind, part));
    }
    if (isResponses) {
      res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [], usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`);
    } else if (isGemini) {
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ai-mock-provider] listening on http://127.0.0.1:${PORT}`);
  console.log('[ai-mock-provider] point AI_OPENAI_BASE_URL / AI_DEEPSEEK_BASE_URL at this address.');
});
