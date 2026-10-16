/**
 * Settings export & Google Keep Takeout import — User Journey 13.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 13: Settings Export & Google Keep Takeout Import', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId13 = Date.now();

  try {
    // Register a fresh user
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Keep Migrator');
    await page.fill('#auth-email-input', `migrator_${runId13}@example.com`);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // ------------------------------------------------------------------
    // 1. Build a Google-Takeout-style ZIP with two Keep notes + labels
    // ------------------------------------------------------------------
    const checklistHtml = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Shopping from Keep</title></head><body>',
      '<div>weekly groceries</div>',
      '<ul><li>\u2610 Oat milk</li><li>\u2611 Sourdough bread</li><li>\u2610 Coffee beans</li></ul>',
      '</body></html>',
    ].join('');
    const textNoteHtml = [
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Trip Plans</title></head><body>',
      '<div>Visit Kyoto in April</div><div>Book the ryokan early</div>',
      '</body></html>',
    ].join('');
    const labelsJson = JSON.stringify([{ name: 'groceries' }, { name: 'travel' }]);

    const zipBuffer = buildZip([
      ['Takeout/Keep/Shopping from Keep.html', checklistHtml],
      ['Takeout/Keep/Trip Plans.html', textNoteHtml],
      ['Takeout/Keep/labels.json', labelsJson],
    ], { deflate: true }); // real Takeout archives use DEFLATE — prove the browser path

    // ------------------------------------------------------------------
    // 2. Import via Account Settings
    // ------------------------------------------------------------------
    await page.click('#user-menu-pill');
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');

    await page.setInputFiles('#settings-import-file-input', {
      name: 'takeout-2026.zip',
      mimeType: 'application/zip',
      buffer: zipBuffer,
    });

    const previewText = await page.waitForFunction(() => {
      const el = document.getElementById('settings-import-preview');
      return el.style.display !== 'none' ? el.textContent : false;
    }, undefined, { timeout: 10000 }).then((h) => h.jsonValue());
    assert.ok(/Google Keep export/.test(previewText), `Preview identifies a Keep export: "${previewText}"`);
    assert.ok(/2 note\(s\)/.test(previewText) && /1 checklist/.test(previewText), 'Preview reports note/checklist counts');
    assert.ok(/2 label\(s\)/.test(previewText), 'Preview reports label count');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-13-keep-import-preview.png') });

    const importEnabled = await page.isEnabled('#settings-import-btn');
    assert.ok(importEnabled, 'Import button enables after a valid file is parsed');
    await page.click('#settings-import-btn');
    await page.waitForTimeout(1500);

    // ------------------------------------------------------------------
    // 3. Verify imported notes and labels via the API
    // ------------------------------------------------------------------
    const wsId = await page.evaluate(async () => (await (await fetch('/api/v1/workspaces', { credentials: 'include' })).json()).workspaces[0].id);
    const imported = await page.evaluate(async (wsId) => {
      const res = await fetch(`/api/v1/memos?workspaceId=${wsId}&limit=100`, { credentials: 'include' });
      return (await res.json()).memos;
    }, wsId);

    const checklistNote = imported.find((m) => m.title === 'Shopping from Keep');
    assert.ok(checklistNote, 'Checklist note imported with its Keep title');
    assert.equal(checklistNote.noteType, 'checklist', 'Keep checklist imported as a native checklist');
    assert.equal(checklistNote.checklistData.length, 3, 'All three checklist items imported');
    assert.equal(checklistNote.checklistData[0].text, 'Oat milk', 'Item text cleaned of the ☐ marker');
    assert.equal(checklistNote.checklistData[0].checked, false, 'Unchecked item state preserved');
    assert.equal(checklistNote.checklistData[1].checked, true, 'Checked item state preserved');
    assert.ok((checklistNote.content || '').includes('weekly groceries'), 'Non-checklist text kept as note content');

    const textNote = imported.find((m) => m.title === 'Trip Plans');
    assert.ok(textNote, 'Text note imported');
    assert.equal(textNote.noteType, 'text');
    assert.ok((textNote.content || '').includes('Visit Kyoto in April'), 'Text note content imported');

    const labels = await page.evaluate(async (wsId) => {
      const res = await fetch(`/api/v1/tags?workspaceId=${wsId}`, { credentials: 'include' });
      return (await res.json()).tags.map((t) => t.name);
    }, wsId);
    assert.ok(labels.includes('groceries') && labels.includes('travel'), `Keep labels created: ${JSON.stringify(labels)}`);

    // ------------------------------------------------------------------
    // 4. Export workspace (JSON backup) from the same Settings section
    //    (the app closes Settings after a successful import — reopen it)
    // ------------------------------------------------------------------
    await page.click('#user-menu-pill');
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');
    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.click('#settings-export-btn');
    const download = await downloadPromise;
    assert.ok(/notes-backup-.*\.json/.test(download.suggestedFilename()), `Export download starts: ${download.suggestedFilename()}`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-13-keep-import-done.png') });

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
  }
});

// ==========================================================================
// Journey 14: Account Settings — Markdown (.md) Import
// ==========================================================================
