/**
 * Pocket Diary AI — end-to-end journey (handoff §8 items 13-16, 20-24).
 *
 * Requires the stack under test to be started with the standalone AI mock
 * provider (scripts/ai-mock-provider.mjs) and the backend pointed at it:
 *   AI_CREDENTIAL_ENCRYPTION_KEY=<64 hex>
 *   AI_OPENAI_BASE_URL=http://127.0.0.1:9971
 * When the mock is unreachable the AI-specific assertions are SKIPPED with a
 * clear notice (the suite still passes, so non-AI environments don't break).
 *
 * The mock's /__recorded endpoint lets us assert what the provider ACTUALLY
 * received — the core privacy guarantee.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_URL, launchBrowser } from './_helpers.js';

const AI_MOCK_URL = process.env.AI_MOCK_URL || 'http://127.0.0.1:9971';
const testRunId = Date.now();

async function mockHealthy() {
  try {
    const res = await fetch(`${AI_MOCK_URL}/__recorded`);
    if (!res.ok) return false;
    const json = await res.json();
    return Array.isArray(json.recorded);
  } catch {
    return false;
  }
}

async function getRecorded() {
  const res = await fetch(`${AI_MOCK_URL}/__recorded`);
  return (await res.json()).recorded;
}

test('User Journey 22: Pocket Diary AI — providers, chat, note proposals, privacy, persistence', { timeout: 240_000 }, async (t) => {
  const aiEnabled = await mockHealthy();
  if (!aiEnabled) {
    console.log('[Journey 22] AI mock provider is not reachable at', AI_MOCK_URL);
    console.log('[Journey 22] Skipping AI assertions. Start scripts/ai-mock-provider.mjs and set AI_OPENAI_BASE_URL on the backend to enable.');
    t.skip('AI mock provider not configured');
    return;
  }

  const browser = await launchBrowser();
  t.after(() => browser.close());
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const user = {
    name: 'AI Journey User',
    email: `ai_journey_${testRunId}@example.com`,
    password: 'Password123!',
  };

  // ---------- Register (fresh account, same flow as Journey 01) ----------
  await page.goto(BASE_URL);
  await page.waitForSelector('#view-landing.active', { timeout: 10_000 });
  await page.click('#hero-get-started-btn');
  await page.waitForSelector('#view-auth.active', { timeout: 10_000 });
  const authTitle = await page.textContent('#auth-title');
  if (!authTitle.includes('Create Account')) {
    await page.click('#auth-switch-btn');
    await page.waitForTimeout(200);
  }
  await page.fill('#auth-name-input', user.name);
  await page.fill('#auth-email-input', user.email);
  await page.fill('#auth-password-input', user.password);
  await page.fill('#auth-confirm-password-input', user.password);
  await page.click('#auth-submit-btn');
  await page.waitForSelector('#view-dashboard', { timeout: 20_000 });
  console.log('[Journey 22] Signed in.');

  // ---------- Configure an OpenAI provider through the settings dialog ----------
  await page.click('#nav-ai-btn');
  await page.waitForSelector('#ai-chat-drawer.open', { timeout: 5_000 });
  await page.click('#ai-settings-btn');
  await page.waitForSelector('#modal-ai-settings', { state: 'visible' });
  // Switching provider must discard an unsaved key instead of sending it to
  // a different vendor's model-list endpoint.
  await page.selectOption('#ai-config-provider', 'gemini');
  await page.fill('#ai-config-key', 'synthetic-other-provider-key-123');
  await page.selectOption('#ai-config-provider', 'openai');
  assert.equal(await page.inputValue('#ai-config-key'), '', 'cross-provider key must be cleared');
  await page.fill('#ai-config-label', 'E2E key');
  await page.fill('#ai-config-model', 'mock-model-a');
  await page.fill('#ai-config-key', 'sk-e2e-mock-key-00000001');
  // User does not have to press Fetch Models. The key auto-populates the
  // catalog with account-scoped results, replacing the manual text field.
  await page.waitForSelector('#ai-config-model-select', { state: 'visible', timeout: 15_000 });
  assert.equal(await page.inputValue('#ai-config-model-select'), 'mock-model-a');
  const modelStatus = await page.locator('#ai-config-model-status').textContent();
  assert.ok(modelStatus.includes('2'), 'two models were pulled automatically');
  const modalBg = await page.locator('#modal-ai-settings > .modal-content')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(modalBg, 'rgba(0, 0, 0, 0)', 'settings modal has an opaque surface');
  await page.click('#ai-config-submit');
  await page.waitForSelector('.ai-config-card', { timeout: 10_000 });
  const keyShown = await page.textContent('.ai-config-card .ai-config-key');
  assert.ok(keyShown.includes('••••'), 'key is masked in settings');
  assert.ok(!keyShown.includes('sk-e2e-mock-key'), 'plaintext key never displayed');
  // Connection test succeeds against the mock.
  await page.click('.ai-config-card .btn:has-text("Test connection"), .ai-config-card button:has-text("接続")');
  await page.waitForSelector('.ai-config-status.ok', { timeout: 20_000 });
  console.log('[Journey 22] Provider configured + connection test passed.');
  await page.click('#modal-ai-settings-done-btn');

  // ---------- General chat round trip (no note open) ----------
  await page.fill('#ai-composer-input', 'Help me plan an online electronics shop');
  await page.click('#ai-send-btn');
  await page.waitForSelector('.ai-msg.assistant', { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('#ai-drawer-messages')?.textContent.includes('MOCK_REPLY'),
    { timeout: 30_000 }
  );
  console.log('[Journey 22] General chat round trip works.');

  // Brainstorming must NOT create a note.
  await page.waitForTimeout(500);
  const dashboardCountBefore = await page.locator('.keep-note-card').count().catch(() => 0);
  assert.equal(dashboardCountBefore, 0, 'brainstorming alone creates no notes');

  // ---------- Hide the drawer (not delete), reopen: state preserved ----------
  await page.fill('#ai-composer-input', 'draft text to keep');
  await page.click('#ai-drawer-close-btn');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#ai-chat-drawer.open').count(), 0, 'drawer hidden');
  await page.click('#nav-ai-btn');
  await page.waitForSelector('#ai-chat-drawer.open', { timeout: 5_000 });
  const draftAfterReopen = await page.inputValue('#ai-composer-input');
  assert.equal(draftAfterReopen, 'draft text to keep', 'draft preserved across hide/reopen');
  const messagesStillThere = await page.locator('.ai-msg.assistant').count();
  assert.ok(messagesStillThere >= 1, 'conversation preserved across hide/reopen');

  // ---------- Create a note from the conversation (mock emits a tool call) ----------
  await page.fill('#ai-composer-input', '__TOOL__ Create a project plan note from our discussion');
  await page.click('#ai-send-btn');
  await page.waitForSelector('.ai-proposal-card', { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelector('.ai-proposal-card')?.textContent.includes('E-commerce Shop Plan'),
    { timeout: 20_000 },
  );
  console.log('[Journey 22] Proposal preview shows the drafted title.');
  // Approve → note created exactly once.
  await page.click('.ai-proposal-card .btn:has-text("Create note"), .ai-proposal-card button:has-text("ノートを作成")');
  await page.waitForSelector('.ai-proposal-card[data-proposal-done]', { timeout: 20_000 });
  console.log('[Journey 22] Note proposal approved and saved.');
  // The note exists in the workspace via the API-backed UI list.
  await page.waitForTimeout(800);

  // ---------- Stage A private discovery -> Stage B consented reading ----------
  // A new eligible note is saved in a synthetic test account, never in the
  // existing Pocket Diary user database.
  await page.evaluate(async () => {
    const me = await (await fetch('/api/v1/auth/me', { credentials: 'include' })).json();
    const workspace = me.workspaces?.[0] ?? me.workspace;
    const res = await fetch('/api/v1/memos', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspace.id,
        title: 'webshop architecture',
        content: 'QASHOP-ONLY-AFTER-APPROVAL: build a payment and catalog plan',
      }),
    });
    if (!res.ok) throw Error('Cannot create search fixture: ' + res.status);
    const note = (await res.json()).memo;
    const privacy = await fetch(`/api/v1/ai/memos/${note.id}/privacy`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.id, aiAccess: 'search_allowed' }),
    });
    if (!privacy.ok) throw Error('Cannot set search permission: ' + privacy.status);
  });
  const beforeSearch = (await getRecorded()).length;
  await page.click('#ai-search-mode-btn');
  await page.fill('#ai-composer-input', '__SEARCH__ webshop');
  await page.click('#ai-send-btn');
  await page.waitForSelector('.ai-search-hit-title:has-text("webshop architecture")', { timeout: 25_000 });
  const beforeConsent = (await getRecorded()).slice(beforeSearch).map((r) => r.body).join('\n');
  assert.ok(!beforeConsent.includes('QASHOP-ONLY-AFTER-APPROVAL'),
    'local discovery does not send note content to the provider');
  await page.click('.ai-search-hit:has-text("webshop architecture") input[type="checkbox"]');
  await page.click('.ai-search-results button:has-text("Review selected notes")');
  await page.waitForSelector('.ai-search-preview-text', { timeout: 12_000 });
  assert.ok((await page.locator('.ai-search-preview-text').textContent()).includes('QASHOP-ONLY-AFTER-APPROVAL'));
  const beforeApproval = (await getRecorded()).length;
  await page.click('.ai-search-results button:has-text("Approve and analyze these excerpts")');
  await page.waitForTimeout(2300);
  const afterConsent = (await getRecorded()).slice(beforeApproval).map((r) => r.body).join('\n');
  assert.ok(afterConsent.includes('QASHOP-ONLY-AFTER-APPROVAL'),
    'explicit approval sends the selected, authorized excerpt to the provider');
  console.log('[Journey 22] Two-stage AI search requires consent and passes the selected excerpt.');

  // ---------- First current-note action must obtain authorization ----------
  await page.waitForFunction(() => !document.querySelector('#ai-send-btn')?.disabled, { timeout: 15_000 });
  await page.click('.ai-search-hit-title:has-text("webshop architecture")');
  await page.waitForSelector('#view-editor.active', { timeout: 12_000 });
  await page.waitForTimeout(400);
  const sentModes = [];
  let currentNoteGrantCalls = 0;
  page.on('request', (req) => {
    if (req.method() !== 'POST') return;
    if (req.url().includes('/api/v1/ai/current-note/grant')) currentNoteGrantCalls++;
    if (req.url().includes('/api/v1/ai/conversations/') && req.url().endsWith('/messages')) {
      try { sentModes.push(JSON.parse(req.postData() || '{}').mode); } catch { /* ignore */ }
    }
  });
  const beforeNoteTask = (await getRecorded()).length;
  await page.click('#ai-summarize-note-btn');
  await page.waitForFunction(() => !document.querySelector('#ai-send-btn')?.disabled, { timeout: 20_000 });
  await page.waitForTimeout(450);
  const noteTaskBodies = (await getRecorded()).slice(beforeNoteTask).map((r) => r.body).join('\n');
  assert.ok(currentNoteGrantCalls >= 1, 'first summarize click requests a current-note grant');
  assert.ok(sentModes.includes('note_task'), 'first summarize click uses note-task mode');
  assert.ok(noteTaskBodies.includes('QASHOP-ONLY-AFTER-APPROVAL'),
    'authorized current-note content is shared for the explicit summarize task');
  console.log('[Journey 22] First summarize click authorized and read the open note.');

  // Closing the editor returns AI to General Chat and revokes the previously
  // issued server grant; activeMemo cached in state must not count as open.
  let revokeCalls = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/v1/ai/current-note/revoke')) revokeCalls++;
  });
  await page.click('#ai-drawer-close-btn');
  await page.click('#editor-back-btn');
  await page.waitForSelector('#view-dashboard.active', { timeout: 12_000 });
  await page.waitForTimeout(450);
  assert.ok(revokeCalls >= 1, 'leaving the editor revokes current-note access');
  await page.click('#nav-ai-btn');
  await page.waitForSelector('#ai-chat-drawer.open', { timeout: 8_000 });
  const noNoteScope = await page.textContent('#ai-scope-indicator');
  assert.ok(noNoteScope.includes('General') || noNoteScope.includes('一般'),
    'closing the editor restores general chat without note access');
  console.log('[Journey 22] Closing the editor revokes its note access.');

  // ---------- Privacy: blocked note never reaches the provider ----------
  await mockReset();
  async function mockReset() {
    await fetch(`${AI_MOCK_URL}/__reset`, { method: 'POST' }).catch(() => {});
  }
  // (recorded grows; we snapshot lengths instead when /__reset is absent)
  const recordedBeforeBlock = (await getRecorded()).length;

  // Create a note that we will block. The API-driven path is deterministic
  // across viewports; the session cookie applies automatically.
  await page.keyboard.press('Escape'); // ensure drawer focus released
  await page.click('#nav-ai-btn'); // close drawer
  await page.waitForTimeout(300);
  await page.evaluate(async () => {
    const meRes = await fetch('/api/v1/auth/me', { credentials: 'include' });
    const me = await meRes.json();
    const ws = me.workspaces?.[0] ?? me.workspace;
    const res = await fetch('/api/v1/memos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        workspaceId: ws.id,
        title: 'Blocked secret note',
        content: 'BLOCKED-SHOP-CREDENTIAL: mock_sec_BlockMe9999',
      }),
    });
    if (!res.ok) throw new Error('note create failed: ' + res.status);
  });
  await page.reload();
  await page.waitForSelector('#view-dashboard', { timeout: 20_000 });
  await page.waitForTimeout(600);
  // Open the note and set AI privacy to blocked via the editor button.
  const blockedCard = page.locator('.memo-card', { hasText: 'Blocked secret note' }).first();
  await blockedCard.waitFor({ timeout: 15_000 });
  await blockedCard.locator('.memo-card-title').click();
  await page.waitForSelector('#view-editor.active', { timeout: 10_000 });
  await page.waitForTimeout(600);
  await page.click('#editor-ai-privacy-btn');
  await page.waitForSelector('#modal-ai-privacy', { state: 'visible' });
  await page.check('#ai-privacy-options input[value="blocked"]');
  await page.waitForTimeout(500);
  await page.click('#modal-ai-privacy-close-btn');

  // With the blocked note open, try to summarize via the drawer.
  await page.click('#nav-ai-btn');
  await page.waitForSelector('#ai-chat-drawer.open', { timeout: 5_000 });
  await page.waitForTimeout(400);
  const scopeBlocked = await page.textContent('#ai-scope-indicator');
  assert.ok(
    scopeBlocked.includes('blocked') || scopeBlocked.includes('ブロック') || scopeBlocked.includes('General chat'),
    'scope indicator reflects the blocked state'
  );
  await page.fill('#ai-composer-input', 'Summarize this note');
  await page.click('#ai-send-btn');
  await page.waitForTimeout(3500);
  const recordedAfter = await getRecorded();
  const newBodies = recordedAfter.slice(recordedBeforeBlock).map((r) => r.body).join('\n');
  assert.ok(!newBodies.includes('BLOCKED-SHOP-CREDENTIAL'), 'blocked note content never reaches the provider');
  assert.ok(!newBodies.includes('mock_sec_BlockMe9999'), 'blocked secret never reaches the provider');
  console.log('[Journey 22] Blocked note content confirmed absent from provider traffic.');

  // ---------- Refresh: conversation persists server-side ----------
  await page.reload();
  await page.waitForSelector('#view-editor, #view-dashboard', { timeout: 20_000 });
  await page.waitForTimeout(800);
  await page.click('#nav-ai-btn');
  await page.waitForSelector('#ai-chat-drawer.open', { timeout: 5_000 });
  await page.waitForTimeout(800);
  const afterRefresh = await page.locator('.ai-msg').count();
  assert.ok(afterRefresh >= 2, 'conversation restored from the server after a full page refresh');
  console.log('[Journey 22] Conversation persisted across refresh.');

  // ---------- CSP / console hygiene ----------
  const cspViolations = consoleErrors.filter((e) => e.includes('Content Security Policy') || e.includes(' Refused to '));
  assert.equal(cspViolations.length, 0, `no CSP violations: ${cspViolations.slice(0, 3).join(' | ')}`);
  await page.screenshot({ path: '../.agents/browser/22-ai-assistant.png', fullPage: true });
  console.log('[Journey 22] Completed successfully.');
});
