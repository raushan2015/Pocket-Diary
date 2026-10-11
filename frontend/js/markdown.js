/**
 * Memo Manager SaaS - Markdown & Checklist Engine
 * Lightweight, secure Markdown renderer with interactive checklist support
 */

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parses markdown text into formatted, sanitized HTML
 */
export function renderMarkdown(markdownText = '') {
  if (!markdownText) return '<p class="text-muted" style="color: var(--text-muted); font-style: italic;">No content provided.</p>';

  const lines = markdownText.split('\n');
  const htmlLines = [];
  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockContent = [];
  let inList = false;
  let listType = ''; // 'ul' | 'ol'
  let checklistCounter = 0;

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
        if (inList) {
          htmlLines.push(`</${listType}>`);
          inList = false;
        }
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
      if (inList) {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }
      htmlLines.push('<div class="md-spacer" style="height: 0.5rem;"></div>');
      continue;
    }

    // Horizontal Rule: --- or ***
    if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      if (inList) {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }
      htmlLines.push('<hr class="md-divider" />');
      continue;
    }

    // Headings: #, ##, ###, ####, #####, ######
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (inList) {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }
      const level = headingMatch[1].length;
      const content = formatInline(headingMatch[2]);
      htmlLines.push(`<h${level} class="md-h${level}">${content}</h${level}>`);
      continue;
    }

    // Blockquote: > text
    if (trimmed.startsWith('>')) {
      if (inList) {
        htmlLines.push(`</${listType}>`);
        inList = false;
      }
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
    if (inList) {
      htmlLines.push(`</${listType}>`);
      inList = false;
    }

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

  return htmlLines.join('\n');
}

/**
 * Formats inline Markdown features (bold, italic, code, strikethrough, links)
 */
function formatInline(text = '') {
  let result = escapeHtml(text);

  // Inline Code: `code`
  result = result.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Bold & Italic: ***text*** or ___text___
  result = result.replace(/(\*\*\*|___)(.+?)\1/g, '<strong><em>$2</em></strong>');

  // Bold: **text** or __text__
  result = result.replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>');

  // Italic: *text* or _text_
  result = result.replace(/(\*|_)(.+?)\1/g, '<em>$2</em>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Images: ![alt](url)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, altText, imageUrl) => {
    const trimmedUrl = imageUrl.trim();
    const isSafe = /^https?:\/\//i.test(trimmedUrl)
      || /^\/api\//i.test(trimmedUrl)
      || /^blob:/i.test(trimmedUrl)
      || /^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(trimmedUrl);
    if (!isSafe) return match;
    return `<img src="${trimmedUrl}" alt="${altText}" title="${altText || 'Attached Image'}" loading="lazy" decoding="async" class="md-image" style="max-width:100%;height:auto;border-radius:10px;margin:0.5rem 0;display:block;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.1);" />`;
  });

  // Links: [title](url). Avoid reprocessing Markdown image syntax.
  result = result.replace(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g, (match, linkTitle, linkUrl) => {
    const safeUrl = linkUrl.startsWith('http://') || linkUrl.startsWith('https://') || linkUrl.startsWith('#')
      ? linkUrl
      : `https://${linkUrl}`;
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="md-link">${linkTitle}</a>`;
  });

  return result;
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
