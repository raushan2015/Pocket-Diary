/**
 * Remediation — whiteboard uploads as attachment, no base64 in content (User Journey 17).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 17: Remediation — Whiteboard Uploads as Attachment (no base64 in content)', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId17 = Date.now();
  try {
    // Register a fresh user and open the editor
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Whiteboard QA');
    await page.fill('#auth-email-input', `whiteboard_${runId17}@example.com`);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    await page.click('#dashboard-new-memo-btn');
    await page.waitForSelector('#view-editor.active', { timeout: 10000 });
    await page.fill('#editor-title-input', 'Whiteboard DATA-01 regression');
    await page.click('#editor-save-btn');
    await page.waitForTimeout(1200);

    // Track the attachment upload triggered by the whiteboard insert
    let attachmentUploadUrl = null;
    page.on('response', async (res) => {
      const url = res.url();
      if (/\/api\/v1\/attachments\/memo\/.+/.test(url) && res.request().method() === 'POST' && res.status() === 201) {
        attachmentUploadUrl = url;
      }
    });

    // Draw several strokes on the whiteboard canvas
    await page.click('#editor-whiteboard-btn');
    await page.waitForSelector('#whiteboard-panel.active');
    const canvas = await page.$('#memo-whiteboard-canvas');
    const box = await canvas.boundingBox();
    for (let stroke = 0; stroke < 5; stroke++) {
      const y = box.y + 40 + stroke * 28;
      await page.mouse.move(box.x + 30, y);
      await page.mouse.down();
      for (let step = 1; step <= 12; step++) {
        await page.mouse.move(box.x + 30 + step * (box.width - 70) / 12, y + (stroke % 2 ? 10 : -10) * Math.sin(step));
      }
      await page.mouse.up();
    }

    await page.click('#whiteboard-insert-btn');
    await page.waitForTimeout(1800); // allow the multipart upload + markdown insert

    // DATA-01: the drawing must be stored as an attachment, not a data URI
    assert.ok(attachmentUploadUrl, 'Whiteboard insert triggers a real attachment upload (POST /api/v1/attachments/memo/:id)');
    const bodyValue = await page.inputValue('#editor-body-textarea');
    assert.ok(/!\[Whiteboard\]\(\/api\/v1\/attachments\/.+\/file\)/.test(bodyValue), 'Markdown references the attachment URL');
    assert.ok(!bodyValue.includes('data:image/png;base64,'), 'No base64 data URI is embedded into the memo content');

    // Autosave after insert must succeed (this is exactly the old failure mode)
    await page.waitForTimeout(1500);
    const saveState = await page.evaluate(() => ({
      indicator: document.getElementById('editor-save-indicator')?.textContent || '',
      dataset: document.getElementById('editor-save-indicator')?.dataset.saveState || '',
    }));
    assert.ok(!/fail|error|too large/i.test(saveState.indicator), `Autosave state after whiteboard insert is healthy: "${saveState.indicator}"`);

    // Reload and confirm the drawing link survived (no data loss)
    await page.reload();
    await page.waitForSelector('#view-editor.active, #view-dashboard.active', { timeout: 15000 });
    const persisted = await page.evaluate(async () => {
      const res = await fetch('/api/v1/memos?workspaceId=' + (await (await fetch('/api/v1/workspaces', { credentials: 'include' })).json()).workspaces[0].id, { credentials: 'include' });
      const memos = (await res.json()).memos;
      const memo = memos.find((m) => m.title === 'Whiteboard DATA-01 regression');
      return memo ? { content: memo.content, attachments: memo.attachments } : null;
    });
    assert.ok(persisted, 'Saved memo is found after reload');
    assert.ok(/!\[Whiteboard\]\(\/api\/v1\/attachments\/.+\/file\)/.test(persisted.content), 'Whiteboard attachment link persisted');
    assert.ok((persisted.attachments || []).length >= 1, 'Drawing is listed as a server attachment');
    assert.ok(!persisted.content.includes('data:image/png;base64,'), 'Persisted content contains no base64 payload');

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
  }
});
