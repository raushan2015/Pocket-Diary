/**
 * Security regression tests for the Markdown renderer (audit C-1).
 *
 * The previous implementation ran chained regex replacements over escaped
 * HTML, so later passes could match inside attributes produced by earlier
 * passes — a stored XSS via image/link nesting. These tests pin the safe
 * behavior: only renderer-generated tags may appear as real HTML, URLs must
 * pass the scheme allow-list, and rejected input stays visible plain text.
 *
 * Run: npm run test:unit   (from tests/) or node --test markdown-xss.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, safeLinkUrl, safeImageUrl } from '../frontend/js/markdown.js';

/**
 * Only a literal '<' survives escaping, so real tags in the output come
 * solely from the renderer itself. Inspect every real tag: strip quoted
 * attribute values, then reject event-handler attributes and unsafe URLs.
 */
function findDanger(html) {
  const tagRe = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    const stripped = tag.replace(/=\s*("[^"]*"|'[^']*')/g, '=');
    if (/\son[a-zA-Z]+\s*=/i.test(stripped)) return `event-handler attr in ${tag}`;
    const href = tag.match(/href\s*=\s*"([^"]*)"/i);
    if (href && !/^(https?:|mailto:|#|\/)/i.test(href[1])) return `unsafe href "${href[1]}"`;
    const src = tag.match(/src\s*=\s*"([^"]*)"/i);
    if (src && !/^(https?:|\/api\/|blob:|data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,)/i.test(src[1])) return `unsafe src "${src[1]}"`;
  }
  if (/<\s*(script|iframe|object|embed|svg|form)\b/i.test(html)) return 'raw dangerous tag';
  if (/"\s+on[a-zA-Z]+\s*=/i.test(html)) return 'event handler after quoted attr';
  return null;
}

test('audit C-1 payload cannot inject an event handler', () => {
  const payload = '![a](https://x.invalid/[b](http:///onerror=document.title=7//)';
  const html = renderMarkdown(payload);
  const danger = findDanger(html);
  assert.equal(danger, null, `dangerous output: ${danger}\n${html}`);
  // The payload survives as a harmless escaped image URL: the src value is
  // fully quoted and any embedded quote would be entity-escaped, so no
  // attribute breakout is possible.
  assert.ok(html.includes('<img'), 'image still renders');
  assert.ok(html.includes('src="'), 'src must be a quoted attribute');
});

test('renderer never emits event-handler attributes for any known payload', () => {
  const payloads = [
    '![a](https://x.invalid/[b](http:///onerror=alert(1)//)',
    '![x"](https://evil.invalid/a")(https://b)](javascript:alert(1))',
    '[a](javascript:alert(1))',
    '[a](JAVASCRIPT:alert(1))',
    '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '[a](vbscript:msgbox)',
    '![img](javascript:alert(1))',
    '![img"](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
    "![a'](https://evil.invalid/x' onerror=alert(1))",
    '`<img src=x onerror=alert(1)>`',
    '## <img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '[x](https://good.example/")] onerror=alert(1) [("',
    '![alt](https://x.invalid/")onload=alert(1)//',
    '[link](https://x.invalid/") onclick=alert(1) title="t',
  ];
  for (const payload of payloads) {
    const html = renderMarkdown(payload);
    const danger = findDanger(html);
    assert.equal(danger, null, `payload ${payload} -> ${danger}\n${html}`);
  }
});

test('rejected URL schemes render as visible plain text, not links', () => {
  const html = renderMarkdown('[a](javascript:alert(1))');
  assert.ok(!html.includes('<a '), 'no anchor may be generated');
  assert.ok(html.includes('[a](javascript:alert(1))'), 'raw markdown stays visible');
});

test('underscore URLs and snake_case survive emphasis (C-1 collateral bugs)', () => {
  assert.ok(renderMarkdown('[t](https://example.com/my_page_name)').includes('href="https://example.com/my_page_name"'));
  assert.ok(renderMarkdown('![i](https://example.com/a_b.png)').includes('https://example.com/a_b.png'));
  assert.ok(!renderMarkdown('snake_case_name').includes('<em>'));
  assert.ok(renderMarkdown('[t](mailto:a@b.com)').includes('href="mailto:a@b.com"'));
});

test('standard inline formatting still works', () => {
  assert.ok(renderMarkdown('**bold**').includes('<strong>bold</strong>'));
  assert.ok(renderMarkdown('*ital*').includes('<em>ital</em>'));
  assert.ok(renderMarkdown('~~gone~~').includes('<s>gone</s>'));
  assert.ok(renderMarkdown('`code`').includes('<code class="md-inline-code">code</code>'));
  assert.ok(renderMarkdown('- [ ] task').includes('md-checklist'));
  assert.ok(renderMarkdown('# Heading').includes('<h1 class="md-h1">'));
});

test('URL allow-lists reject dangerous schemes', () => {
  assert.equal(safeLinkUrl('javascript:alert(1)'), null);
  assert.equal(safeLinkUrl('data:text/html;base64,PHNjcmlwdD4'), null);
  assert.equal(safeImageUrl('javascript:alert(1)'), null);
  assert.equal(safeImageUrl('data:text/html;base64,PHNjcmlwdD4'), null);
  assert.equal(safeLinkUrl('https://example.com'), 'https://example.com');
  assert.equal(safeLinkUrl('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(safeLinkUrl('example.com'), 'https://example.com');
  assert.equal(safeImageUrl('/api/v1/attachments/x/file'), '/api/v1/attachments/x/file');
  assert.ok(safeImageUrl('data:image/png;base64,iVBORw0KG='));
});
