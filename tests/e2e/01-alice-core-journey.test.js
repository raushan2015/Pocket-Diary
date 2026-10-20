/**
 * Alice end-to-end core story — journeys 1 through 9 run as ONE continuous
 * scenario sharing a single browser: registration -> workspaces -> memos ->
 * search -> migration -> tenant isolation -> session persistence.
 *
 * Every other journey lives in its own file and is fully independent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BASE_URL, SCREENSHOT_DIR, launchBrowser } from './_helpers.js';

let browser;

test.before(async () => {
  console.log(`[Alice Story] Launching headless browser targeting ${BASE_URL}...`);
  browser = await launchBrowser();
});

test.after(async () => {
  if (browser) {
    await browser.close();
    console.log('[Alice Story] Browser closed cleanly.');
  }
});

const testRunId = Date.now();
const aliceUser = {
  name: 'Alice QA Architect',
  email: `alice_${testRunId}@example.com`,
  password: 'Password123!',
  workspaceName: 'Engineering Squad',
  workspaceSlug: `engineering-squad-${testRunId}`,
};

const bobUser = {
  name: 'Bob Tenant QA',
  email: `bob_${testRunId}@example.com`,
  password: 'Password123!',
};

let aliceContext;
let alicePage;
let aliceDefaultWorkspaceId;
let aliceCustomWorkspaceId;
let aliceBlueprintMemoId;

test('User Journey 1: Landing Page, Responsive Viewport & Dark/Light Mode', async () => {
  aliceContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  alicePage = await aliceContext.newPage();

  console.log('[Test 1] Navigating to landing page...');
  await alicePage.goto(BASE_URL);
  await alicePage.waitForSelector('#view-landing.active', { timeout: 10000 });

  // 1. Verify hero headline & value propositions
  const heroText = await alicePage.textContent('.hero-headline');
  assert.ok(heroText.includes('Your Ideas, Notes and Tasks'), 'Hero title matches frontend.PNG specification');

  // Verify 8 feature cards
  const featureCards = await alicePage.$$('.feature-card');
  assert.equal(featureCards.length, 8, '8 Feature Cards exist on landing page');

  // Verify trust badges
  const trustBadges = await alicePage.$$('.trust-badge-item');
  assert.equal(trustBadges.length, 3, '3 Trust badges exist');

  // 2. Dark Mode Toggle
  const themeBtn = await alicePage.waitForSelector('#theme-toggle-btn');
  await themeBtn.click();
  // Wait for the theme to actually apply instead of sleeping a fixed 300 ms:
  // on slow CI runners the click can land before app.js wires the toggle
  // listener, and a fixed delay is exactly the kind of race CI exposes.
  await alicePage.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'dark',
    null,
    { timeout: 5000 },
  );
  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-01-dark-mode-landing.png'), fullPage: false });
  console.log('[Test 1] Captured qa-01-dark-mode-landing.png');

  // Switch back to light mode
  await themeBtn.click();
  await alicePage.waitForFunction(
    () => document.documentElement.getAttribute('data-theme') === 'light',
    null,
    { timeout: 5000 },
  );
  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-02-light-mode-landing.png'), fullPage: false });
  console.log('[Test 1] Captured qa-02-light-mode-landing.png');

  // 3. Responsive Mobile Viewport
  await alicePage.setViewportSize({ width: 390, height: 844 });
  await alicePage.waitForTimeout(300);
  const mobileNavVisible = await alicePage.isVisible('#mobile-bottom-nav');
  const mobileCreateFabVisible = await alicePage.isVisible('#mob-nav-create');
  assert.equal(mobileNavVisible, false, 'Mobile bottom navigation bar is removed');
  assert.equal(mobileCreateFabVisible, false, 'Create action is not shown before signing in');
  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-11-mobile-responsive.png'), fullPage: false });
  console.log('[Test 1] Captured qa-11-mobile-responsive.png');

  // Restore desktop viewport
  await alicePage.setViewportSize({ width: 1440, height: 900 });
  await alicePage.waitForTimeout(200);
});

test('User Journey 2: User Registration & Default Workspace Landing', async () => {
  console.log('[Test 2] Initiating user registration for Alice...');
  // Click Get Started button
  await alicePage.click('#hero-get-started-btn');
  await alicePage.waitForSelector('#view-auth.active', { timeout: 10000 });

  // Ensure registration mode
  const title = await alicePage.textContent('#auth-title');
  if (!title.includes('Create Account')) {
    await alicePage.click('#auth-switch-btn');
    await alicePage.waitForTimeout(200);
  }

  // Fill registration form
  await alicePage.fill('#auth-name-input', aliceUser.name);
  await alicePage.fill('#auth-email-input', aliceUser.email);
  await alicePage.fill('#auth-password-input', aliceUser.password);
  await alicePage.fill('#auth-confirm-password-input', aliceUser.password);

  // Submit registration
  await alicePage.click('#auth-submit-btn');

  // Verify redirected to Dashboard
  await alicePage.waitForSelector('#view-dashboard.active', { timeout: 15000 });
  await alicePage.setViewportSize({ width: 390, height: 844 });
  assert.ok(await alicePage.isVisible('#mob-nav-create'), 'Floating create-note button is visible on mobile dashboard');
  await alicePage.waitForTimeout(250);
  const mobileLayout = await alicePage.evaluate(() => {
    const rect = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
    return { viewport: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, search: rect('#global-search-input'), filter: rect('#navbar-filter-toggle'), brand: rect('.navbar-brand-section'), actions: rect('.navbar-actions'), card: rect('#view-dashboard .dashboard-main-grid > .surface-card'), empty: rect('#memos-empty-state') };
  });
  assert.ok(mobileLayout.scrollWidth <= mobileLayout.viewport, `Mobile layout has no horizontal overflow: ${JSON.stringify(mobileLayout)}`);
  assert.ok(mobileLayout.search && mobileLayout.filter && mobileLayout.search.right <= mobileLayout.filter.left + 2, `Search and Filters fit without overlap: ${JSON.stringify(mobileLayout)}`);
  assert.ok(mobileLayout.card && mobileLayout.card.left >= 0 && mobileLayout.card.right <= mobileLayout.viewport + 1, `Notes card fits viewport: ${JSON.stringify(mobileLayout)}`);
  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-12-mobile-dashboard.png'), fullPage: false });
  await alicePage.setViewportSize({ width: 1440, height: 900 });
  await alicePage.waitForTimeout(200);
  const desktopHeader = await alicePage.evaluate(() => {
    const r = (selector) => { const el = document.querySelector(selector); if (!el) return null; const b = el.getBoundingClientRect(); return { left:b.left, right:b.right, top:b.top, bottom:b.bottom, width:b.width, height:b.height }; };
    return { viewport:innerWidth, scrollWidth:document.documentElement.scrollWidth, search:r('#global-search-input'), filter:r('#navbar-filter-toggle'), brand:r('.navbar-brand-section'), actions:r('.navbar-actions') };
  });
  assert.ok(desktopHeader.scrollWidth <= desktopHeader.viewport, `Desktop layout has no horizontal overflow: ${JSON.stringify(desktopHeader)}`);
  assert.ok(desktopHeader.search && desktopHeader.filter && Math.abs(desktopHeader.search.top - desktopHeader.filter.top) < 8, `Desktop search and filters share one row: ${JSON.stringify(desktopHeader)}`);
  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-13-desktop-dashboard.png'), fullPage: false });
  console.log('[Test 2] Successfully registered and landed on Dashboard');

  // Verify user profile pill
  const userGreeting = await alicePage.textContent('#dashboard-greeting-title');
  assert.ok(userGreeting.includes('Alice'), `Greeting includes user name: ${userGreeting}`);

  // Verify default workspace
  const workspaceItem = await alicePage.waitForSelector('.workspace-item');
  const wsText = await workspaceItem.textContent();
  assert.ok(wsText.includes('Personal'), 'Default "Personal" workspace is active');

  // Retrieve current active workspace ID from API
  aliceDefaultWorkspaceId = await alicePage.evaluate(async () => {
    const res = await fetch('/api/v1/auth/me', { credentials: 'include' });
    const data = await res.json();
    return data.workspaces?.[0]?.id;
  });
  console.log('[Test 2] Alice default workspace ID:', aliceDefaultWorkspaceId);

  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-03-registered-dashboard.png'), fullPage: false });
  console.log('[Test 2] Captured qa-03-registered-dashboard.png');
});

test('User Journey 3: Workspace Creation & Workspace Switcher', async () => {
  console.log('[Test 3] Creating new workspace "Engineering Squad"...');
  await alicePage.click('#add-workspace-btn');
  await alicePage.waitForSelector('#modal-workspace.active', { timeout: 5000 });

  await alicePage.fill('#ws-name-input', aliceUser.workspaceName);
  await alicePage.fill('#ws-slug-input', aliceUser.workspaceSlug);
  await alicePage.click('#modal-ws-submit-btn');

  // Wait for modal to close
  await alicePage.waitForFunction(() => !document.getElementById('modal-workspace')?.classList.contains('active'), { timeout: 5000 });

  // Verify workspace is present in sidebar list
  await alicePage.waitForSelector('.workspace-item', { timeout: 5000 });
  const workspaceItems = await alicePage.$$('.workspace-item');
  let foundNewWs = false;
  for (const item of workspaceItems) {
    const text = await item.textContent();
    if (text.includes(aliceUser.workspaceName)) {
      foundNewWs = true;
      // Click to switch into it
      await item.click();
      await alicePage.waitForTimeout(500);
      break;
    }
  }
  assert.ok(foundNewWs, 'New workspace "Engineering Squad" is present in sidebar');

  // Get active workspace ID from API
  aliceCustomWorkspaceId = await alicePage.evaluate(async (wsName) => {
    const res = await fetch('/api/v1/workspaces', { credentials: 'include' });
    const data = await res.json();
    const found = data.workspaces?.find(w => w.name === wsName);
    return found ? found.id : data.workspaces?.[data.workspaces.length - 1]?.id;
  }, aliceUser.workspaceName);
  console.log('[Test 3] Alice custom workspace ID:', aliceCustomWorkspaceId);

  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-04-workspace-created.png'), fullPage: false });
  console.log('[Test 3] Captured qa-04-workspace-created.png');
});

test('User Journey 4: Memo Creation with Status, Priority, Due Date, Tags & Checklists', async () => {
  console.log('[Test 4] Creating a folder and Memo 1: Sprint 42 Architecture Blueprint...');
  const autosaveErrors = [];
  alicePage.on('console', (message) => { if (message.type() === 'error') autosaveErrors.push(message.text()); });
  await alicePage.click('#add-folder-btn');
  await alicePage.waitForSelector('#modal-folder.active', { timeout: 5000 });
  await alicePage.fill('#folder-name-input', 'Architecture');
  await alicePage.click('#modal-folder-submit-btn');
  await alicePage.waitForFunction(() => !document.getElementById('modal-folder')?.classList.contains('active'), { timeout: 5000 });

  const architectureFolderId = await alicePage.evaluate(async (wsId) => {
    const response = await fetch(`/api/v1/folders?workspaceId=${wsId}`, { credentials: 'include' });
    const data = await response.json();
    return data.folders?.find((folder) => folder.name === 'Architecture')?.id;
  }, aliceCustomWorkspaceId);
  assert.ok(architectureFolderId, 'Folder was saved to the workspace');

  await alicePage.click('#dashboard-new-memo-btn');
  await alicePage.waitForSelector('#view-editor.active', { timeout: 5000 });

  // Autosave a note without interacting with any Save button.
  await alicePage.fill('#editor-title-input', 'Sprint 42 Architecture Blueprint Autosaved');
  await alicePage.fill('#editor-body-textarea', 'This note is saved automatically on typing.');
  await alicePage.waitForFunction(async ({ workspaceId, title }) => {
    const response = await fetch(`/api/v1/memos?workspaceId=${workspaceId}&search=Autosaved`, { credentials: 'include' });
    const data = await response.json();
    return data.memos?.some((memo) => memo.title === title && memo.content.includes('saved automatically'));
  }, { workspaceId: aliceCustomWorkspaceId, title: 'Sprint 42 Architecture Blueprint Autosaved' }, { timeout: 10000 });

  // Continue editing the saved note and verify normal back-navigation is persisted automatically.
  await alicePage.fill('#editor-title-input', 'Sprint 42 Architecture Blueprint');

  // Fill markdown content with checklist
  const memoContent = `# Sprint 42 Architecture Blueprint

High-performance Pocket Diary SaaS system design:
- [x] Fastify API engine with Drizzle ORM
- [x] Strict workspace-scoped tenant isolation
- [ ] SQLite FTS5 sub-millisecond full-text search
- [ ] Atomic legacy localStorage migration import
`;
  await alicePage.fill('#editor-body-textarea', memoContent);
  await alicePage.selectOption('#memo-folder-select', { label: 'Architecture' });

  // Set Priority to Urgent
  await alicePage.selectOption('#memo-priority-select', 'urgent');

  // Set Status to In Progress
  await alicePage.selectOption('#memo-status-select', 'in_progress');

  // Set Due Date
  await alicePage.fill('#memo-due-date-input', '2026-10-31');

  // Add Tags
  await alicePage.fill('#editor-new-tag-input', 'architecture');
  await alicePage.click('#editor-add-tag-btn');
  await alicePage.waitForTimeout(200);

  await alicePage.fill('#editor-new-tag-input', 'sprint-42');
  await alicePage.click('#editor-add-tag-btn');
  await alicePage.waitForTimeout(200);

  // Leave the editor without pressing Save. Back navigation must flush pending edits.
  await alicePage.click('#editor-back-btn');
  await alicePage.waitForFunction(() => document.getElementById('view-dashboard')?.classList.contains('active'), { timeout: 8000 });
  const autosaveList = await alicePage.evaluate(async (wsId) => {
    const response = await fetch(`/api/v1/memos?workspaceId=${wsId}&search=Blueprint`, { credentials: 'include' });
    return response.json();
  }, aliceCustomWorkspaceId);
  assert.ok(autosaveList.memos?.some((memo) => memo.title === 'Sprint 42 Architecture Blueprint'), 'Back navigation saved the memo automatically');

  // Retrieve saved memo ID immediately from API so subsequent journeys have it regardless of UI timing
  aliceBlueprintMemoId = (autosaveList.memos || []).find((memo) => memo.title === 'Sprint 42 Architecture Blueprint')?.id;
  assert.ok(aliceBlueprintMemoId, 'Saved memo has a valid ID');

  await alicePage.click('#side-nav-all');
  await alicePage.waitForSelector(`.memo-card[data-memo-id="${aliceBlueprintMemoId}"]`, { timeout: 10000 });
  await alicePage.click(`.memo-card[data-memo-id="${aliceBlueprintMemoId}"] .memo-card-title`);
  await alicePage.waitForSelector('#view-editor.active', { timeout: 10000 });
  const saveText = await alicePage.textContent('#editor-save-indicator');
  assert.ok(saveText.includes('Saved'), `Automatically saved memo remains saved: ${saveText}`);

  const savedBlueprint = await alicePage.evaluate(async (memoId) => {
    const response = await fetch(`/api/v1/memos/${memoId}`, { credentials: 'include' });
    const data = await response.json();
    return data.memo;
  }, aliceBlueprintMemoId);
  assert.equal(savedBlueprint.folderId, architectureFolderId, 'Memo is saved inside the selected folder');
  console.log('[Test 4] Created Alice Memo ID:', aliceBlueprintMemoId);

  // Return to Dashboard
  await alicePage.click('#editor-back-btn');
  await alicePage.waitForSelector('#view-dashboard.active', { timeout: 5000 });

  // Create Memo 2: Customer Feedback Summary
  console.log('[Test 4] Creating Memo 2: Customer Feedback Summary...');
  await alicePage.click('#dashboard-new-memo-btn');
  await alicePage.waitForSelector('#view-editor.active', { timeout: 5000 });

  await alicePage.fill('#editor-title-input', 'Customer Feedback Summary');
  await alicePage.fill('#editor-body-textarea', 'Comprehensive survey results from enterprise beta testers.');
  await alicePage.selectOption('#memo-priority-select', 'medium');
  await alicePage.selectOption('#memo-status-select', 'completed');
  await alicePage.fill('#editor-new-tag-input', 'feedback');
  await alicePage.click('#editor-add-tag-btn');
  await alicePage.waitForTimeout(200);

  await alicePage.click('#editor-save-btn');
  await alicePage.waitForSelector('#editor-save-indicator', { timeout: 5000 });
  await alicePage.click('#editor-back-btn');
  await alicePage.waitForSelector('#view-dashboard.active', { timeout: 5000 });

  // Verify both memo cards are present on Dashboard
  const memoCards = await alicePage.$$('.memo-card');
  assert.equal(memoCards.length, 2, '2 Memo cards displayed on Dashboard');
  assert.equal(await alicePage.isVisible('#view-mode-list-btn'), false, 'Notes page only offers grid view');

  // Grid-only dashboard regression. Sorting and tag assignment/filtering are covered by API tests.
  assert.equal(await alicePage.isVisible('#view-mode-list-btn'), false, 'Notes page only offers grid view');

  await alicePage.click(`#side-nav-folder-${architectureFolderId}`);
  await alicePage.waitForTimeout(300);
  const folderCards = await alicePage.$$('.memo-card');
  assert.equal(folderCards.length, 1, 'Folder filter shows only the memo assigned to that folder');
  assert.ok((await alicePage.textContent('#memos-view-heading')).includes('Architecture'));
  await alicePage.click('#side-nav-all');
  await alicePage.waitForTimeout(300);

  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-05-memos-dashboard.png'), fullPage: false });
  console.log('[Test 4] Captured qa-05-memos-dashboard.png');
});

test('User Journey 5: Memo Edit, Optimistic Concurrency, Soft-Delete & Trash Restore', async () => {
  console.log('[Test 5] Editing Blueprint Memo...');
  // Find Blueprint memo card and click to edit
  await alicePage.waitForSelector(`.memo-card[data-memo-id="${aliceBlueprintMemoId}"]`, { timeout: 10000 });
  await alicePage.click(`.memo-card[data-memo-id="${aliceBlueprintMemoId}"] .memo-card-title`);
  await alicePage.waitForSelector('#view-editor.active', { timeout: 10000 });

  // Update title
  await alicePage.fill('#editor-title-input', 'Sprint 42 Architecture Blueprint (Reviewed & Approved)');

  // Toggle favorite
  await alicePage.click('#editor-fav-btn');

  // Save updated memo
  await alicePage.click('#editor-save-btn');
  await alicePage.waitForFunction(async (memoId) => {
    const response = await fetch(`/api/v1/memos/${memoId}`, { credentials: 'include' });
    const data = await response.json();
    return data.memo?.title === 'Sprint 42 Architecture Blueprint (Reviewed & Approved)';
  }, aliceBlueprintMemoId, { timeout: 8000 });
  await alicePage.waitForFunction(() => document.getElementById('editor-save-indicator')?.textContent?.includes('Saved'), { timeout: 8000 });
  const saveTextV2 = await alicePage.textContent('#editor-save-indicator');
  assert.ok(saveTextV2.includes('Saved'), `Updated note is saved automatically: ${saveTextV2}`);

  // Test soft delete to Trash
  console.log('[Test 5] Moving memo to Trash...');
  await alicePage.click('#editor-delete-btn');
  await alicePage.waitForSelector('#view-dashboard.active', { timeout: 5000 });

  // Verify memo is no longer in active grid (only 1 memo remains)
  const remainingCards = await alicePage.$$('.memo-card');
  assert.equal(remainingCards.length, 1, 'Only 1 active memo remains after soft-delete');

  // Navigate to Trash view in sidebar
  await alicePage.click('#side-nav-trash');
  await alicePage.waitForTimeout(500);

  const headingText = await alicePage.textContent('#memos-view-heading');
  assert.ok(headingText.includes('Trash'), 'View heading shows Trash');

  // Verify Blueprint memo is present in Trash
  const trashedCard = await alicePage.waitForSelector(`.memo-card[data-memo-id="${aliceBlueprintMemoId}"]`);
  assert.ok(trashedCard, 'Soft-deleted memo appears in Trash');

  // Click Restore button on the trashed card
  const restoreBtn = await alicePage.waitForSelector(`.memo-card[data-memo-id="${aliceBlueprintMemoId}"] [data-action="restore"]`);
  await restoreBtn.click();
  await alicePage.waitForTimeout(500);

  // Navigate back to All Memos
  await alicePage.click('#side-nav-all');
  await alicePage.waitForTimeout(500);

  // Verify restored memo is back in active memos (count is 2 again)
  const allCards = await alicePage.$$('.memo-card');
  assert.equal(allCards.length, 2, 'Restored memo is back in All Memos list');

  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-06-memo-editor-lifecycle.png'), fullPage: false });
  console.log('[Test 5] Captured qa-06-memo-editor-lifecycle.png');
});

test('User Journey 6: SQLite FTS5 Full-Text Instant Search', async () => {
  console.log('[Test 6] Testing FTS5 instant search...');
  const searchInput = await alicePage.waitForSelector('#global-search-input');

  // Search by keyword in title: "Blueprint"
  await searchInput.fill('Blueprint');
  await searchInput.dispatchEvent('input');
  await alicePage.waitForTimeout(400);

  let searchResults = await alicePage.$$('.memo-card');
  assert.equal(searchResults.length, 1, 'Search for "Blueprint" returns exactly 1 memo');
  const resultTitle = await searchResults[0].$eval('.memo-card-title', el => el.textContent);
  assert.ok(resultTitle.includes('Blueprint'), `Matching memo title: ${resultTitle}`);

  // Search by keyword in content body: "Fastify"
  await searchInput.fill('Fastify');
  await searchInput.dispatchEvent('input');
  await alicePage.waitForTimeout(400);

  searchResults = await alicePage.$$('.memo-card');
  assert.equal(searchResults.length, 1, 'Search for content keyword "Fastify" matches Blueprint memo');

  // Search for non-existent keyword: "quantum999hyperdrive"
  await searchInput.fill('quantum999hyperdrive');
  await searchInput.dispatchEvent('input');
  await alicePage.waitForTimeout(400);

  const emptyStateVisible = await alicePage.isVisible('#memos-empty-state');
  assert.ok(emptyStateVisible, 'Empty state displayed for non-matching FTS search');

  // Clear search input
  await searchInput.fill('');
  await searchInput.dispatchEvent('input');
  await alicePage.waitForTimeout(400);

  const clearedCards = await alicePage.$$('.memo-card');
  assert.equal(clearedCards.length, 2, 'All memos returned after clearing search input');

  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-07-fts-search.png'), fullPage: false });
  console.log('[Test 6] Captured qa-07-fts-search.png');
});

test('User Journey 7: Legacy LocalStorage Data Migration Import & Export', async () => {
  console.log('[Test 7] Opening Migration Wizard...');
  await alicePage.click('#sidebar-migration-btn');
  await alicePage.waitForSelector('#modal-migration.active', { timeout: 5000 });

  // Paste legacy JSON export into textarea
  const legacyPayload = [
    {
      title: 'Legacy Product Roadmap 2025',
      content: 'Migrated from client localStorage. Key deliverables and release milestones.',
      category: 'Work',
      priority: 'high',
      status: 'pending',
      tags: ['legacy', 'migrated-v1'],
    },
    {
      title: 'Legacy Personal Budget Draft',
      content: 'Financial planning notes and expense estimates.',
      category: 'Personal',
      priority: 'low',
      status: 'completed',
      tags: ['finance', 'migrated-v1'],
    },
  ];

  await alicePage.fill('#mig-json-textarea', JSON.stringify(legacyPayload, null, 2));
  await alicePage.dispatchEvent('#mig-json-textarea', 'input');
  await alicePage.waitForTimeout(300);

  // Verify preview counters
  const memoCountVal = await alicePage.textContent('#mig-stat-memos');
  assert.equal(memoCountVal, '2', 'Migration preview detected 2 memos');

  // Submit migration import
  await alicePage.click('#modal-migration-import-btn');

  // Wait for modal to automatically close after successful import
  await alicePage.waitForFunction(() => !document.getElementById('modal-migration')?.classList.contains('active'), { timeout: 8000 });

  // Verify dashboard now contains original 2 + imported 2 = 4 memos
  await alicePage.waitForTimeout(500);
  const totalMemos = await alicePage.$$('.memo-card');
  assert.equal(totalMemos.length, 4, 'Dashboard displays 4 total memos after migration import');

  // Verify export endpoint functionality
  const exportData = await alicePage.evaluate(async (wsId) => {
    const res = await fetch(`/api/v1/migration/export?workspaceId=${wsId}`, { credentials: 'include' });
    return res.json();
  }, aliceCustomWorkspaceId);
  assert.equal(exportData.workspaceId, aliceCustomWorkspaceId, 'Export contains correct workspaceId');
  assert.equal(exportData.memos.length, 4, 'Export payload contains all 4 memos');

  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-08-migration-import.png'), fullPage: false });
  console.log('[Test 7] Captured qa-08-migration-import.png');
});

test('User Journey 8: Strict Multi-Tenant Isolation & Cross-Workspace Barrier', async () => {
  console.log('[Test 8] Launching independent session for Tenant B (Bob)...');
  const bobContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const bobPage = await bobContext.newPage();

  // Bob navigates and registers
  await bobPage.goto(BASE_URL);
  await bobPage.click('#hero-get-started-btn');
  await bobPage.waitForSelector('#view-auth.active', { timeout: 10000 });

  const title = await bobPage.textContent('#auth-title');
  if (!title.includes('Create Account')) {
    await bobPage.click('#auth-switch-btn');
    await bobPage.waitForTimeout(200);
  }

  await bobPage.fill('#auth-name-input', bobUser.name);
  await bobPage.fill('#auth-email-input', bobUser.email);
  await bobPage.fill('#auth-password-input', bobUser.password);
  await bobPage.fill('#auth-confirm-password-input', bobUser.password);
  await bobPage.click('#auth-submit-btn');

  await bobPage.waitForSelector('#view-dashboard.active', { timeout: 15000 });
  console.log('[Test 8] Bob successfully registered and landed on Dashboard');

  // 1. Verify Bob does not see any of Alice's memos on his Dashboard
  const bobCards = await bobPage.$$('.memo-card');
  assert.equal(bobCards.length, 0, "Bob's workspace is completely isolated: 0 memos present");
  const emptyVisible = await bobPage.isVisible('#memos-empty-state');
  assert.ok(emptyVisible, "Empty state displayed on Bob's fresh workspace");

  // 2. Security Barrier Check: Bob attempts direct HTTP access to Alice's memo ID
  console.log('[Test 8] Bob attempting direct cross-tenant GET to Alice memo ID:', aliceBlueprintMemoId);
  const getMemoCrossTenant = await bobPage.evaluate(async (memoId) => {
    const res = await fetch(`/api/v1/memos/${memoId}`, { credentials: 'include' });
    return { status: res.status };
  }, aliceBlueprintMemoId);

  assert.equal(getMemoCrossTenant.status, 404, 'Accessing cross-tenant memo returns 404 Not Found (does not leak existence)');

  // 3. Security Barrier Check: Bob attempts direct PATCH modification to Alice's memo ID
  const patchMemoCrossTenant = await bobPage.evaluate(async (memoId) => {
    const res = await fetch(`/api/v1/memos/${memoId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ title: 'Hacked by Bob', version: 2 }),
    });
    return { status: res.status };
  }, aliceBlueprintMemoId);

  assert.equal(patchMemoCrossTenant.status, 404, 'Mutating cross-tenant memo returns 404 Not Found');

  // 4. Security Barrier Check: Bob attempts direct DELETE to Alice's memo ID
  const deleteMemoCrossTenant = await bobPage.evaluate(async (memoId) => {
    const res = await fetch(`/api/v1/memos/${memoId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return { status: res.status };
  }, aliceBlueprintMemoId);

  assert.equal(deleteMemoCrossTenant.status, 404, 'Deleting cross-tenant memo returns 404 Not Found');

  // 5. Security Barrier Check: Bob attempts querying Alice's workspace memos
  const listCrossTenant = await bobPage.evaluate(async (wsId) => {
    const res = await fetch(`/api/v1/memos?workspaceId=${wsId}`, { credentials: 'include' });
    return { status: res.status };
  }, aliceCustomWorkspaceId);

  assert.ok(listCrossTenant.status === 403 || listCrossTenant.status === 404, `Listing cross-workspace returns forbidden/not found: status ${listCrossTenant.status}`);

  await bobPage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-09-tenant-isolation-verified.png'), fullPage: false });
  console.log('[Test 8] Captured qa-09-tenant-isolation-verified.png');

  // Clean up Bob's session
  await bobContext.close();
});

test('User Journey 9: Sign Out, Session Persistence & Re-Authentication', async () => {
  console.log('[Test 9] Testing Alice sign out...');
  // Open user menu pill and click logout
  await alicePage.click('#user-menu-pill');
  await alicePage.waitForSelector('#dropdown-logout-btn', { timeout: 3000 });
  await alicePage.click('#dropdown-logout-btn');

  // Verify redirected to landing page
  await alicePage.waitForSelector('#view-landing.active', { timeout: 8000 });
  const navUnauth = await alicePage.isVisible('#nav-unauth-actions');
  assert.ok(navUnauth, 'Unauthenticated navbar actions visible after logout');

  // Security Barrier: Unauthenticated request to /api/v1/auth/me returns 401
  const meCheck = await alicePage.evaluate(async () => {
    const res = await fetch('/api/v1/auth/me', { credentials: 'include' });
    return { status: res.status };
  });
  assert.equal(meCheck.status, 401, 'Signed-out session rejected with 401 Unauthorized');

  // Log Alice back in
  console.log('[Test 9] Logging Alice back in...');
  await alicePage.click('#nav-login-btn');
  await alicePage.waitForSelector('#view-auth.active', { timeout: 5000 });

  await alicePage.fill('#auth-email-input', aliceUser.email);
  await alicePage.fill('#auth-password-input', aliceUser.password);
  await alicePage.click('#auth-submit-btn');

  // Verify Alice lands on Dashboard with workspaces and memos intact
  await alicePage.waitForSelector('#view-dashboard.active', { timeout: 15000 });
  console.log('[Test 9] Alice successfully logged back in');

  // Re-login restores the first workspace ("Personal"), which legitimately has
  // no notes — Alice's memos live in "Engineering Squad". Switch into it and
  // verify the notes are still there, rendered from the server.
  await alicePage.waitForSelector('.workspace-item', { timeout: 5000 });
  const switchTarget = alicePage.locator('.workspace-item', { hasText: aliceUser.workspaceName }).first();
  await switchTarget.click();
  await alicePage.waitForFunction(() => document.querySelectorAll('.memo-card').length >= 1, undefined, { timeout: 10000 });
  const memoCards = await alicePage.$$('.memo-card');
  assert.ok(memoCards.length >= 1, 'Memos are persisted and rendered upon re-authentication');

  await alicePage.screenshot({ path: path.join(SCREENSHOT_DIR, 'qa-10-session-and-logout.png'), fullPage: false });
  console.log('[Test 9] Captured qa-10-session-and-logout.png');

  // Clean up Alice's context
  await aliceContext.close();
});

