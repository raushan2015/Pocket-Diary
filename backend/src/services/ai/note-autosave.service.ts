/**
 * Safe, model-independent extraction and local fallback for explicit NEW note
 * creation. Authorization is gated by chat.service, not model text.
 */
import type { AdapterMessage } from './provider-types.js';

export interface NewNoteDraft {
  title: string;
  content: string;
}

/** Parse a structured note produced by a model that does not use tools. */
export function parseStructuredNote(text: string): NewNoteDraft | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const fenced = raw.match(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i);
  const source = fenced ? fenced[1] : raw;
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first < 0 || last <= first || last - first > 220_000) return null;
  let data: unknown;
  try { data = JSON.parse(source.slice(first, last + 1)); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  if (typeof fields.title !== 'string' || typeof fields.content !== 'string') return null;
  const title = fields.title.trim().slice(0, 200);
  const content = fields.content.trim().slice(0, 200_000);
  if (!title || content.length < 25) return null;
  if (/\b(?:cannot|can't|unable to)\b[\s\S]{0,70}\b(?:save|create|access|write)\b/i.test(content)) return null;
  return { title, content };
}

/** Final fallback preserves discussion inside the user's OWN workspace.
 * The messages must already be filtered by the grant/provenance pipeline.
 */
export function conversationNoteFallback(messages: AdapterMessage[], userRequest: string): NewNoteDraft | null {
  const meaningful = messages.filter((msg) => {
    const body = msg.content.trim();
    if (!body || body === userRequest.trim()) return false;
    if (/^\[Tool result:|^\[Authorized note context|^\[User-approved note excerpts/i.test(body)) return false;
    if (msg.role === 'assistant' && /(?:copy (?:the|this)|paste (?:the|this)|can't (?:save|write|access)|cannot (?:save|write|access)|note-creation tool .* not)/i.test(body)) return false;
    return body.length > 12;
  }).slice(-16);
  if (!meaningful.length) return null;
  const sections = meaningful.map((msg) =>
    '## ' + (msg.role === 'user' ? 'Your ideas and requirements' : 'Discussion and suggestions') + '\n\n' + msg.content.trim().slice(0, 12_000) + '\n'
  );
  const content = [
    '# Conversation notes',
    '',
    'The following captures the ideas and plans discussed in Pocket Diary.',
    '',
    ...sections,
  ].join('\n').slice(0, 200_000);
  const headline = meaningful.find((m) => m.role === 'user')?.content
    .replace(/^\s*#+\s*/, '')
    .replace(/[\r\n]+/g, ' ').slice(0, 75).trim();
  return { title: headline ? ('Discussion — ' + headline).slice(0, 200) : 'Notes from our discussion', content };
}
