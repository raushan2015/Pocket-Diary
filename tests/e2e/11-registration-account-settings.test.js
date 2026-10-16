/**
 * Upgraded registration (strength meter, confirm password) & account settings (avatar, sessions, password change, backup status) — User Journey 11.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 11: Upgraded Registration (strength meter, confirm password) & Account Settings (avatar, sessions, password change, backup status)', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId11 = Date.now();
  const email11 = `settings_${runId11}@example.com`;
  const password11 = 'Password123!';

  try {
    // ------------------------------------------------------------------
    // 1. Register page: confirm password + strength meter + requirements
    // ------------------------------------------------------------------
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.waitForSelector('#auth-name-group', { state: 'visible' });

    // Confirm-password field visible in register mode
    assert.ok(await page.isVisible('#auth-confirm-password-group'), 'Confirm password field is visible in register mode');

    // Mismatched passwords are rejected client-side with a field error
    await page.fill('#auth-name-input', 'Settings Tester');
    await page.fill('#auth-email-input', email11);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Different123!');
    await page.click('#auth-submit-btn');
    await page.waitForTimeout(500);
    assert.ok(await page.isVisible('#auth-confirm-password-error.active'), 'Password mismatch shows a field error');
    assert.equal(await page.evaluate(() => document.getElementById('view-dashboard')?.classList.contains('active')), false, 'Registration blocked on mismatch');

    // Strength meter reacts to typing
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.fill('#auth-password-input', 'weak');
    await page.waitForTimeout(300);
    const weakLabel = await page.textContent('#password-strength-label');
    await page.fill('#auth-password-input', 'Password123!x9!');
    await page.waitForTimeout(300);
    const strongLabel = await page.textContent('#password-strength-label');
    assert.notEqual(weakLabel, strongLabel, `Strength meter reacts (${weakLabel} -> ${strongLabel})`);
    const barsActive = await page.evaluate(() => document.querySelectorAll('#password-strength-bars span.active').length);
    assert.ok(barsActive >= 3, 'Strength bars fill for a strong password');

    // Requirements checklist marks requirements met
    const reqsMet = await page.evaluate(() => document.querySelectorAll('#password-requirements span.met').length);
    assert.equal(reqsMet, 3, 'All password requirements marked met');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-11-register-upgrade.png') });

    // ------------------------------------------------------------------
    // 2. Complete registration
    // ------------------------------------------------------------------
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // ------------------------------------------------------------------
    // 3. Account Settings: avatar, member-since, sessions, backups
    // ------------------------------------------------------------------
    await page.click('#user-menu-pill');
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');

    const avatarText = await page.textContent('#profile-avatar-large');
    assert.equal(avatarText, 'S', 'Avatar shows the user initial');
    const memberSince = await page.textContent('#profile-member-since');
    assert.ok(memberSince.includes('Member since'), `Member-since line present: "${memberSince}"`);

    const sessionText = await page.textContent('#profile-sessions-list');
    assert.ok(sessionText.includes('Current session'), 'Active sessions list shows the current device');

    const backupText = await page.textContent('#profile-backup-status');
    assert.ok(backupText.length > 0, 'Backup status section renders');
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-11-account-settings.png') });

    // ------------------------------------------------------------------
    // 4. Change password with confirmation validation
    // ------------------------------------------------------------------
    await page.fill('#profile-current-pwd-input', password11);
    await page.fill('#profile-new-pwd-input', 'NewPassword456!');
    await page.fill('#profile-confirm-pwd-input', 'Mismatched!');
    await page.click('#modal-profile-submit-btn');
    await page.waitForTimeout(400);
    assert.ok(await page.isVisible('#profile-confirm-pwd-error.active'), 'Password change validates confirmation');

    await page.fill('#profile-confirm-pwd-input', 'NewPassword456!');
    await page.click('#modal-profile-submit-btn');
    await page.waitForTimeout(1000);
    const modalGone = await page.evaluate(() => !document.getElementById('modal-profile').classList.contains('active'));
    assert.ok(modalGone, 'Password change saves and closes the modal');

    // Sign out and sign back in with the NEW password
    await page.click('#user-menu-pill');
    await page.click('#dropdown-logout-btn');
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-login-btn');
    await page.fill('#auth-email-input', email11);
    await page.fill('#auth-password-input', 'NewPassword456!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // ------------------------------------------------------------------
    // 5. Revoke other sessions: create a second session, revoke, verify death
    // ------------------------------------------------------------------
    const secondCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const secondPage = await secondCtx.newPage();
    await secondPage.goto(BASE_URL);
    await secondPage.click('#nav-login-btn');
    await secondPage.fill('#auth-email-input', email11);
    await secondPage.fill('#auth-password-input', 'NewPassword456!');
    await secondPage.click('#auth-submit-btn');
    await secondPage.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // First session's page revokes all others
    await page.click('#user-menu-pill');
    await page.click('#dropdown-profile-btn');
    await page.waitForSelector('#modal-profile.active');
    await page.click('#profile-revoke-sessions-btn');
    await page.waitForTimeout(1000);
    const revokeToast = await page.textContent('#toast-container');
    assert.ok(/Signed out of 1 other session/.test(revokeToast), 'Revoke reports the removed session');
    await page.click('#modal-profile-cancel-btn');

    // The second session is now signed out
    await secondPage.waitForTimeout(600);
    const secondStillAuthed = await secondPage.evaluate(async () => {
      const res = await fetch('/api/v1/auth/me', { credentials: 'include' });
      return res.status === 200;
    });
    assert.equal(secondStillAuthed, false, 'Revoked session no longer authenticates');
    await secondCtx.close();

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
  }
});
