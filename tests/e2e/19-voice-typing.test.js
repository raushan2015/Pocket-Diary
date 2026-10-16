/**
 * Voice typing — English/Japanese language picker & live dictation (User Journey 19).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser, buildZip } from './_helpers.js';

// ===========================================================================
test('User Journey 19: Voice Typing — English/Japanese language picker & live dictation', async () => {
  // Dedicated browser instance: the fake media-device flags make the mic
  // permission preflight succeed deterministically in headless Chromium.
  // Fake media-device flags make the mic permission preflight succeed
  // deterministically in headless Chromium.
  const voiceBrowser = await launchBrowser([
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ]);
  const ctx = await voiceBrowser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const runId19 = Date.now();
  const toastText = () => page.evaluate(() => document.getElementById('toast-container')?.textContent || '');

  try {
    // Register a fresh user
    await page.goto(BASE_URL);
    await page.waitForSelector('#view-landing.active');
    await page.click('#nav-register-btn');
    await page.fill('#auth-name-input', 'Voice Typing QA');
    await page.fill('#auth-email-input', `voice_${runId19}@example.com`);
    await page.fill('#auth-password-input', 'Password123!');
    await page.fill('#auth-confirm-password-input', 'Password123!');
    await page.click('#auth-submit-btn');
    await page.waitForSelector('#view-dashboard.active', { timeout: 15000 });

    // Language picker is anchored next to the quick capture mic
    await page.click('#quick-capture-collapsed');
    await page.waitForSelector('#qc-voice-lang-btn', { state: 'visible' });
    await page.click('#qc-voice-lang-btn');
    await page.waitForSelector('#keep-popover-voice-language', { state: 'visible' });

    const options = await page.evaluate(() => [...document.querySelectorAll('#voice-lang-list .voice-lang-option')].map((o) => ({
      lang: o.dataset.voiceLang,
      checked: o.getAttribute('aria-checked'),
    })));
    assert.equal(options.length, 2, 'Both English and Japanese are offered');
    assert.ok(options.some((o) => o.lang === 'en-US' && o.checked === 'true'), 'English is selected by default');
    assert.ok(options.some((o) => o.lang === 'ja-JP'), 'Japanese (ja-JP) is available');

    // Switch to Japanese — persisted per browser, badges update
    await page.click('#voice-lang-list [data-voice-lang="ja-JP"]');
    await page.waitForTimeout(300);
    const afterJapanese = await page.evaluate(() => ({
      stored: localStorage.getItem('memo_voice_lang'),
      qcBadge: document.getElementById('qc-voice-lang-badge')?.textContent,
      modalBadge: document.getElementById('keep-modal-voice-lang-badge')?.textContent,
      popoverHidden: getComputedStyle(document.getElementById('keep-popover-voice-language')).display === 'none',
    }));
    assert.equal(afterJapanese.stored, 'ja-JP', 'Language choice persisted to localStorage');
    assert.equal(afterJapanese.qcBadge, '日', 'Quick capture badge shows Japanese');
    assert.equal(afterJapanese.modalBadge, '日', 'Keep modal badge shows Japanese');
    assert.ok(afterJapanese.popoverHidden, 'Popover closes after selection');

    // Back to English for the dictation test
    await page.click('#qc-voice-lang-btn');
    await page.click('#voice-lang-list [data-voice-lang="en-US"]');
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => localStorage.getItem('memo_voice_lang')), 'en-US');

    // Start dictation: the mic engages and announces the active language
    await page.click('#qc-tool-mic');
    await page.waitForFunction(() => document.getElementById('qc-tool-mic')?.classList.contains('voice-listening'), undefined, { timeout: 8000 });
    assert.ok((await toastText()).includes('Listening in English'), 'Listening toast announces English');

    // Switch language mid-session — the engine restarts with 日本語
    await page.click('#qc-voice-lang-btn');
    await page.click('#voice-lang-list [data-voice-lang="ja-JP"]');
    await page.waitForTimeout(400);
    assert.ok((await toastText()).includes('switched to 日本語'), 'Mid-session switch announces the new language');
    assert.equal(await page.evaluate(() => document.getElementById('qc-tool-mic')?.classList.contains('voice-listening')), true, 'Dictation stays active across the language switch');

    // Stop dictation with a second tap
    await page.click('#qc-tool-mic');
    await page.waitForFunction(() => !document.getElementById('qc-tool-mic')?.classList.contains('voice-listening'), undefined, { timeout: 8000 });
    assert.ok((await toastText()).includes('Voice typing stopped'), 'Stop toast confirms the session ended');

    // The Keep modal exposes the same language picker
    await page.fill('#quick-capture-title', 'Voice notes container');
    await page.fill('#quick-capture-content', 'note for modal voice test');
    await page.click('#quick-capture-close');
    await page.waitForSelector('.memo-card', { timeout: 10000 });
    const card = page.locator('.memo-card').first();
    await card.hover();
    await card.locator('[data-action="quick-edit"]').click();
    await page.waitForSelector('#modal-keep-editor.active');
    await page.click('#keep-modal-voice-lang-btn');
    await page.waitForSelector('#keep-popover-voice-language', { state: 'visible' });
    const modalSelection = await page.evaluate(() => document.querySelector('#voice-lang-list .voice-lang-option.selected')?.dataset.voiceLang);
    assert.equal(modalSelection, 'ja-JP', 'Modal picker reflects the persisted Japanese preference');
    await page.keyboard.press('Escape'); // close modal
    await page.waitForTimeout(250);

    const meaningfulErrors = consoleErrors.filter((e) => !e.includes('favicon') && !e.includes('Failed to load resource'));
    assert.equal(meaningfulErrors.length, 0, `No console errors: ${meaningfulErrors.join(' | ')}`);
  } finally {
    await ctx.close();
    await voiceBrowser.close();
  }
});
