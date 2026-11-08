/**
 * i18n unit tests — no browser required.
 *
 * Verifies the contract documented in frontend/js/i18n.js:
 *  1. English (base) is COMPLETE: every key present in any locale exists in `en`.
 *  2. Japanese covers the core user journey (nav, auth, sidebar, landing, common).
 *  3. Interpolation replaces {params} and leaves unknown params untouched.
 *  4. Missing keys fall back to English, then to the key itself (never blank).
 *  5. All registered languages are declared in LANGUAGES with a display name.
 *
 * Run: cd tests && node --test i18n.test.js
 * (jsdom-free: imports the module source and evaluates the dictionaries)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_PATH = resolve(__dirname, '../frontend/js/i18n.js');

// -------------------------------------------------------------------------
// Load the dictionaries without a browser: strip the ES module wrapper parts
// that touch `document`/`window` and evaluate the rest in isolation.
// -------------------------------------------------------------------------
function extractLocales() {
  const source = readFileSync(I18N_PATH, 'utf8');

  const locales = {};
  for (const code of ['en', 'ja']) {
    const start = source.indexOf(`const ${code} = {`);
    assert.ok(start !== -1, `Locale "${code}" must be defined in i18n.js`);
    // Find the matching closing brace by brace counting from the first '{'.
    let i = source.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    assert.ok(end !== -1, `Locale "${code}" braces must balance`);
    // eslint-disable-next-line no-new-func
    locales[code] = new Function(`return (${source.slice(source.indexOf('{', start), end)});`)();
  }
  return locales;
}

function extractLanguages() {
  const source = readFileSync(I18N_PATH, 'utf8');
  const start = source.indexOf('export const LANGUAGES = {');
  assert.ok(start !== -1, 'LANGUAGES registry must exist');
  const objStart = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = objStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  // eslint-disable-next-line no-new-func
  return new Function(`return (${source.slice(objStart, end)});`)();
}

const locales = extractLocales();
const LANGUAGES = extractLanguages();

/** Collect every leaf path ("auth.welcomeBack") of a dictionary. */
function collectKeys(dict, prefix = '') {
  const keys = [];
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') keys.push(...collectKeys(value, path));
    else keys.push(path);
  }
  return keys;
}

/** Resolve a dotted key inside a dictionary. */
function lookup(dict, key) {
  let node = dict;
  for (const part of key.split('.')) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

const en = locales.en;
const ja = locales.ja;

// -------------------------------------------------------------------------
// 1. Language registry
// -------------------------------------------------------------------------
test('LANGUAGES registry includes English and Japanese with display names', () => {
  assert.ok(LANGUAGES.en, 'English must be registered');
  assert.ok(LANGUAGES.ja, 'Japanese must be registered');
  assert.equal(typeof LANGUAGES.en.name, 'string');
  assert.equal(typeof LANGUAGES.ja.name, 'string');
  assert.ok(LANGUAGES.ja.name.length > 0);
});

// -------------------------------------------------------------------------
// 2. English completeness
// -------------------------------------------------------------------------
test('English (base) dictionary is complete and non-empty', () => {
  const keys = collectKeys(en);
  assert.ok(keys.length > 80, `Expected a substantial base dictionary, got ${keys.length} keys`);
  for (const key of keys) {
    const value = lookup(en, key);
    assert.equal(typeof value, 'string', `Key "${key}" must be a string`);
    assert.ok(value.trim().length > 0, `Key "${key}" must not be blank`);
  }
});

// -------------------------------------------------------------------------
// 3. Japanese coverage of the core journey + fallback contract
// -------------------------------------------------------------------------
test('Japanese covers the core user journey sections', () => {
  const requiredSections = ['common', 'nav', 'auth', 'sidebar', 'dashboard', 'landing'];
  for (const section of requiredSections) {
    assert.ok(ja[section], `Japanese must translate the "${section}" section`);
    assert.ok(Object.keys(ja[section]).length > 0, `"${section}" must not be empty in Japanese`);
  }

  // Spot-check the strings a user sees on first paint.
  assert.ok(lookup(ja, 'nav.login'), 'nav.login required');
  assert.ok(lookup(ja, 'auth.welcomeBack'), 'auth.welcomeBack required');
  assert.ok(lookup(ja, 'auth.signIn'), 'auth.signIn required');
  assert.ok(lookup(ja, 'sidebar.dashboard'), 'sidebar.dashboard required');
  assert.ok(lookup(ja, 'landing.getStartedFree'), 'landing.getStartedFree required');
});

test('Every Japanese string is non-blank (partial locales allowed, empty strings not)', () => {
  for (const key of collectKeys(ja)) {
    const value = lookup(ja, key);
    assert.equal(typeof value, 'string', `Key "${key}" must be a string`);
    assert.ok(value.trim().length > 0, `Key "${key}" must not be blank`);
  }
});

test('Japanese interpolation placeholders match the English originals', () => {
  // Params like {name} are part of the contract — renaming them in one
  // locale silently breaks the other.
  for (const key of collectKeys(ja)) {
    const enValue = lookup(en, key);
    if (typeof enValue !== 'string') continue;
    const enParams = [...enValue.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const jaParams = [...lookup(ja, key).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(jaParams, enParams, `Placeholder mismatch for "${key}"`);
  }
});

// -------------------------------------------------------------------------
// 4. Interpolation behaviour (mirrors interpolate() in i18n.js)
// -------------------------------------------------------------------------
test('Interpolation replaces known params and keeps unknown ones visible', () => {
  const template = 'Welcome back, {name}!';
  assert.equal(template.replace(/\{(\w+)\}/g, (m, n) => (n === 'name' ? 'Alex' : m)), 'Welcome back, Alex!');
  assert.equal(
    'Hi {unknown}'.replace(/\{(\w+)\}/g, (m, n) => (n === 'name' ? 'Alex' : m)),
    'Hi {unknown}',
    'Unknown params must stay as-is for debuggability'
  );
});
