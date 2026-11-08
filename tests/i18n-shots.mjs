import { chromium } from 'playwright';

const BASE = 'http://localhost:5000';
const OUT = '/mnt/user/notes/docs/screenshots';
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });

// English landing with switcher open
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/i18n-landing-english.png` });
await page.click('#language-switcher-btn');
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/i18n-language-switcher.png` });
await page.click('.language-option[data-lang="ja"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/i18n-landing-japanese.png` });

// Japanese auth screen
await page.click('#nav-login-btn');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/i18n-auth-japanese.png` });

await browser.close();
console.log('Screenshots saved');
