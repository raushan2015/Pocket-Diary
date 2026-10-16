/**
 * Remediation — keep modal save serialization & beforeunload protection (User Journey 18).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 18: Remediation — Keep Modal Save Serialization & beforeunload Protection', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const runId18 = Date.now();
  try {
    // Register a fresh user, create a checklist note via quick capture
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Concurrency QA');
    await page.fill('#auth-email-input', `concurrency_${runId18}@example.com`);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // Expand quick capture directly in checklist mode (the toolbar button)
    await page.click('#qc-quick-checklist-btn');
    await page.fill('#quick-capture-title', 'Rapid checklist');
    await page.fill('#qc-checklist-add-input', 'alpha');
    await page.press('#qc-checklist-add-input', 'Enter');
    await page.fill('#qc-checklist-add-input', 'bravo');
    await page.press('#qc-checklist-add-input', 'Enter');
    await page.fill('#qc-checklist-add-input', 'charlie');
    await page.press('#qc-checklist-add-input', 'Enter');
    await page.click('#quick-capture-close');
    await page.waitForTimeout(1500);
    await page.waitForSelector('.memo-card', { timeout: 10000 });

    // Open the Keep modal via the card hover toolbar (established pattern)
    const targetCard = page.locator('.memo-card').first();
    await targetCard.hover();
    await targetCard.locator('[data-action="quick-edit"]').click();
    await page.waitForSelector('#modal-keep-editor.active', { timeout: 8000 });

    const updateRequests = [];
    const conflictResponses = [];
    page.on('response', (res) => {
      if (/\/api\/v1\/memos\/[^/]+$/.test(res.url()) && res.request().method() === 'PATCH') {
        updateRequests.push(res.status());
        if (res.status() === 409) conflictResponses.push(res.url());
      }
    });

    const checkboxes = await page.$$('#keep-modal-checklist-active input[type="checkbox"]');
    assert.ok(checkboxes.length >= 3, `Checklist rendered (${checkboxes.length} items)`);
    // The checklist re-renders after every toggle, so query a fresh handle each time
    for (let i = 0; i < 3; i++) {
      const cb = await page.$('#keep-modal-checklist-active .keep-checklist-item input[type="checkbox"]');
      assert.ok(cb, `Unchecked item ${i} still present for rapid toggling`);
      await cb.click({ force: true });
      await page.waitForTimeout(60);
    }
    await page.fill('#keep-modal-title', 'Rapid checklist — edited under fire');
    await page.waitForTimeout(2200); // let the serialized save chain settle

    const statusText = await page.textContent('#keep-modal-status');
    assert.ok(!/Error/i.test(statusText), `DATA-02: keep modal never enters a stuck error state (status: "${statusText}")`);
    assert.equal(conflictResponses.length, 0, `DATA-02: rapid toggles produce zero 409 conflicts (${updateRequests.join(',')})`);
    assert.ok(updateRequests.length > 0, 'At least one save request was issued');

    // Close the modal — pending edits must flush through the save chain
    await page.click('#keep-modal-close-btn');
    await page.waitForFunction(() => !document.getElementById('modal-keep-editor').classList.contains('active'), { timeout: 5000 });
    await page.waitForTimeout(1000);

    const persistedMemo = await page.evaluate(async () => {
      const ws = (await (await fetch('/api/v1/workspaces', { credentials: 'include' })).json()).workspaces[0];
      const res = await fetch(`/api/v1/memos?workspaceId=${ws.id}&limit=100`, { credentials: 'include' });
      const memos = (await res.json()).memos;
      return memos.find((m) => m.title === 'Rapid checklist — edited under fire') || null;
    });
    assert.ok(persistedMemo, 'Edits typed right before closing the modal were persisted');
    const checked = (persistedMemo.checklistData || []).filter((i) => i.checked).length;
    assert.equal(checked, 3, 'All rapidly toggled checklist items were saved');

    // DATA-03: while unsaved edits exist, the beforeunload guard must engage
    const anyCard = page.locator('.memo-card').first();
    await anyCard.hover();
    await anyCard.locator('[data-action="quick-edit"]').click();
    await page.waitForSelector('#modal-keep-editor.active', { timeout: 8000 });
    await page.fill('#keep-modal-title', 'Rapid checklist — unsaved marker');
    await page.waitForTimeout(300);

    let dialogSeen = false;
    page.once('dialog', async (dialog) => { dialogSeen = true; await dialog.dismiss(); });
    await page.reload({ timeout: 20000 }).catch(() => {});
    assert.ok(dialogSeen, 'DATA-03: browser warns before reloading with pending edits (beforeunload engaged)');
  } finally {
    await ctx.close();
  }
});

// ============================================================================
// Post-audit feature upgrades: Voice typing (EN/JA) & dedicated Trash view
