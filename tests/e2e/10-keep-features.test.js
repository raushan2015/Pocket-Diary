/**
 * Keep features — labels, reminders panel, custom order, view mode, migration preview & profile (User Journey 10).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 10: Keep Features — Labels, Reminders Panel, Custom Order, View Mode, Migration Preview & Profile', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId10 = Date.now();
  const user10 = { name: 'Keep Features QA', email: `keep_${runId10}@example.com`, password: 'Password123!' };

  try {
    // Register fresh user
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', user10.name);
    await page.fill('#auth-email-input', user10.email);
    await page.fill('#auth-password-input', user10.password);
    await page.fill('#auth-confirm-password-input', user10.password);
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // ------------------------------------------------------------------
    // 1. Quick capture: create a note with a label via the labels popover
    // ------------------------------------------------------------------
    console.log('[Test 10] Quick capture with labels...');
    await page.click('#quick-capture-collapsed');
    await page.fill('#quick-capture-title', 'Keep Sweep Labeled Note');
    await page.fill('#quick-capture-content', 'Note created with a label from quick capture.');
    await page.click('#qc-tool-labels');
    await page.waitForSelector('#keep-popover-labels', { state: 'visible' });
    await page.fill('#keep-labels-picker-new-input', 'sweep-label');
    await page.click('#keep-labels-picker-create-btn');
    await page.waitForTimeout(500);
    // Label chip should appear in the composer
    const chipText = await page.textContent('#qc-labels-chips');
    assert.ok(chipText.includes('sweep-label'), 'Label chip appears in quick capture composer');

    // Set a reminder so the Upcoming Reminders panel picks it up (reminderTime, not dueDate)
    await page.click('#qc-tool-reminder');
    await page.waitForSelector('#keep-popover-reminder', { state: 'visible' });
    await page.click('[data-reminder-preset="tomorrow"]');
    await page.waitForTimeout(400);

    await page.click('#quick-capture-close');
    await page.waitForTimeout(1500);

    // Verify note was created WITH the label via API
    const wsId = await page.evaluate(async () => {
      const res = await fetch('/api/v1/workspaces', { credentials: 'include' });
      const data = await res.json();
      return data.workspaces[0].id;
    });
    const created = await page.evaluate(async (wsId) => {
      const res = await fetch(`/api/v1/memos?workspaceId=${wsId}&search=Keep%20Sweep%20Labeled`, { credentials: 'include' });
      const data = await res.json();
      return data.memos?.[0];
    }, wsId);
    assert.ok(created, 'Quick capture note was created');
    assert.ok((created.tags || []).includes('sweep-label'), 'Note persisted with the selected label');
    assert.ok(created.reminderTime, 'Note persisted with a reminderTime');
    assert.equal(created.categoryId, null, 'Quick capture note has no auto-assigned category');

    // Upcoming Reminders panel must include the reminderTime-based note
    const remindersPanel = await page.textContent('#upcoming-reminders-list');
    assert.ok(remindersPanel.includes('Keep Sweep Labeled Note'), 'Upcoming Reminders panel shows reminderTime-based note');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-10-quick-capture-labels.png') });

    // ------------------------------------------------------------------
    // 2. Keep modal: add/remove labels on an existing note
    // ------------------------------------------------------------------
    console.log('[Test 10] Keep modal label editing...');
    const cardLocator = page.locator(`.memo-card[data-memo-id="${created.id}"]`);
    await cardLocator.hover();
    await cardLocator.locator('[data-action="quick-edit"]').click();
    await page.waitForSelector('#modal-keep-editor.active', { timeout: 5000 });
    await page.click('#keep-modal-labels-btn');
    await page.waitForSelector('#keep-popover-labels', { state: 'visible' });
    await page.fill('#keep-labels-picker-new-input', 'modal-added-label');
    await page.click('#keep-labels-picker-create-btn');
    await page.waitForTimeout(700);
    const modalTags = await page.textContent('#keep-modal-tags');
    assert.ok(modalTags.includes('modal-added-label'), 'Keep modal shows newly added label chip');

    // Remove the label via chip × button
    await page.click('[data-keep-tag-remove="modal-added-label"]');
    await page.waitForTimeout(700);
    const modalTagsAfter = await page.textContent('#keep-modal-tags');
    assert.ok(!modalTagsAfter.includes('modal-added-label'), 'Removed label disappears from keep modal');

    // Escape must save and close the keep modal (edits preserved)
    await page.fill('#keep-modal-title', 'Keep Sweep Labeled Note Renamed');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    const modalGone = await page.evaluate(() => !document.getElementById('modal-keep-editor').classList.contains('active'));
    assert.ok(modalGone, 'Escape closes the keep modal');
    const renamed = await page.evaluate(async (memoId) => {
      const res = await fetch(`/api/v1/memos/${memoId}`, { credentials: 'include' });
      const data = await res.json();
      return data.memo;
    }, created.id);
    assert.equal(renamed.title, 'Keep Sweep Labeled Note Renamed', 'Escape-close saved pending edits');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-10-keep-modal-labels.png') });

    // ------------------------------------------------------------------
    // 3. Custom order: drag & drop reorder persists
    // ------------------------------------------------------------------
    console.log('[Test 10] Custom order sorting...');
    // Create two more notes
    for (const title of ['Sweep Note Alpha', 'Sweep Note Beta']) {
      await page.click('#quick-capture-collapsed');
      await page.fill('#quick-capture-title', title);
      await page.click('#quick-capture-close');
      await page.waitForTimeout(1200);
    }
    // Default sort must be Custom order
    const sortValue = await page.inputValue('#sort-memos-select');
    assert.equal(sortValue, 'sortOrder:asc', 'Custom order is the default sort');

    const allMemos = await page.evaluate(async (wsId) => {
      const res = await fetch(`/api/v1/memos?workspaceId=${wsId}`, { credentials: 'include' });
      const data = await res.json();
      return data.memos.map((m) => ({ id: m.id, title: m.title, sortOrder: m.sortOrder }));
    }, wsId);
    assert.ok(allMemos.length >= 3, 'At least three notes exist for reorder test');

    // Simulate drag & drop persistence through the public reorder API used by dnd
    const reorderedIds = [allMemos[2].id, allMemos[1].id, allMemos[0].id];
    await page.evaluate(async ({ wsId, ids }) => {
      const res = await fetch('/api/v1/memos/reorder', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId: wsId, memoIds: ids }),
      });
      return res.ok;
    }, { wsId, ids: reorderedIds });

    await page.click('#side-nav-all');
    await page.waitForTimeout(800);
    const orderAfter = await page.evaluate(async (wsId) => {
      const res = await fetch(`/api/v1/memos?workspaceId=${wsId}&sortBy=sortOrder&sortOrder=asc`, { credentials: 'include' });
      const data = await res.json();
      return data.memos.map((m) => m.id);
    }, wsId);
    assert.deepEqual(orderAfter.slice(0, 3), reorderedIds, 'Custom order persists after drag & drop reorder');

    // ------------------------------------------------------------------
    // 4. View mode persistence (list <-> grid survives reload)
    // ------------------------------------------------------------------
    console.log('[Test 10] View mode persistence...');
    await page.click('#navbar-filter-toggle');
    await page.waitForSelector('#navbar-filter-panel:not([hidden])', { timeout: 5000 });
    await page.click('#view-mode-list-btn');
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });
    const listActive = await page.evaluate(() => document.getElementById('view-mode-list-btn').classList.contains('active'));
    assert.ok(listActive, 'List view preference persists across reload');
    await page.click('#navbar-filter-toggle');
    await page.waitForSelector('#navbar-filter-panel:not([hidden])', { timeout: 5000 });
    await page.click('#view-mode-grid-btn');
    await page.waitForTimeout(300);

    // ------------------------------------------------------------------
    // 5. Migration preview stats render
    // ------------------------------------------------------------------
    console.log('[Test 10] Migration preview stats...');
    await page.click('#sidebar-migration-btn');
    await page.waitForSelector('#modal-migration.active');
    await page.fill('#mig-json-textarea', JSON.stringify([{ title: 'Preview Memo', content: 'x', category: 'Work', tags: ['t1'] }]));
    await page.waitForTimeout(400);
    const previewVisible = await page.evaluate(() => document.getElementById('migration-preview-container').style.display !== 'none');
    assert.ok(previewVisible, 'Migration data preview is visible');
    const statMemos = await page.textContent('#mig-stat-memos');
    assert.equal(statMemos, '1', 'Migration preview counts memos');
    await page.click('#modal-migration-close-btn');
    await page.waitForTimeout(300);

    // ------------------------------------------------------------------
    // 6. Profile modal pre-fills the current user name
    // ------------------------------------------------------------------
    console.log('[Test 10] Profile modal pre-fill...');
    await page.click('#user-menu-pill');
    await page.waitForTimeout(300);
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');
    const profileName = await page.inputValue('#profile-name-input');
    assert.equal(profileName, user10.name, 'Profile settings pre-fills the signed-in user name');
    await page.click('#modal-profile-cancel-btn');
    await page.waitForTimeout(300);

    // ------------------------------------------------------------------
    // 7. No console errors during the journey
    // ------------------------------------------------------------------
    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors during Keep feature journey: ${meaningfulErrors.join(' | ')}`);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-10-keep-features-complete.png') });
    console.log('[Test 10] Captured qa-10-keep-features-complete.png');
  } finally {
    await ctx.close();
  }
});
