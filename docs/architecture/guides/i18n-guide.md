# Pocket Diary — Internationalization (i18n) Guide

> **Audience:** Developers adding or updating translations
> **Implementation:** `frontend/js/i18n.js` (no external libraries)
> **Status:** English (base) + 日本語 (Japanese) shipped

---

## How it works (30-second summary)

- **English is the base dictionary** — it is complete. Every other locale may be
  partial; missing keys fall back to English, then to the key itself. The UI can
  never go blank because of a translation gap.
- **The choice is stored locally** in `localStorage["memo_language"]` (same
  pattern as the theme's `memo_theme`). No server round-trip; the preference
  survives reloads and is per-browser/per-device.
- **Static HTML** is translated declaratively with `data-i18n*` attributes.
- **Dynamic JS strings** call `t('key', { params })`.
- `document.documentElement.lang` is synced for screen readers, and date/time
  helpers use `Intl` so Japanese gets `年月日` ordering automatically.

```
User clicks 🌐 → setLanguage('ja')
  → localStorage["memo_language"] = 'ja'
  → document.documentElement.lang = 'ja'
  → every [data-i18n] element re-translated
  → window event 'language:changed' dispatched (dynamic listeners re-render)
```

---

## File map

| File | Role |
|------|------|
| `frontend/js/i18n.js` | Core module: `t()`, `setLanguage()`, `initI18n()`, switcher UI, `Intl` formatters |
| `frontend/index.html` | Static strings annotated with `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-html` |
| `frontend/js/auth.js`, `app.js`, `app-events.js`, `sidebar.js` | Dynamic strings via `t()` + re-render on `language:changed` |
| `frontend/css/components.css` | `.language-switcher*` styles (mirrors notifications panel) |
| `frontend/sw.js` | `js/i18n.js` is precached (`CACHE_NAME = 'notes-v4'` — bump when changing assets) |
| `tests/i18n.test.js` | Dictionary integrity tests (runs without a browser) |
| `tests/i18n-verify.mjs` | 26-check end-to-end browser verification (`npm run verify:i18n`, needs running app) |

---

## API reference

```js
import {
  t, tEsc,                    // translate (plain / HTML-escaped interpolation)
  getLanguage, getLanguages,  // current code, switcher metadata
  setLanguage, initI18n,      // change / bootstrap
  applyTranslations,          // re-translate a DOM subtree
  formatDate, formatTime, formatDateTime, // Intl-based, locale-aware
  setupLanguageSwitcher,      // wire the navbar dropdown (idempotent)
  LANGUAGES,                  // registry: { en: {...}, ja: {...} }
} from './i18n.js';
```

### `t(key, params?)`

```js
t('nav.login')                          // → 'Login' / 'ログイン'
t('auth.welcomeBack', { name: 'Alex' }) // → 'Welcome back, Alex!' / 'おかえりなさい、Alexさん！'
```

Fallback chain: **current locale → English → the key string** (never `undefined`).

### `tEsc(key, params?)`

Same, but interpolation values are HTML-escaped. Use whenever the result is
inserted via `innerHTML`. Plain `textContent` assignments can use `t()` directly.

### Data attributes (static HTML)

| Attribute | Sets | Example |
|-----------|------|---------|
| `data-i18n="key"` | `textContent` | `<span data-i18n="sidebar.notes">Notes</span>` |
| `data-i18n-placeholder="key"` | `placeholder` | search inputs |
| `data-i18n-title="key"` | `title` | icon buttons |
| `data-i18n-aria-label="key"` | `aria-label` | icon buttons |
| `data-i18n-html="key"` | `innerHTML` | trusted strings only (e.g. hero headline with a styled `<span>`) |

`applyTranslations(root?)` re-walks any subtree — call it after injecting dynamic
HTML that contains annotated elements.

---

## Adding a new language (e.g. Korean) — 3 steps

### 1. Add the locale object in `frontend/js/i18n.js`

Copy the English object (or just the sections you want to translate — partial
is fine) and translate:

```js
const ko = {
  common: { close: '닫기', cancel: '취소', /* … */ },
  nav:    { login: '로그인', getStarted: '시작하기', /* … */ },
  // sections you skip fall back to English automatically
};
```

### 2. Register it in the `LOCALES` store

```js
const LOCALES = { en, ja, ko };
```

### 3. Register it in the `LANGUAGES` switcher registry

```js
export const LANGUAGES = {
  en: { name: 'English', flag: '🇬🇧' },
  ja: { name: '日本語',  flag: '🇯🇵' },
  ko: { name: '한국어',  flag: '🇰🇷' },
};
```

Done. The switcher picks it up automatically, users can select it, and the
choice persists. Run `npm run test:i18n` in `tests/` to validate your dictionary
(completeness, non-blank strings, `{param}` parity with English).

> **Convention:** the language code is a BCP-47 tag (`en`, `ja`, `ko`). Exact
> browser matches win first, then the primary subtag (`ja-JP` → `ja`).

---

## Adding a new UI string — 2 steps

1. **Add the key to the English dictionary** (base must stay complete):

```js
editor: {
  saveStateSaved: 'Saved to server',   // new
  saveStatePending: 'Saved locally',
},
```

2. **Use it** — static: `data-i18n="editor.saveStateSaved"`,
   dynamic: `t('editor.saveStateSaved')`.

3. *(Optional)* translate it in `ja` (and friends). Until translated, users see
   the English text — never a blank or a raw key unless the key is missing
   everywhere (a useful signal during development).

---

## Testing

```bash
# Dictionary integrity (no browser needed): completeness, blanks, placeholder parity
cd tests && npm run test:i18n

# Full browser verification (needs app running on :5000 + Chrome):
#   backend:  COOKIE_SECRET=… APP_URL=http://localhost:5000 DATABASE_PATH=/tmp/x.db BACKEND_PORT=3100 node dist/index.js
#   frontend: BACKEND_URL=http://127.0.0.1:3100 node server.js
npm run verify:i18n
```

The browser verification covers: default English render, switcher open/selection,
Japanese landing + auth + register + dashboard/sidebar, `localStorage`
persistence across reload, `<html lang>` sync, switch-back, and zero console errors.

---

## Rules & gotchas

1. **Never hardcode user-facing strings in JS** — add a key and call `t()`.
2. **Keep `{placeholders}` identical across locales** — a test enforces parity
   (`{name}` in English must exist in Japanese, etc.).
3. **`data-i18n-html` is for trusted dictionary strings only** — never feed user
   content through it (XSS). User values go through `tEsc()` params or `textContent`.
4. **Dynamically built lists** (sidebar groups, etc.) should re-render on
   `language:changed` — see the listener at the bottom of `sidebar.js`.
5. **Strings set imperatively** (e.g. auth mode titles in `auth.js`) must use
   `t()` so they re-translate when the mode re-renders after a switch.
6. **Bump `CACHE_NAME` in `sw.js`** when you add files (like `i18n.js`) so the
   offline shell picks them up.
7. Japanese text has no spaces between words — don't add padding via strings;
   let CSS handle spacing.

---

## Coverage status

| Area | Coverage |
|------|----------|
| Top navbar (login, get started, search, filters, notifications, user menu) | ✅ EN + JA |
| Language switcher itself | ✅ EN + JA |
| Auth screen (all 4 modes: login/register/forgot/reset, labels, errors, toasts, brand column) | ✅ EN + JA |
| Sidebar (all views, groups, empty states) | ✅ EN + JA |
| Dashboard greeting + KPI labels | ✅ EN + JA |
| Landing hero (headline, subhead, CTAs, trust badges) | ✅ EN + JA |
| Session-expired / sign-out / welcome toasts | ✅ EN + JA |
| Editor, keep-modal, popovers, import/export dialogs | ⬜ English only — add keys per the recipe above as needed |

The remaining English-only areas use the same fallback contract, so translating
them later requires zero code changes — only dictionary entries.

---

## Screenshots

| | |
|---|---|
| ![Language switcher](../screenshots/i18n-language-switcher.png) | ![Japanese landing](../screenshots/i18n-landing-japanese.png) |
| ![Japanese auth](../screenshots/i18n-auth-japanese.png) | ![English landing](../screenshots/i18n-landing-english.png) |