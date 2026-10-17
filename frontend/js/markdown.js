/**
 * Memo Manager SaaS - Markdown & Checklist Engine
 * Lightweight, secure Markdown renderer with interactive checklist support
 *
 * Security (audit C-1): inline formatting is tokenized on the RAW text
 * before any HTML escaping, and every token (code span, image, link) builds
 * its attributes with escapeHtml() exactly once. Later passes can only match
 * NUL-delimited placeholders, never the HTML inside tokens, so no regex
 * chain can break out of an attribute. A allow-list sanitizer runs on the
 * final output as defense in depth.
 */

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')
    .replace(/"/g, '&' + 'quot;')
    .replace(/'/g, '&' + '#39;');
}

// ---------------------------------------------------------------------------
// URL allow-lists
// ---------------------------------------------------------------------------

const HTTP_URL = /^https?:\/\/[^\s]+$/i;
const DATA_IMAGE_URL = /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/=\s]+$/i;
/** Bare domain such as `example.com` or `example.com/path` — gets an https:// prefix. */
const BARE_DOMAIN = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[\/?#][^\s]*)?$/i;

function cleanUrlPiece(rawUrl) {
  return String(rawUrl || '')
    .trim()
    .replace(/^<|>$/g, '')
    .replace(/^["']|["']$/g, '');
}

/** Schemes allowed in rendered link href attributes. */
export function safeLinkUrl(rawUrl) {
  const url = cleanUrlPiece(rawUrl);
  if (!url) return null;
  if (HTTP_URL.test(url) || /^mailto:[^\s]+$/i.test(url)) return url;
  if (url.startsWith('#')) return url.length > 1 ? url : null;
  if (url.startsWith('/')) return url; // same-origin absolute path (e.g. /api/...)
  if (BARE_DOMAIN.test(url)) return `https://${url}`;
  return null;
}

/** Schemes allowed in rendered image src attributes. */
export function safeImageUrl(rawUrl) {
  const url = cleanUrlPiece(rawUrl);
  if (!url) return null;
  if (HTTP_URL.test(url)) return url;
  if (/^\/api\//i.test(url)) return url;
  if (/^blob:/i.test(url)) return url;
  if (DATA_IMAGE_URL.test(url)) return url;
  return null;
}

// ---------------------------------------------------------------------------
// Emphasis (applied to already-escaped text)
// ---------------------------------------------------------------------------

/**
 * Bold / italic / strikethrough over escaped text.
 * `_` emphasis only matches at word boundaries so `snake_case_name` and URLs
 * with underscores are left intact (audit C-1 follow-up bugs).
 */
function applyEmphasis(escaped) {
  let result = escaped;

  // Bold & italic: ***text*** or ___text___
  result = result.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  result = result.replace(/(?<![A-Za-z0-9_])___([^_\n]+)___(?![A-Za-z0-9_])/g, '<strong><em>$1</em></strong>');

  // Bold: **text** or __text__ (underscore bold stays word-bounded)
  result = result.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/(?<![A-Za-z0-9_])__([^_\n]+)__(?![A-Za-z0-9_])/g, '<strong>$1</strong>');

  // Italic: *text* or _text_
  result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  result = result.replace(/(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  return result;
}

// ---------------------------------------------------------------------------
// Inline formatting (tokenize -> escape -> emphasize -> substitute)
// ---------------------------------------------------------------------------

/**
 * Formats inline Markdown features (code, images, links, bold, italic, strike).
 *
 * Processing order is the security fix itself:
 *   1. Stash code spans, then images, then links into NUL-delimited
 *      placeholders (stashed HTML is fully escaped at construction time).
 *   2. Escape everything that is left.
 *   3. Apply emphasis to the escaped remainder only.
 *   4. Substitute placeholders back.
 * Later passes therefore never see, and can never mutate, the HTML inside a
 * token — the nested-regex XSS of the previous implementation is impossible.
 */
function formatInline(text = '') {
  // NUL bytes cannot survive here (stripped), so placeholders never collide
  // with user content.
  const src = String(text ?? '').replace(/\u0000/g, '');
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  // 1. Inline code: `code` — stashed first so nothing inside is reprocessed
  let work = src.replace(/`([^`\n]+)`/g, (match, code) =>
    stash(`<code class="md-inline-code">${escapeHtml(code)}</code>`));

  // 2. Images: ![alt](url) — attribute values are escaped at construction
  work = work.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g, (match, altText, imageUrl) => {
    const safe = safeImageUrl(imageUrl);
    if (!safe) return match; // keep unsupported URLs as visible plain text
    return stash(
      `<img src="${escapeHtml(safe)}" alt="${escapeHtml(altText)}" title="${escapeHtml(altText || 'Attached Image')}" loading="lazy" decoding="async" class="md-image" style="max-width:100%;height:auto;border-radius:10px;margin:0.5rem 0;display:block;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.1);" />`
    );
  });

  // 3. Links: [title](url) — title keeps inline emphasis via a one-level pass
  work = work.replace(/(?<!!)\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g, (match, linkTitle, linkUrl) => {
    const safe = safeLinkUrl(linkUrl);
    if (!safe) return match;
    return stash(
      `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer" class="md-link">${applyEmphasis(escapeHtml(linkTitle))}</a>`
    );
  });

  // 4. Escape the remainder, then apply emphasis to it alone
  work = applyEmphasis(escapeHtml(work));

  // 5. Substitute stashed tokens back
  if (tokens.length > 0) {
    work = work.replace(/\u0000(\d+)\u0000/g, (match, idx) => tokens[Number(idx)] ?? '');
  }

  return work;
}

// ---------------------------------------------------------------------------
// Sanitizer (defense in depth over the renderer's own output)
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  'P', 'DIV', 'SPAN', 'BR', 'HR',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
  'EM', 'STRONG', 'S', 'A', 'IMG', 'LABEL', 'INPUT',
]);

function isSafeStyleValue(value) {
  return !/url\(|expression\(|javascript:|<|>|\\/i.test(value)
    && /^(?:[-a-zA-Z]+\s*:\s*[^;{}]*;?\s*)+$/i.test(value);
}

function sanitizeAttributeValue(tag, name, value) {
  const n = name.toLowerCase();
  if (n === 'class') return value;
  if (n === 'style') return isSafeStyleValue(value) ? value : null;
  if (tag === 'A') {
    if (n === 'href') return safeLinkUrl(value) === value ? value : null;
    if (n === 'target') return value === '_blank' ? value : null;
    if (n === 'rel' || n === 'title') return value;
    return null;
  }
  if (tag === 'IMG') {
    if (n === 'src') return safeImageUrl(value) === value ? value : null;
    if (['alt', 'title', 'loading', 'decoding'].includes(n)) return value;
    return null;
  }
  if (tag === 'INPUT') {
    if (n === 'type') return value === 'checkbox' ? value : null;
    if (n === 'data-checklist-idx') return /^\d+$/.test(value) ? value : null;
    if (n === 'checked' || n === 'disabled') return '';
    return null;
  }
  return null;
}

/**
 * Allow-list sanitizer for rendered Markdown HTML. Only known tags and
 * known-safe attributes survive; everything else is unwrapped or dropped.
 * No-ops in environments without DOMParser (e.g. Node unit tests) — the
 * renderer itself is already safe by construction.
 */
export function sanitizeMarkdownHtml(html) {
  if (typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  if (!root) return html;

  const sanitizeElement = (el) => {
    for (const child of Array.from(el.children)) {
      if (ALLOWED_TAGS.has(child.tagName)) {
        for (const attr of Array.from(child.attributes)) {
          const kept = sanitizeAttributeValue(child.tagName, attr.name, attr.value);
          if (kept === null) {
            child.removeAttribute(attr.name);
          } else if (kept !== attr.value) {
            child.setAttribute(attr.name, kept);
          }
        }
        sanitizeElement(child);
      } else {
        const moved = Array.from(child.childNodes);
        child.replaceWith(...moved);
        for (const node of moved) {
          if (node.nodeType === 1) sanitizeElement(node);
        }
      }
    }
  };

  sanitizeElement(root);
  return root.innerHTML;
}

// ---------------------------------------------------------------------------
// Block-level renderer
// ---------------------------------------------------------------------------

/**
 * Parses markdown text into formatted, sanitized HTML
 */
export function renderMarkdown(markdownText = '') {
  if (!markdownText) return '<p class="text-muted" style="color: var(--text-muted); font-style: italic;">No content provided.</p>';

  const lines = String(markdownText).split('\n');
  const htmlLines = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent = [];
  let inList = false;
  let listType = ''; // 'ul' | 'ol'
  let checklistCounter = 0;

  const closeList = () => {
    if (inList) {
      htmlLines.push(`</${listType}>`);
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    // Fenced Code Block: ```lang
    if (rawLine.trim().startsWith('```')) {
      if (inCodeBlock) {
        // End code block
        const codeEscaped = escapeHtml(codeBlockContent.join('\n'));
        htmlLines.push(`<pre class="code-block"><code class="language-${codeBlockLang}">${codeEscaped}</code></pre>`);
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = '';
      } else {
        // Start code block
        closeList();
        inCodeBlock = true;
        codeBlockLang = escapeHtml(rawLine.trim().replace(/^```/, '').trim() || 'plaintext');
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();

    // Empty line closes open lists
    if (!trimmed) {
      closeList();
      htmlLines.push('<div class="md-spacer" style="height: 0.5rem;"></div>');
      continue;
    }

    // Horizontal Rule: --- or ***
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      htmlLines.push('<hr class="md-divider" />');
      continue;
    }

    // Headings: #, ##, ###, ####, #####, ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      const content = formatInline(headingMatch[2]);
      htmlLines.push(`<h${level} class="md-h${level}">${content}</h${level}>`);
      continue;
    }

    // Blockquote: > text
    if (trimmed.startsWith('>')) {
      closeList();
      const quoteText = formatInline(trimmed.replace(/^>\s?/, ''));
      htmlLines.push(`<blockquote class="md-blockquote">${quoteText}</blockquote>`);
      continue;
    }

    // Task Checklist Item: - [ ] or - [x]
    const checklistMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checklistMatch) {
      if (inList && listType !== 'ul') {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }
      if (!inList) {
        htmlLines.push('<ul class="md-checklist">');
        inList = true;
        listType = 'ul';
      }
      const checked = checklistMatch[1].toLowerCase() === 'x';
      const itemText = formatInline(checklistMatch[2]);
      const currentIdx = checklistCounter++;
      htmlLines.push(`
        <li class="md-checklist-item ${checked ? 'completed' : ''}">
          <label class="md-checkbox-label">
            <input type="checkbox" class="md-interactive-checkbox" data-checklist-idx="${currentIdx}" ${checked ? 'checked' : ''}>
            <span>${itemText}</span>
          </label>
        </li>
      `);
      continue;
    }

    // Unordered List: - item or * item
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (inList && listType !== 'ul') {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }
      if (!inList) {
        htmlLines.push('<ul class="md-ul">');
        inList = true;
        listType = 'ul';
      }
      htmlLines.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered List: 1. item
    const olMatch = trimmed.match(/^(\d+)\.\s+(.+)$/);
    if (olMatch) {
      if (inList && listType !== 'ol') {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }
      if (!inList) {
        htmlLines.push('<ol class="md-ol">');
        inList = true;
        listType = 'ol';
      }
      htmlLines.push(`<li>${formatInline(olMatch[2])}</li>`);
      continue;
    }

    // If we reach regular paragraph and a list is open, close it
    closeList();

    // Regular Paragraph
    htmlLines.push(`<p class="md-paragraph">${formatInline(trimmed)}</p>`);
  }

  if (inCodeBlock) {
    const codeEscaped = escapeHtml(codeBlockContent.join('\n'));
    htmlLines.push(`<pre class="code-block"><code class="language-${codeBlockLang}">${codeEscaped}</code></pre>`);
  }

  if (inList) {
    htmlLines.push(`</${listType}>`);
  }

  return sanitizeMarkdownHtml(htmlLines.join('\n'));
}

/**
 * Extracts checklist stats from markdown text
 */
export function extractChecklistStats(markdownText = '') {
  const matches = (markdownText || '').match(/^[-*]\s+\[([ xX])\]\s+/gm);
  if (!matches || matches.length === 0) {
    return null;
  }
  const total = matches.length;
  const completed = matches.filter((m) => m.toLowerCase().includes('[x]')).length;
  const percentage = Math.round((completed / total) * 100);
  return { total, completed, percentage };
}

/**
 * Toggles a checklist item by its occurrence index in the markdown string
 */
export function toggleChecklistItem(markdownText = '', targetIndex = 0) {
  let currentIndex = 0;
  const lines = markdownText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^(\s*[-*]\s+\[)([ xX])(\]\s+.*)$/);
    if (match) {
      if (currentIndex === targetIndex) {
        const isChecked = match[2].toLowerCase() === 'x';
        lines[i] = `${match[1]}${isChecked ? ' ' : 'x'}${match[3]}`;
        break;
      }
      currentIndex++;
    }
  }

  return lines.join('\n');
}
