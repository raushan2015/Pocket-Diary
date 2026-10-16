/**
 * Trash upgrade — dedicated Trash view, restore & Empty Trash (User Journey 20).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 20: Trash Upgrade — dedicated Trash view, restore & Empty Trash', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId20 = Date.now();
  const toastText = () => page.evaluate(() => document.getElementById('toast-container')?.textContent || '');

  try {
    // Register a fresh user
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Trash QA');
    await page.fill('#auth-email-input', `trash_${runId20}@example.com`);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // Create three notes via quick capture
    for (const title of ['Trash Note A', 'Trash Note B', 'Trash Note C']) {
      await page.click('#quick-capture-collapsed');
      await page.fill('#quick-capture-title', title);
      await page.fill('#quick-capture-content', `content for ${title}`);
      await page.click('#quick-capture-close');
      await page.waitForSelector(`.memo-card:has-text("${title}")`, { timeout: 10000 });
    }

    // Move all three to the Trash from the card hover toolbar
    for (const title of ['Trash Note A', 'Trash Note B', 'Trash Note C']) {
      const card = page.locator(`.memo-card:has-text("${title}")`).first();
      await card.hover();
      await card.locator('[data-action="trash"]').click();
      // Only count titles that are actually rendered (hidden stale DOM does not count)
      await page.waitForFunction(
        (t) => ![...document.querySelectorAll('.memo-card-title')].some((el) => el.textContent.includes(t) && el.getClientRects().length > 0),
        title,
        { timeout: 8000 }
      );
    }

    // Open the dedicated Trash view
    await page.click('#side-nav-trash');
    await page.waitForSelector('#trash-toolbar', { state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.getElementById('trash-count-text')?.textContent === '3 notes in Trash', undefined, { timeout: 10000 });

    // The Trash is a dedicated destination, not a filter banner
    const bannerVisible = await page.evaluate(() => document.getElementById('active-filter-banner').style.display !== 'none');
    assert.equal(bannerVisible, false, 'Generic filter banner stays hidden — the trash toolbar replaces it');
    const emptyBtnEnabled = await page.evaluate(() => !document.getElementById('empty-trash-btn').disabled);
    assert.ok(emptyBtnEnabled, 'Empty Trash is enabled with items present');

    // Restore one note from the trash grid
    const trashCard = page.locator('.memo-card:has-text("Trash Note B")').first();
    await trashCard.locator('[data-action="restore"]').click();
    await page.waitForFunction(() => document.getElementById('trash-count-text')?.textContent === '2 notes in Trash', undefined, { timeout: 10000 });
    assert.ok((await toastText()).includes('Note restored from Trash'), 'Restore confirms with a toast');

    // Empty the Trash — confirmation dialog guards the permanent delete
    await page.click('#empty-trash-btn');
    await page.waitForSelector('#modal-confirm.active');
    const confirmTitle = await page.textContent('#modal-confirm-title');
    const confirmMsg = await page.textContent('#modal-confirm-msg');
    assert.equal(confirmTitle.trim(), 'Empty Trash', 'Confirm dialog is titled "Empty Trash"');
    assert.ok(confirmMsg.includes('2 note') && confirmMsg.includes('cannot be undone'), `Confirm dialog explains the stakes: "${confirmMsg.trim()}"`);
    await page.click('#modal-confirm-ok-btn');

    await page.waitForFunction(() => document.getElementById('trash-count-text')?.textContent === 'Trash is empty', undefined, { timeout: 10000 });
    assert.ok((await toastText()).includes('Trash emptied — 2 notes permanently deleted'), 'Empty Trash reports the purge count');
    const emptyStateTitle = await page.textContent('#empty-state-title');
    assert.ok(emptyStateTitle.includes('Trash is empty'), 'Empty state renders after purging');
    const emptyBtnAfter = await page.evaluate(() => document.getElementById('empty-trash-btn').disabled);
    assert.equal(emptyBtnAfter, true, 'Empty Trash disables itself on an empty trash');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-20-trash-empty-state.png') });

    // Server-side verification: the two purged notes are gone for good,
    // while the restored one is back in the active stream.
    const wsId = await page.evaluate(async () => (await (await fetch('/api/v1/workspaces', { credentials: 'include' })).json()).workspaces[0].id);
    const totals = await page.evaluate(async (wsId) => {
      const [deletedRes, activeRes] = await Promise.all([
        fetch(`/api/v1/memos?workspaceId=${wsId}&deletedOnly=true&limit=100`, { credentials: 'include' }),
        fetch(`/api/v1/memos?workspaceId=${wsId}&limit=100`, { credentials: 'include' }),
      ]);
      const deleted = await deletedRes.json();
      const active = await activeRes.json();
      return { deletedTotal: deleted.total, activeTitles: active.memos.map((m) => m.title) };
    }, wsId);
    assert.equal(totals.deletedTotal, 0, 'No soft-deleted notes remain after Empty Trash');
    assert.ok(totals.activeTitles.includes('Trash Note B'), 'Restored note is back in the active stream');
    assert.ok(!totals.activeTitles.includes('Trash Note A'), 'Purged notes are permanently gone');

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
  }
});
