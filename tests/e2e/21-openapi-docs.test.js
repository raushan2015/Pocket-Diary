/**
 * OpenAPI / Swagger UI documentation (User Journey 21).
 *
 * Verifies the API reference is reachable in production conditions — through
 * the bundled reverse proxy on the public origin — and that the strict CSP
 * the proxy applies to the rest of the app does not break the docs UI or its
 * same-origin assets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser } from './_helpers.js';

test('User Journey 21: OpenAPI docs served at /docs through the reverse proxy', async (t) => {
  const browser = await launchBrowser();
  t.after(() => browser.close());

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  try {
    // 1. The Swagger UI page loads through the proxy (same origin, no auth).
    const response = await page.goto(`${BASE_URL}/docs`, { waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200, 'GET /docs must be served through the proxy');
    await page.waitForSelector('#swagger-ui', { timeout: 15000 });

    // 2. The UI fetched the spec from the same origin and rendered operations.
    await page.waitForSelector('.opblock', { timeout: 15000 });
    const opCount = await page.evaluate(() => document.querySelectorAll('.opblock').length);
    assert.ok(opCount > 40, `expected the full endpoint inventory to render (got ${opCount} operations)`);

    // 3. The endpoint grouping (tags) rendered for the API sections.
    const tagCount = await page.evaluate(() => document.querySelectorAll('.opblock-tag').length);
    assert.ok(tagCount >= 11, `expected all endpoint groups to render (got ${tagCount} tags)`);

    // 4. The session-cookie security scheme is documented.
    const specJson = await page.evaluate(async () => (await (await fetch('/docs/json')).json()));
    assert.equal(specJson.openapi, '3.0.3');
    assert.equal(specJson.components.securitySchemes.sessionCookie.in, 'cookie');
    assert.equal(specJson.components.securitySchemes.sessionCookie.name, 'memo_session');
    assert.ok(Object.keys(specJson.paths).length >= 50, 'spec must document the full API surface');
    // Relative server URL: no internal hostname may leak into the spec.
    assert.deepEqual(specJson.servers, [{ url: '/', description: 'This instance (direct backend or the bundled reverse proxy)' }]);

    // 5. CSP on the docs page allows its same-origin assets (no console errors
    //    from blocked scripts), and the page is served with security headers.
    const csp = response.headers()['content-security-policy'] ?? '';
    assert.ok(csp.includes("script-src 'self'"), `docs page must keep a strict script-src CSP (got: ${csp})`);
    assert.equal(consoleErrors.length, 0, `docs page console must be clean: ${consoleErrors.join(' | ')}`);

    // 6. The spec is reachable unauthenticated (public API reference) and the
    //    documented login operation is marked public (no lock icon needed).
    const lockless = specJson.paths['/api/v1/auth/login'].post.security;
    assert.deepEqual(lockless, [], 'login must be documented as public');
    const memosSecurity = specJson.paths['/api/v1/memos/'].get.security;
    assert.deepEqual(memosSecurity, [{ sessionCookie: [] }], 'memo listing must require the session cookie');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, '21-openapi-docs.png') });
  } finally {
    await ctx.close();
  }
});
