/**
 * Server reminders (bell + notifications), invitations, member removal & load-more pagination — User Journey 12.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 12: Server Reminders (bell + notifications), Invitations, Member Removal & Load-More Pagination', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId12 = Date.now();
  const ownerEmail = `owner12_${runId12}@example.com`;

  try {
    // ------------------------------------------------------------------
    // 0. Register owner (batches of API calls below stay under rate limits)
    // ------------------------------------------------------------------
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Owner Twelve');
    await page.fill('#auth-email-input', ownerEmail);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    const wsId = await page.evaluate(async () => (await (await fetch('/api/v1/workspaces', { credentials: 'include' })).json()).workspaces[0].id);

    // ------------------------------------------------------------------
    // 1. Server-side reminder: due note creates a notification + bell badge
    // ------------------------------------------------------------------
    await page.click('#quick-capture-collapsed');
    await page.fill('#quick-capture-title', 'Server Reminder Note');
    await page.fill('#quick-capture-content', 'This reminder is due now.');
    await page.click('#qc-tool-reminder');
    await page.waitForSelector('#keep-popover-reminder', { state: 'visible' });
    // Custom reminder: 1 minute in the past (inside the fresh-due window)
    await page.evaluate(() => {
      const input = document.getElementById('keep-reminder-custom-date');
      const d = new Date(Date.now() - 60_000);
      const pad = (n) => String(n).padStart(2, '0');
      input.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    });
    await page.click('#keep-reminder-save-custom');
    await page.waitForTimeout(400);
    await page.click('#quick-capture-close');
    await page.waitForTimeout(1500);

    // Backend scans every 10s — poll until the notification lands (manual loop;
    // this Playwright build resolves async waitForFunction on the first result)
    let notificationSeen = false;
    for (let i = 0; i < 12 && !notificationSeen; i++) {
      notificationSeen = await page.evaluate(async () => {
        const res = await fetch('/api/v1/notifications', { credentials: 'include' });
        const data = await res.json();
        return (data.notifications || []).some((n) => n.title === 'Server Reminder Note');
      });
      if (!notificationSeen) await page.waitForTimeout(2500);
    }
    assert.ok(notificationSeen, 'Server reminder created a notification for the note owner');

    // Opening the panel triggers a refresh; the badge and list follow
    await page.click('#nav-notifications-btn');
    await page.waitForSelector('#notifications-panel', { state: 'visible' });
    const badgeVisible = await page.waitForFunction(() => document.getElementById('notification-badge-count').style.display !== 'none', null, { timeout: 8000 });
    assert.ok(badgeVisible, 'Bell badge shows the unread count');
    const panelText = await page.textContent('#notifications-panel-list');
    assert.ok(panelText.includes('Server Reminder Note'), 'Notifications panel lists the server reminder');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-12-notifications-panel.png') });

    // Clicking the notification opens the note in the Keep modal and marks it read
    await page.click('.notification-item');
    await page.waitForSelector('#modal-keep-editor.active', { timeout: 5000 });
    assert.ok((await page.inputValue('#keep-modal-title')).includes('Server Reminder Note'), 'Notification click opens the note');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    await page.click('#nav-notifications-btn');
    await page.waitForSelector('#notifications-panel', { state: 'visible' });
    const markedRead = await page.evaluate(async () => {
      const res = await fetch('/api/v1/notifications', { credentials: 'include' });
      const data = await res.json();
      return data.unread === 0;
    });
    assert.ok(markedRead, 'Opening the notification marks it read');
    await page.click('#nav-notifications-btn'); // close panel
    await page.waitForTimeout(300);

    // ------------------------------------------------------------------
    // 2. Invitation flow via the Team modal (copy-link path, SMTP not configured)
    // ------------------------------------------------------------------
    const inviteeEmail = `invitee12_${runId12}@example.com`;
    await page.click('#user-menu-pill');
    await page.click('#dropdown-members-btn');
    await page.waitForSelector('#modal-members.active');
    await page.fill('#invite-email-input', inviteeEmail);
    await page.selectOption('#invite-role-select', 'editor');
    await page.click('#invite-submit-btn');
    await page.waitForTimeout(900);

    const inviteUrl = await page.evaluate(() => {
      const btn = document.querySelector('#invite-alert [data-copy-invite]');
      return btn ? btn.dataset.copyInvite : null;
    });
    assert.ok(inviteUrl && inviteUrl.startsWith(BASE_URL), `Invitation link uses this app's origin: ${inviteUrl}`);

    // Pending invitation appears with copy/revoke actions
    const invitesText = await page.textContent('#workspace-invites-list');
    assert.ok(invitesText.includes(inviteeEmail), 'Pending invitation listed in the modal');
    await page.click('#modal-members-cancel-btn');
    await page.waitForTimeout(300);

    // The invitee follows the link while signed out → prefilled register screen
    const inviteeCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const inviteePage = await inviteeCtx.newPage();
    await inviteePage.goto(inviteUrl);
    await inviteePage.waitForSelector('#auth-invite-banner', { state: 'visible' });
    const bannerText = await inviteePage.textContent('#auth-invite-banner');
    assert.ok(bannerText.includes('invited to join'), `Invite banner shows workspace context: "${bannerText.slice(0, 60)}"`);
    const prefill = await inviteePage.inputValue('#auth-email-input');
    assert.equal(prefill, inviteeEmail, 'Invitee email is prefilled and locked');
    assert.equal(await inviteePage.evaluate(() => document.getElementById('auth-email-input').readOnly), true, 'Invitee email field is read-only');
    await inviteePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-12-invite-register.png') });

    await inviteePage.fill('#auth-name-input', 'Invitee Twelve');
    await inviteePage.fill('#auth-password-input', 'Password123!');
    await inviteePage.fill('#auth-confirm-password-input', 'Password123!');
    await inviteePage.click('#auth-submit-btn');
    await inviteeCtx.addCookies([]); // no-op; cookies are already in this context
    await inviteePage.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // The invitee auto-joined the owner's workspace and can see the shared note
    const joinedWs = await inviteePage.evaluate(async () => {
      const res = await fetch('/api/v1/auth/me', { credentials: 'include' });
      const data = await res.json();
      return { status: res.status, workspaces: data.workspaces, body: data };
    });
    assert.equal(joinedWs.status, 200, `Invitee session is valid after invite registration: ${JSON.stringify(joinedWs.body)}`);
    assert.ok((joinedWs.workspaces || []).some((w) => w.id === wsId), `Invitee automatically joined the workspace (has: ${JSON.stringify(joinedWs.workspaces)})`);
    await inviteeCtx.close();

    // ------------------------------------------------------------------
    // 3. Member removal + role change from the Team modal
    // ------------------------------------------------------------------
    await page.click('#user-menu-pill');
    await page.click('#dropdown-members-btn');
    await page.waitForSelector('#modal-members.active');
    await page.waitForTimeout(600);

    const inviteeUserId = await page.evaluate(async (wsId) => {
      const res = await fetch(`/api/v1/workspaces/${wsId}/members`, { credentials: 'include' });
      const members = (await res.json()).members || [];
      return members.find((m) => m.name === 'Invitee Twelve')?.userId;
    }, wsId);
    assert.ok(inviteeUserId, 'Invitee is listed as a workspace member');

    // Change role via the inline select
    await page.selectOption(`select.member-role-select[data-member-user-id="${inviteeUserId}"]`, 'viewer');
    await page.waitForTimeout(900);
    const roleNow = await page.evaluate(async ({ wsId, inviteeUserId }) => {
      const res = await fetch(`/api/v1/workspaces/${wsId}/members`, { credentials: 'include' });
      return ((await res.json()).members || []).find((m) => m.userId === inviteeUserId)?.role;
    }, { wsId, inviteeUserId });
    assert.equal(roleNow, 'viewer', 'Role changed to viewer from the modal');

    // Remove the member (confirm dialog)
    await page.click(`[data-member-remove="${inviteeUserId}"]`);
    await page.waitForSelector('#modal-confirm.active');
    await page.click('#modal-confirm-ok-btn');
    await page.waitForTimeout(900);
    const removed = await page.evaluate(async ({ wsId, inviteeUserId }) => {
      const res = await fetch(`/api/v1/workspaces/${wsId}/members`, { credentials: 'include' });
      return !(((await res.json()).members || []).some((m) => m.userId === inviteeUserId));
    }, { wsId, inviteeUserId });
    assert.ok(removed, 'Member removed from the workspace');
    await page.click('#modal-members-cancel-btn');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-12-team-modal.png') });

    // ------------------------------------------------------------------
    // 4. Load-more pagination past the 100-note page cap
    // ------------------------------------------------------------------
    await page.evaluate(async ({ wsId }) => {
      // Bulk-create 105 notes through the API (under the global rate limit)
      for (let i = 1; i <= 105; i++) {
        await fetch('/api/v1/memos', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId: wsId, title: `Bulk Note ${String(i).padStart(3, '0')}`, content: `pagination ${i}` }),
        });
      }
    }, { wsId });

    await page.click('#dashboard-refresh-btn');
    await page.waitForTimeout(1500);

    // First page loads 100; the load-more row offers the remaining notes
    const loadedCount1 = await page.evaluate(() => document.querySelectorAll('#memos-grid-container [data-memo-id]').length);
    assert.ok(loadedCount1 >= 100, `First page loaded at least 100 notes (got ${loadedCount1})`);
    const metaText = await page.textContent('#load-more-meta');
    assert.ok(/of 106 notes loaded/.test(metaText), `Load-more meta reports the real total: "${metaText}"`);

    await page.click('#load-more-btn');
    await page.waitForFunction(() => document.getElementById('load-more-row').style.display === 'none', null, { timeout: 10000 });
    const loadedCount2 = await page.evaluate(() => document.querySelectorAll('#memos-grid-container [data-memo-id]').length);
    assert.ok(loadedCount2 >= 106, `All notes loaded after pagination (got ${loadedCount2})`);
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-12-load-more.png') });

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
  }
});

// ==========================================================================
// Journey 13: Account Settings — Export & Google Keep (Takeout) import
// ==========================================================================

/** Build a ZIP archive without dependencies. Supports STORED and DEFLATE
 *  (deflate matches what real Google Takeout archives use). */
