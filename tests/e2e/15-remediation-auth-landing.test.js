/**
 * Remediation — pricing CTAs, social buttons removal & forgot-password flow (User Journey 15).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

test('User Journey 15: Remediation — Pricing CTAs, Social Buttons Removal & Forgot-Password Flow', async (t) => {
  // Isolated browser for this journey (auto-closed after the test).
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId15 = Date.now();
  try {
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');

    // MOCK-01: pricing CTAs must trigger real navigation
    await page.click('#pricing-free-cta');
    await page.waitForSelector('#view-auth.active', { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.getElementById('auth-title').textContent), 'Create Account', 'Free CTA opens register screen');
    await page.click('#nav-brand-btn'); // brand button returns signed-out visitors to the landing page
    await page.waitForSelector('#view-landing.active', { timeout: 8000 });

    await page.click('#pricing-pro-cta');
    await page.waitForSelector('#view-auth.active', { timeout: 8000 });
    await page.click('#nav-brand-btn');
    await page.waitForSelector('#view-landing.active', { timeout: 8000 });

    await page.click('#pricing-enterprise-cta');
    await page.waitForTimeout(700);
    const resourcesVisible = await page.evaluate(() => {
      const el = document.getElementById('resources');
      const rect = el.getBoundingClientRect();
      return rect.top < window.innerHeight && rect.bottom > 0;
    });
    assert.ok(resourcesVisible, 'Enterprise CTA scrolls to the resources section');

    // MOCK-04: social OAuth buttons are removed from the auth screen
    await page.click('#nav-login-btn');
    await page.waitForSelector('#view-auth.active');
    const socialCount = await page.evaluate(() => document.querySelectorAll('.social-auth-btn, .auth-social-row, .auth-divider').length);
    assert.equal(socialCount, 0, 'No OAuth placeholder buttons or divider remain');

    // MOCK-03: forgot-password presents the real recovery flow + self-hosted hint
    await page.click('#auth-forgot-link');
    assert.equal(await page.evaluate(() => document.getElementById('auth-title').textContent), 'Reset Password', 'Forgot link opens recovery mode');
    await page.fill('#auth-email-input', `ghost_${runId15}@example.com`);
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#auth-alert.active', { timeout: 8000 });
    const alertText = await page.textContent('#auth-alert');
    assert.ok(alertText.includes('If an account exists with this email'), 'Recovery response is account-existence agnostic');
    assert.ok(alertText.includes('Email delivery is not configured'), 'Self-hosted SMTP hint is displayed');

    // System telemetry stays access-controlled from the browser (SEC-03):
    // anonymous callers are rejected before the admin check even runs.
    const anonStatus = await page.evaluate(async () => {
      const res = await fetch('/api/v1/system/backup-status', { credentials: 'include' });
      return res.status;
    });
    assert.equal(anonStatus, 401, 'SEC-03: backup telemetry requires authentication');

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
  }
});
