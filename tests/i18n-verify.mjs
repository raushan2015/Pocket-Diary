import { chromium } from 'playwright';

const BASE = 'http://localhost:5000';
const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => consoleErrors.push(String(err)));

// 1. Landing page loads with English (default)
await page.goto(BASE, { waitUntil: 'networkidle' });
check('Landing: hero headline EN', (await page.textContent('.hero-headline')).includes('Your Ideas,'));
check('Landing: Login button EN', (await page.textContent('#nav-login-btn')).trim() === 'Login');
check('Language switcher button exists', await page.isVisible('#language-switcher-btn'));
check('html lang = en', (await page.getAttribute('html', 'lang')) === 'en');

// 2. Open switcher, verify options
await page.click('#language-switcher-btn');
await page.waitForTimeout(200);
check('Panel shows 2 languages', await page.locator('.language-option').count() === 2);
check('Panel shows 日本語', (await page.textContent('#language-switcher-panel')).includes('日本語'));

// 3. Switch to Japanese — no reload
await page.click('.language-option[data-lang="ja"]');
await page.waitForTimeout(300);
check('Landing: hero headline JA', (await page.textContent('.hero-headline')).includes('アイデア'));
check('Landing: Login button JA', (await page.textContent('#nav-login-btn')).trim() === 'ログイン');
check('Landing: CTA JA', (await page.textContent('#hero-get-started-btn')).includes('無料で始める'));
check('html lang = ja', (await page.getAttribute('html', 'lang')) === 'ja');

// 4. Persistence: localStorage + survives reload
const stored = await page.evaluate(() => localStorage.getItem('memo_language'));
check('localStorage memo_language = ja', stored === 'ja');
await page.reload({ waitUntil: 'networkidle' });
check('After reload: Login button still JA', (await page.textContent('#nav-login-btn')).trim() === 'ログイン');

// 5. Auth screen in Japanese
await page.click('#nav-login-btn');
await page.waitForTimeout(400);
check('Auth: title JA', (await page.textContent('#auth-title')).includes('おかえりなさい'));
check('Auth: email label JA', (await page.textContent('label[for="auth-email-input"]')).includes('メールアドレス'));
check('Auth: submit JA', (await page.textContent('#auth-submit-btn .auth-btn-text')).includes('サインイン'));
check('Auth: forgot link JA', (await page.textContent('#auth-forgot-link')).includes('パスワードをお忘れ'));

// 6. Register mode in Japanese
await page.click('#auth-switch-btn');
await page.waitForTimeout(300);
check('Auth register: title JA', (await page.textContent('#auth-title')).includes('アカウント作成'));
check('Auth register: name label JA', (await page.textContent('label[for="auth-name-input"]')).includes('氏名'));

// 7. Register a user (JA UI) and check dashboard + sidebar
await page.fill('#auth-name-input', 'I18n Tester');
await page.fill('#auth-email-input', `ja-test-${Date.now()}@example.com`);
await page.fill('#auth-password-input', 'TestPass123');
await page.fill('#auth-confirm-password-input', 'TestPass123');
await page.click('#auth-submit-btn');
await page.waitForTimeout(2500);
const dashVisible = await page.isVisible('#view-dashboard, .dashboard-content-area').catch(() => false);
check('Registered & dashboard visible', dashVisible);
if (dashVisible) {
  check('Sidebar: Notes JA', (await page.textContent('#side-nav-all span')).trim() === 'ノート');
  check('Sidebar: Reminders JA', (await page.textContent('#side-nav-reminders span')).trim() === 'リマインダー');
  check('Sidebar: Trash JA', (await page.textContent('#side-nav-trash span')).trim() === 'ゴミ箱');
  check('User menu: Sign Out JA', (await page.textContent('#dropdown-logout-btn span')).includes('サインアウト'));
}

// 8. Switch back to English from dashboard
await page.click('#language-switcher-btn');
await page.click('.language-option[data-lang="en"]');
await page.waitForTimeout(300);
check('Switch back: Sidebar Notes EN', (await page.textContent('#side-nav-all span')).trim() === 'Notes');
check('html lang back to en', (await page.getAttribute('html', 'lang')) === 'en');

// 9. Console errors (module load failures etc.)
const realErrors = consoleErrors.filter(e => !e.includes('favicon') && !e.includes('Failed to load resource'));
check('No console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
