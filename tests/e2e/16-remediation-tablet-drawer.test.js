/**
 * Remediation — tablet drawer (769-1024px), overlay dimming & drawer auto-close (User Journey 16).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 16: Remediation — Tablet Drawer (769–1024px), Overlay Dimming & Drawer Auto-Close', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 900, height: 1100 } });
  const page = await ctx.newPage();
  const runId16 = Date.now();
  try {
    // Register a fresh user so the dashboard has workspace context
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Tablet QA');
    await page.fill('#auth-email-input', `tablet_${runId16}@example.com`);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // UX-01: at 900px the 260px sidebar must collapse off-canvas, not squeeze content
    const sidebarState = await page.evaluate(() => {
      const sidebar = document.getElementById('app-sidebar');
      const style = getComputedStyle(sidebar);
      return { position: style.position, left: style.left, width: style.width };
    });
    assert.equal(sidebarState.position, 'fixed', 'UX-01: tablet sidebar is off-canvas (position: fixed)');
    assert.ok(parseFloat(sidebarState.left) < 0, `UX-01: drawer is hidden to the left (left: ${sidebarState.left})`);

    const toggleVisible = await page.evaluate(() => {
      const btn = document.getElementById('mobile-menu-toggle');
      return btn && getComputedStyle(btn).display !== 'none';
    });
    assert.ok(toggleVisible, 'UX-01: hamburger toggle is visible on tablet viewport');

    // Open the drawer; the overlay must appear above the navbar (UX-02)
    await page.click('#mobile-menu-toggle');
    await page.waitForSelector('#sidebar-overlay.active');
    const overlayZ = await page.evaluate(() => parseInt(getComputedStyle(document.getElementById('sidebar-overlay')).zIndex, 10));
    const navZ = await page.evaluate(() => parseInt(getComputedStyle(document.getElementById('top-navbar')).zIndex, 10));
    const drawerZ = await page.evaluate(() => parseInt(getComputedStyle(document.getElementById('app-sidebar')).zIndex, 10));
    assert.ok(overlayZ > navZ, `UX-02: overlay (${overlayZ}) dims the navbar (${navZ})`);
    assert.ok(drawerZ > overlayZ, `UX-02: drawer (${drawerZ}) sits above its overlay (${overlayZ})`);

    // UX-04: tapping a navigation action inside the drawer closes it
    await page.click('#side-nav-reminders');
    await page.waitForFunction(() => !document.getElementById('sidebar-overlay').classList.contains('active'), { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.getElementById('app-sidebar').classList.contains('open')), false, 'UX-04: drawer auto-closes on navigation click');

    // Drawer also closes when opening a modal-trigger button (Labels manager)
    await page.click('#mobile-menu-toggle');
    await page.waitForSelector('#sidebar-overlay.active');
    await page.click('#sidebar-edit-labels-btn');
    await page.waitForFunction(() => !document.getElementById('sidebar-overlay').classList.contains('active'), { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.getElementById('app-sidebar').classList.contains('open')), false, 'UX-04: drawer closes when a modal trigger is tapped');

    // Close the labels modal before finishing the journey
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  } finally {
    await ctx.close();
  }
});
