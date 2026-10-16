/**
 * Markdown (.md) Import
 * - Converts a Markdown document into an import-ready note: the entire document
 *   body is preserved verbatim as the note content. The app's Markdown engine
 *   renders it (headings, task checkboxes, code blocks, links, images, …).
 * - The note title comes from YAML frontmatter `title`, the first H1 heading,
 *   or the file name — in that order of preference.
 * - A leading YAML frontmatter block is treated as metadata: `title` and `tags`
 *   are applied to the note and the block is removed from the body. Parsing is
 *   strict, so a document that merely starts with "---" keeps its full text.
 * - Pure functions only — no DOM and no imports — so the module also runs
 *   under Node for unit tests.
 */

/** Extensions accepted as Markdown files. */
export function isMarkdownFileName(name) {
  return /\.(md|markdown|mdown|mkd)$/i.test(String(name || ''));
}

function splitLines(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n');
}

function normalizeText(text) {
  return String(text || '').replace(/\r\n?/g, '\n');
}

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

/** Parse an inline tag list: `tags: [work, planning]` or `tags: work, planning`. */
function parseInlineTags(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner.split(',').map((item) => stripQuotes(item)).filter(Boolean);
}

/**
 * Split optional YAML frontmatter from the document body.
 * Returns { meta, body }: meta is null unless the document starts with a valid
 * `---` … `---` (or `...`) block. Any line inside the block that is not blank,
 * a comment, `key: value`, or a list item under an open `tags`/`keywords` key
 * invalidates the whole block, and the document is kept as plain body text.
 */
export function splitFrontmatter(text) {
  const lines = splitLines(text);
  if (lines[0] !== '---') return { meta: null, body: normalizeText(text) };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') { end = i; break; }
  }
  if (end === -1) return { meta: null, body: normalizeText(text) };

  const meta = {};
  let listKey = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { listKey = null; continue; }
    if (trimmed.startsWith('#')) continue; // YAML comment
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && listKey) {
      const value = stripQuotes(listItem[1]);
      if (value) meta[listKey].push(value);
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!kv) return { meta: null, body: normalizeText(text) };
    const key = kv[1].toLowerCase();
    const value = kv[2];
    if (key === 'tags' || key === 'keywords') {
      meta.tags = value ? parseInlineTags(value) : [];
      listKey = 'tags';
    } else {
      meta[key] = stripQuotes(value);
      listKey = null;
    }
  }

  return { meta, body: normalizeText(lines.slice(end + 1).join('\n')) };
}

/**
 * First ATX H1 heading outside fenced code blocks, or null.
 */
export function findFirstH1(body) {
  let inFence = false;
  for (const line of splitLines(body)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) { inFence = !inFence; continue; }
    if (inFence) continue;
    const match = trimmed.match(/^#\s+(.+?)\s*#*\s*$/);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Parse a Markdown document into an import-ready note.
 * The body (after frontmatter) is kept verbatim as the content; the title
 * falls back from frontmatter `title` to the first H1 heading to the file name.
 * Frontmatter `tags`/`keywords` are attached to the note as labels.
 */
export function parseMarkdownNote(text, fallbackTitle) {
  const { meta, body } = splitFrontmatter(text);
  const frontmatterTitle = typeof meta?.title === 'string' ? meta.title.trim() : '';
  const title = frontmatterTitle
    || findFirstH1(body)
    || (fallbackTitle ? String(fallbackTitle).trim() : '')
    || 'Untitled note';
  const tags = (meta?.tags || []).filter(Boolean);
  return {
    title,
    content: body.trim(),
    noteType: 'text',
    ...(tags.length ? { tags } : {}),
  };
}
