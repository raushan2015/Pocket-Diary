/**
 * Settings Markdown (.md) import — User Journey 14.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 14: Settings Markdown (.md) Import', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId14 = Date.now();
  const fetchMemos = (wsId) => page.evaluate(async (wsId) => {
    const res = await fetch(`/api/v1/memos?workspaceId=${wsId}&limit=100`, { credentials: 'include' });
    return (await res.json()).memos;
  }, wsId);

  try {
    // Register a fresh user with an empty default workspace
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Markdown Migrator');
    await page.fill('#auth-email-input', `md_migrator_${runId14}@example.com`);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    const wsId = await page.evaluate(async () => (await (await fetch('/api/v1/workspaces', { credentials: 'include' })).json()).workspaces[0].id);

    // ------------------------------------------------------------------
    // 1. Loose .md files: frontmatter note, H1-only note, and an empty
    //    file that must be skipped
    // ------------------------------------------------------------------
    const frontmatterMd = [
      '---',
      'title: Q3 Planning',
      'tags: [work, planning]',
      '---',
      '',
      '# Q3 Planning',
      '',
      '## Goals',
      '- Ship the import wizard',
      '- [ ] Review analytics',
      '',
      '```js',
      "console.log('# not a heading');",
      '```',
    ].join('\n');
    const plainMd = [
      '# Team Standup Notes',
      '',
      'Decisions and **next steps**.',
      '',
      '- [x] Ship the wizard',
    ].join('\n');
    const emptyMd = '---\ntitle: Nothing Inside\n---\n';

    await page.click('#user-menu-pill');
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');

    await page.setInputFiles('#settings-import-file-input', [
      { name: 'quarterly-report.md', mimeType: 'text/markdown', buffer: Buffer.from(frontmatterMd, 'utf8') },
      { name: 'standup.md', mimeType: 'text/markdown', buffer: Buffer.from(plainMd, 'utf8') },
      { name: 'empty-note.md', mimeType: 'text/markdown', buffer: Buffer.from(emptyMd, 'utf8') },
    ]);

    const mdPreviewText = await page.waitForFunction(() => {
      const el = document.getElementById('settings-import-preview');
      return el.style.display !== 'none' ? el.textContent : false;
    }, undefined, { timeout: 10000 }).then((h) => h.jsonValue());
    assert.ok(/Markdown import/.test(mdPreviewText), `Preview identifies a Markdown import: "${mdPreviewText}"`);
    assert.ok(/2 note\(s\)/.test(mdPreviewText), `Empty .md file is skipped in the preview count: "${mdPreviewText}"`);
    assert.ok(/2 label\(s\)/.test(mdPreviewText), 'Preview reports frontmatter labels');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-14-md-import-preview.png') });

    await page.click('#settings-import-btn');
    await page.waitForFunction(() => !document.getElementById('modal-profile')?.classList.contains('active'), { timeout: 10000 });

    let memos = await fetchMemos(wsId);
    assert.equal(memos.length, 2, 'Exactly two notes imported (empty file skipped)');

    const q3 = memos.find((m) => m.title === 'Q3 Planning');
    assert.ok(q3, 'Frontmatter title used for the note');
    assert.equal(q3.noteType, 'text', 'Markdown note imported as a text note');
    for (const expected of ['# Q3 Planning', '## Goals', '- [ ] Review analytics', "console.log('# not a heading');"]) {
      assert.ok((q3.content || '').includes(expected), `Full markdown preserved verbatim (${expected})`);
    }
    assert.deepEqual((q3.tags || []).sort(), ['planning', 'work'], 'Frontmatter tags attached to the note');

    const standup = memos.find((m) => m.title === 'Team Standup Notes');
    assert.ok(standup, 'H1 heading used as title when no frontmatter exists');
    assert.ok((standup.content || '').includes('Decisions and **next steps**.'), 'Plain note content preserved verbatim');

    const labelNames = await page.evaluate(async (wsId) => {
      const res = await fetch(`/api/v1/tags?workspaceId=${wsId}`, { credentials: 'include' });
      return (await res.json()).tags.map((t) => t.name);
    }, wsId);
    assert.ok(labelNames.includes('work') && labelNames.includes('planning'), `Frontmatter labels created: ${JSON.stringify(labelNames)}`);

    // The note opens in the Keep editor with its full markdown body
    await page.waitForSelector('.memo-card:has-text("Q3 Planning")');
    const q3Card = page.locator('.memo-card', { hasText: 'Q3 Planning' }).first();
    await q3Card.hover();
    await q3Card.locator('[data-action="quick-edit"]').click();
    await page.waitForSelector('#modal-keep-editor.active', { timeout: 5000 });
    const editorContent = await page.inputValue('#keep-modal-content');
    assert.ok(editorContent.includes('- [ ] Review analytics'), 'Keep editor shows the imported markdown body');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // ------------------------------------------------------------------
    // 2. Mixed selection: a Keep .html note + a .md file → both imported
    // ------------------------------------------------------------------
    const keepHtml = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Groceries</title></head><body>',
      '<ul><li>\u2610 Oat milk</li><li>\u2611 Sourdough</li></ul>',
      '</body></html>',
    ].join('');
    const budgetMd = 'Rent, groceries, and **savings goals** for the quarter.';

    await page.click('#user-menu-pill');
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');
    await page.setInputFiles('#settings-import-file-input', [
      { name: 'Groceries.html', mimeType: 'text/html', buffer: Buffer.from(keepHtml, 'utf8') },
      { name: 'budget.md', mimeType: 'text/markdown', buffer: Buffer.from(budgetMd, 'utf8') },
    ]);

    const mixedPreviewText = await page.waitForFunction(() => {
      const el = document.getElementById('settings-import-preview');
      return el.style.display !== 'none' ? el.textContent : false;
    }, undefined, { timeout: 10000 }).then((h) => h.jsonValue());
    assert.ok(/mixed selection/.test(mixedPreviewText), `Preview identifies a mixed selection: "${mixedPreviewText}"`);
    assert.ok(/2 note\(s\)/.test(mixedPreviewText) && /1 checklist/.test(mixedPreviewText), 'Mixed preview reports note and checklist counts');

    await page.click('#settings-import-btn');
    await page.waitForFunction(() => !document.getElementById('modal-profile')?.classList.contains('active'), { timeout: 10000 });

    memos = await fetchMemos(wsId);
    assert.equal(memos.length, 4, 'Keep checklist and Markdown file both imported');
    const groceries = memos.find((m) => m.title === 'Groceries');
    assert.ok(groceries, 'Keep html note still imported in a mixed selection');
    assert.equal(groceries.noteType, 'checklist', 'Keep checklist stays a native checklist');
    const budget = memos.find((m) => m.title === 'budget');
    assert.ok(budget, 'Markdown file without heading uses the file name as title');
    assert.ok((budget.content || '').includes('savings goals'), 'Markdown content imported');

    // ------------------------------------------------------------------
    // 3. ZIP of Markdown files (deflated entries, like real archives)
    // ------------------------------------------------------------------
    const zippedMd = buildZip([
      ['notes/recipe.md', '# Pancakes\n\n1. Mix flour and oat milk\n2. **Fry** until golden\n'],
      ['notes/readme.md', 'Project notes without a heading.'],
    ], { deflate: true });

    await page.click('#user-menu-pill');
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');
    await page.setInputFiles('#settings-import-file-input', {
      name: 'markdown-notes.zip',
      mimeType: 'application/zip',
      buffer: zippedMd,
    });

    const zipPreviewText = await page.waitForFunction(() => {
      const el = document.getElementById('settings-import-preview');
      return el.style.display !== 'none' ? el.textContent : false;
    }, undefined, { timeout: 10000 }).then((h) => h.jsonValue());
    assert.ok(/Markdown import/.test(zipPreviewText) && /2 note\(s\)/.test(zipPreviewText), `ZIP of .md files recognized: "${zipPreviewText}"`);

    await page.click('#settings-import-btn');
    await page.waitForFunction(() => !document.getElementById('modal-profile')?.classList.contains('active'), { timeout: 10000 });

    memos = await fetchMemos(wsId);
    assert.equal(memos.length, 6, 'Both zipped Markdown files imported');
    const recipe = memos.find((m) => m.title === 'Pancakes');
    assert.ok(recipe, 'Zipped .md title from its H1');
    assert.ok((recipe.content || '').includes('**Fry** until golden'), 'Zipped .md content preserved');
    const readme = memos.find((m) => m.title === 'readme');
    assert.ok(readme, 'Zipped .md without heading uses entry base name as title');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-14-md-import-done.png') });

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
  }
});

// ============================================================================
// Audit Remediation Journeys (MEMO-SAAS-AUDIT.md)
// ===========================================================================
