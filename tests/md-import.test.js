import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Unit tests for the pure Markdown import parser (frontend/js/md-import.js).
 * Run with: npm run test:unit (from the tests directory)
 */
import {
  isMarkdownFileName,
  splitFrontmatter,
  findFirstH1,
  parseMarkdownNote,
} from '../frontend/js/md-import.js';

// ---------------------------------------------------------------------------
// isMarkdownFileName
// ---------------------------------------------------------------------------

test('md-import: recognizes Markdown file extensions', () => {
  assert.equal(isMarkdownFileName('note.md'), true);
  assert.equal(isMarkdownFileName('Note.MD'), true);
  assert.equal(isMarkdownFileName('README.markdown'), true);
  assert.equal(isMarkdownFileName('old.mdown'), true);
  assert.equal(isMarkdownFileName('doc.mkd'), true);
  assert.equal(isMarkdownFileName('note.md.txt'), false, 'must end with the extension');
  assert.equal(isMarkdownFileName('photo.jpeg'), false);
  assert.equal(isMarkdownFileName(''), false);
  assert.equal(isMarkdownFileName(undefined), false);
});

// ---------------------------------------------------------------------------
// findFirstH1
// ---------------------------------------------------------------------------

test('md-import: findFirstH1 returns the first top-level heading', () => {
  assert.equal(findFirstH1('# Team Handbook\n\nWelcome.\n\n## Section'), 'Team Handbook');
  assert.equal(findFirstH1('\n\n#  Padded Title  \nbody'), 'Padded Title', 'leading blanks and extra spaces tolerated');
  assert.equal(findFirstH1('# Closed hashes ###\nbody'), 'Closed hashes', 'closing hashes stripped');
  assert.equal(findFirstH1('## Only H2\nbody'), null, 'H2 is not a title candidate');
  assert.equal(findFirstH1('no heading at all'), null);
});

test('md-import: findFirstH1 ignores headings inside fenced code blocks', () => {
  const body = [
    '```md',
    '# Not a real heading',
    '```',
    '',
    '# Real Heading',
  ].join('\n');
  assert.equal(findFirstH1(body), 'Real Heading');
});

// ---------------------------------------------------------------------------
// splitFrontmatter
// ---------------------------------------------------------------------------

test('md-import: splitFrontmatter extracts title and inline tags', () => {
  const text = [
    '---',
    'title: Q3 Planning',
    'tags: [work, planning]',
    '---',
    '',
    '# Q3 Planning',
    '',
    'Body text.',
  ].join('\n');
  const { meta, body } = splitFrontmatter(text);
  assert.equal(meta.title, 'Q3 Planning');
  assert.deepEqual(meta.tags, ['work', 'planning']);
  assert.ok(body.trim().startsWith('# Q3 Planning'), 'frontmatter block removed from body');
  assert.ok(body.includes('Body text.'));
});

test('md-import: splitFrontmatter supports block-style tag lists and quotes', () => {
  const text = [
    '---',
    'title: "Quoted Title"',
    'tags:',
    '  - "work"',
    "  - 'home'",
    '# a YAML comment is ignored',
    'author: Someone',
    '---',
    'Body',
  ].join('\n');
  const { meta, body } = splitFrontmatter(text);
  assert.equal(meta.title, 'Quoted Title');
  assert.deepEqual(meta.tags, ['work', 'home']);
  assert.equal(meta.author, 'Someone');
  assert.equal(body, 'Body');
});

test('md-import: splitFrontmatter accepts ... as the closing delimiter and single-string tags', () => {
  const text = ['---', 'title: T', 'tags: research', '...', 'Body'].join('\n');
  const { meta, body } = splitFrontmatter(text);
  assert.equal(meta.title, 'T');
  assert.deepEqual(meta.tags, ['research']);
  assert.equal(body, 'Body');
});

test('md-import: documents that merely start with --- are kept intact', () => {
  const text = [
    '---',
    'this is not yaml: it is a sentence, with oddities',
    '***',
    '# Real Title',
  ].join('\n');
  const { meta, body } = splitFrontmatter(text);
  assert.equal(meta, null, 'invalid inner line invalidates the whole block');
  assert.equal(body, text, 'body preserved verbatim');
});

test('md-import: unterminated frontmatter is kept as body', () => {
  const text = '---\ntitle: Never closed\n# content follows';
  const { meta, body } = splitFrontmatter(text);
  assert.equal(meta, null);
  assert.equal(body, text);
});

test('md-import: CRLF line endings are normalized and frontmatter still parsed', () => {
  const text = '---\r\ntitle: Win Doc\r\ntags: [a, b]\r\n---\r\n# Win Doc\r\nBody';
  const { meta, body } = splitFrontmatter(text);
  assert.equal(meta.title, 'Win Doc');
  assert.deepEqual(meta.tags, ['a', 'b']);
  assert.ok(body.startsWith('# Win Doc'));
  assert.ok(!body.includes('\r'), 'carriage returns removed');
});

// ---------------------------------------------------------------------------
// parseMarkdownNote — the behavior the import flow relies on
// ---------------------------------------------------------------------------

test('md-import: note carries the full document body verbatim', () => {
  const doc = [
    '# Meeting Notes',
    '',
    'Decisions and **next steps**.',
    '',
    '- [ ] Follow up with design',
    '- [x] Ship the wizard',
    '',
    '```js',
    "console.log('# not a heading');",
    '```',
    '',
    '> A quote to preserve',
    '',
    '[Link](https://example.com) and an ![image](https://example.com/x.png)',
  ].join('\n');
  const note = parseMarkdownNote(doc, 'meeting-notes');
  assert.equal(note.title, 'Meeting Notes', 'H1 becomes the title');
  assert.equal(note.noteType, 'text');
  assert.equal(note.content, doc, 'content is byte-for-byte the document body');
  assert.equal(note.tags, undefined, 'no tags without frontmatter');
});

test('md-import: title priority is frontmatter → H1 → filename', () => {
  const withFm = ['---', 'title: Frontmatter Wins', '---', '# H1 Present', 'body'].join('\n');
  assert.equal(parseMarkdownNote(withFm, 'file').title, 'Frontmatter Wins');

  const withH1 = '# H1 Wins\nbody';
  assert.equal(parseMarkdownNote(withH1, 'file').title, 'H1 Wins');

  const bare = 'just some text, no heading';
  // Callers pass the file's base name (no path, no extension) as the fallback
  assert.equal(parseMarkdownNote(bare, 'file-name').title, 'file-name');

  assert.equal(parseMarkdownNote('', '').title, 'Untitled note');
});

test('md-import: frontmatter tags attach to the note, other keys are ignored', () => {
  const doc = [
    '---',
    'title: Roadmap',
    'tags: [product, 2026]',
    'draft: true',
    'author: QA',
    '---',
    '',
    '# Roadmap content',
  ].join('\n');
  const note = parseMarkdownNote(doc, 'roadmap');
  assert.equal(note.title, 'Roadmap');
  assert.deepEqual(note.tags, ['product', '2026']);
  assert.ok(note.content.startsWith('# Roadmap content'));
  assert.ok(!note.content.includes('draft'), 'frontmatter stripped from content');
});

test('md-import: empty and whitespace-only documents produce empty content', () => {
  assert.equal(parseMarkdownNote('', 'empty').content, '');
  assert.equal(parseMarkdownNote('   \n\n  \n', 'empty').content, '');
  const fmOnly = ['---', 'title: Only Metadata', '---', ''].join('\n');
  const note = parseMarkdownNote(fmOnly, 'only-meta');
  assert.equal(note.title, 'Only Metadata');
  assert.equal(note.content, '', 'metadata-only file has no note content (skipped by the import)');
});
