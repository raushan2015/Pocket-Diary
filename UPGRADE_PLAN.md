# Pocket Diary — UI & AI Assistant Upgrade Plan

> **Scope**: Modernize the web UI (design system, components, accessibility, performance) and significantly enhance the AI assistant (new providers, capabilities, UX). Target: self-hosted single-instance deployment.

---

## 1. Current State Assessment

### UI Strengths
- Comprehensive design system in `tokens.css` + `components.css` (CSS variables, dark/light themes)
- Google Keep–inspired masonry grid, modal editor, checklist UX, 12-color palette
- i18n (EN/JA) with 113 keys, full parity verified
- Responsive: drawer-based chat, mobile sheets, desktop docked panels

### UI Gaps
- **No component library** — all hand-rolled CSS; hard to maintain consistency
- **No build step** for CSS/JS — no minification, tree-shaking, or bundling
- **Accessibility**: partial (ARIA on some modals), no formal audit baseline
- **Performance**: 180KB `index.html`, no code-splitting, no CSP hardening
- **Design tokens** not in a structured format (JSON/TS) for tooling

### AI Assistant Strengths
- Privacy-first architecture: per-note policy (`blocked`/`current_only`/`search_allowed`), protected passages (salted hashes), two-stage search (local FTS → consented reading)
- BYOK for 4 providers (OpenAI, Gemini, DeepSeek, NVIDIA NIM) with encrypted vault (AES-256-GCM)
- Durable SSE jobs: survive drawer close/refresh, Last-Event-ID replay
- Proposals (note create/update) with optimistic locking, TTL, exactly-once execution
- Thinking levels (auto/low/medium/high) + NVIDIA GLM-5.3 native reasoning

### AI Gaps
- **Only 4 providers** — no Anthropic, Mistral, Cohere, Groq, Ollama, OpenRouter
- **No tool calling** — `provider-types.ts` defines `supportsTools` but adapters don't implement it
- **No RAG beyond search** — can't attach files, browse web, or query external APIs
- **No agentic workflows** — single-turn + streaming only; no multi-step planning
- **Mobile AI** exists but parity unverified (separate codebase in `mobile-apps/`)
- **No eval/observability** — no token usage tracking, latency budgets, or quality gates

---

## 2. UI Upgrade Plan

### Phase 1: Design System & Tooling (Week 1–2)

| Task | Details | Files |
|------|---------|-------|
| **Extract tokens to JSON** | Convert `tokens.css` → `design-tokens.json` (colors, spacing, radii, shadows, typography, z-index). Enables Figma sync, Style Dictionary, and type-safe TS usage. | `frontend/design-tokens.json`, `frontend/tokens.css` (generated) |
| **Add CSS build pipeline** | Vite/ESBuild: minify, autoprefixer, purge unused CSS (PurgeCSS), generate sourcemaps. Output to `frontend/dist/css/`. | `frontend/vite.config.ts`, `frontend/package.json` |
| **Add JS bundling** | ESBuild: bundle `js/*.js` → single `app.[hash].js` + dynamic imports for heavy modules (editor, AI chat). | `frontend/vite.config.ts` |
| **CSP hardening** | Strict CSP: `script-src 'self'`, `style-src 'self' 'unsafe-inline'` (needed for Swagger UI), `connect-src 'self'`, `img-src 'self' data:`. Remove inline scripts from `index.html`. | `backend/src/app.ts` (CSP hook), `frontend/index.html` |
| **Design token TypeScript types** | Generate `design-tokens.d.ts` from JSON for autocomplete in component CSS-in-JS (if adopted) or for runtime theming. | `frontend/types/design-tokens.d.ts` |

### Phase 2: Component Library Migration (Week 2–4)

**Strategy**: Incremental — wrap existing CSS classes as web components (no framework) or adopt a zero-runtime library (Lit, Stencil, or vanilla Web Components). Recommendation: **Lit** — tiny (~5KB), TypeScript-native, works with existing CSS variables.

| Component | Current | Target |
|-----------|---------|--------|
| Buttons | `.btn`, `.btn-primary`, etc. | `<pd-button variant="primary|secondary|outline|ghost" size="sm|md|lg">` |
| Inputs | `.form-input`, `.input-icon-wrapper` | `<pd-input type="text|password|email" label="" error="">` |
| Select | `.filter-select` | `<pd-select>` with keyboard navigation |
| Modal | `.modal-backdrop`, `.modal-card` | `<pd-dialog>` with focus trap, ESC close, portal |
| Dropdown | `.user-dropdown-menu`, `.language-switcher-panel` | `<pd-popover>` with anchor positioning (Floating UI) |
| Toast | `.toast-container` | `<pd-toast>` with queue, auto-dismiss, action buttons |
| Badge | `.badge`, `.badge-*` | `<pd-badge variant="work|study|priority-high|...">` |
| Card | `.memo-card`, `.surface-card` | `<pd-card>` with slots for header/media/footer |
| Avatar | `.user-avatar-circle` | `<pd-avatar src="" fallback="">` |
| Checklist | `.keep-checklist-*` | `<pd-checklist>` with drag-reorder, inline edit |
| Color/theme picker | `.keep-swatches-grid`, `.keep-themes-grid` | `<pd-color-picker>`, `<pd-theme-picker>` |

**Deliverables**:
- `frontend/components/` — Lit components (one per file)
- `frontend/components/index.ts` — barrel export
- Storybook (optional) for visual regression
- Migration guide: replace class-based HTML with components incrementally

### Phase 3: Layout & UX Improvements (Week 3–4)

| Area | Change |
|------|--------|
| **Navbar** | Collapsible on mobile, persistent AI drawer toggle, workspace switcher dropdown, theme toggle, notifications bell |
| **Sidebar** | Resizable (drag handle), collapsible to icons, workspace tree with folder/category nesting, drag-drop reorder |
| **Notes Grid** | Virtualized masonry (IntersectionObserver) for 1000+ notes; preserve 12-color palette; infinite scroll |
| **Editor** | Full-screen by default; split view (edit/preview) with resizable pane; toolbar with keyboard shortcuts overlay (Cmd+/); auto-save indicator |
| **Search** | Cmd+K global search (notes, AI search, actions); fuzzy matching; recent searches |
| **Empty States** | Illustrated empty states for: no notes, no search results, no AI providers, no workspace members |
| **Loading States** | Skeleton loaders for grid, editor, AI chat; progressive image loading for attachments |

### Phase 4: Accessibility & Polish (Week 4–5)

| Task | Standard |
|------|----------|
| **Semantic HTML** | `<main>`, `<nav>`, `<aside>`, `<section>`, `<article>`, proper heading hierarchy |
| **ARIA** | All dialogs: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`; menus: `role="menu"`, `aria-expanded`; live regions for toasts (`aria-live="polite"`) |
| **Keyboard** | Tab order, focus visible (`:focus-visible`), skip links, roving tabindex in menus/grids |
| **Color Contrast** | WCAG AA (4.5:1 text, 3:1 UI) in both themes — audit tokens |
| **Reduced Motion** | `@media (prefers-reduced-motion)` disables transitions/animations |
| **Screen Reader** | Test with NVDA/VoiceOver; announce AI streaming deltas politely |

### Phase 5: Performance & PWA (Week 5)

| Task | Target |
|------|--------|
| **Bundle size** | <100KB JS gzipped (code-split: editor, AI chat, settings lazy-loaded) |
| **LCP** | <2.5s on 3G (preload critical CSS, defer non-critical JS) |
| **CLS** | <0.1 (reserve space for images, font-display: swap) |
| **PWA** | `manifest.json` + Service Worker (already `sw.js`) — add offline note reading, background sync for drafts |
| **Font Optimization** | Self-host Inter; subset; preload; `font-display: swap` |

---

## 3. AI Assistant Upgrade Plan

### Phase 1: Provider Expansion (Week 1–2)

| Provider | Integration Notes |
|----------|-------------------|
| **Anthropic (Claude)** | Native tool use, 200K context, thinking budgets (`thinking: { type: 'enabled', budget_tokens: N }`); add to `registry.ts`, `provider-types.ts`, `PROVIDERS` in `ai-settings.js` |
| **Mistral** | OpenAI-compatible API; tool use via `mistral-large-latest` |
| **Cohere** | Chat + RAG endpoints; `command-r-plus` for tools |
| **Groq** | Ultra-fast inference; OpenAI-compatible; `llama-3.3-70b-versatile` |
| **OpenRouter** | Single key → 100+ models; pass `modelId` as `openrouter/model-name` |
| **Ollama (local)** | `http://host.docker.internal:11434`; no auth; model listing via `/api/tags`; streaming via `/api/chat` |

**Implementation per provider**:
1. Add adapter in `backend/src/services/ai/providers/` (implement `ProviderAdapter`: `chatStream`, `testConnection`, `listModels`, `supportsTools`, `supportsStreaming`)
2. Register in `registry.ts`
3. Add to `provider-types.ts` enum and `PROVIDER_LABELS`
4. Update `ai-settings.js` `PROVIDERS` array with known models
5. Add connection test + model listing (mock in tests)
6. Document in `docs/ai-assistant/README.md`

### Phase 2: Tool Calling & Agentic Capabilities (Week 2–4)

**Backend** (`chat.service.ts`, new `tools.service.ts`):
- Define tool schema (OpenAI-compatible): `type`, `function` (name, description, parameters JSON Schema)
- Built-in tools:
  - `search_notes` — wraps existing `/ai/search` + `/ai/search/approve`
  - `read_note` — requires current-note grant
  - `create_note` — creates proposal → user approves
  - `update_note` — creates proposal → user approves
  - `list_workspaces` / `list_folders` / `list_categories`
  - `web_search` (optional, requires `SEARCH_API_KEY` env)
  - `fetch_url` (optional, safe-fetch with allowlist)
- Tool execution sandbox: timeout, max tokens, no network by default
- Tool result injection into conversation (assistant → tool → assistant)

**Frontend** (`ai-chat.js`):
- Render tool calls as collapsible cards in message stream
- Show tool args/results with syntax highlighting
- Allow user to cancel in-flight tool call
- Thinking indicator for tool execution

**Security**:
- Tools run server-side only; model never executes code
- Each tool validates grants/workspace membership
- Rate limit per conversation (configurable)
- Audit log: `ai_tool_calls` table (tool, args hash, result status, latency)

### Phase 3: RAG & File Attachments (Week 3–4)

| Feature | Implementation |
|---------|----------------|
| **Attach files to chat** | Drag-drop in composer → upload to `/api/v1/attachments` → reference in message via `attachmentIds` |
| **File-aware chat** | Backend extracts text (PDF, DOCX, TXT, MD, code) → chunks → embeddings (optional: local `sentence-transformers` via Python sidecar or remote provider) → vector search (SQLite `vec0` extension or pgvector if migrated) |
| **Citations** | Assistant responses include `[source: note-id]` links; clicking opens note |
| **Context window management** | Sliding window + summarization for long conversations; `maxContextTokens` per provider config |

### Phase 4: Conversation UX & Features (Week 4–5)

| Feature | Details |
|---------|---------|
| **Branching conversations** | Fork from any message → new conversation with shared history |
| **Conversation folders/tags** | Organize chats like notes |
| **Shared conversations** | Generate read-only link (tokenized) for workspace members |
| **Export** | Markdown, PDF, JSON (full transcript + metadata) |
| **Prompt library** | User-saved prompts with variables (`{{note_title}}`, `{{selection}}`) |
| **Model comparison** | Side-by-side: send same prompt to 2+ providers, compare outputs |
| **Token usage dashboard** | Per conversation, per provider, per day/week/month (stored in `ai_usage` table) |
| **Cost estimation** | Show estimated cost per message (based on provider pricing table) |

### Phase 5: Mobile Parity & Sync (Week 5–6)

- Ensure `mobile-apps/` AI chat uses same API contracts
- Offline-first: queue messages locally, sync on reconnect
- Push notifications for completed AI jobs (already have Web Push infra)
- Native share extension → "Send to Pocket Diary AI"

### Phase 6: Observability & Eval (Week 6)

| Component | Purpose |
|-----------|---------|
| **Structured logging** | JSON logs: `requestId`, `provider`, `model`, `tokensIn`, `tokensOut`, `latencyMs`, `toolCalls`, `status` |
| **Metrics endpoint** | `/metrics` (Prometheus) — `ai_requests_total`, `ai_latency_seconds`, `ai_tokens_total`, `ai_errors_total` |
| **Eval harness** | `backend/test/ai-eval.test.ts` — golden-set prompts + expected behaviors (refusal, citation, tool use); run in CI |
| **Quality gates** | Fail CI if: hallucination rate > threshold, tool call success rate < 95%, P95 latency > 10s |

---

## 4. Cross-Cutting Concerns

### Database Migrations
- Add tables: `ai_tool_calls`, `ai_usage`, `ai_conversation_branches`, `ai_prompt_library`, `ai_embeddings` (if RAG)
- Use existing migration pattern (`db/migrate.ts`, idempotent, `PRAGMA user_version`)

### Configuration
- New env vars:
  ```
  AI_ANTHROPIC_ENABLED=true
  AI_MISTRAL_ENABLED=true
  AI_GROQ_ENABLED=true
  AI_OPENROUTER_ENABLED=true
  AI_OLLAMA_BASE_URL=http://host.docker.internal:11434
  SEARCH_API_KEY=... (optional, for web search tool)
  AI_MAX_TOOL_CALLS_PER_TURN=5
  AI_MAX_CONTEXT_TOKENS=128000
  AI_EVAL_ENABLED=false
  ```

### Testing
- **Backend**: Extend `ai-providers.test.ts`, add `ai-tools.test.ts`, `ai-rag.test.ts`
- **Frontend**: Playwright tests for new AI flows (tool calls, file upload, branching)
- **Contract tests**: Ensure mobile/web API compatibility

### Documentation
- Update `docs/ai-assistant/README.md` with new providers, tools, RAG
- Add `docs/architecture/guides/ai-tools-guide.md`
- Update `docs/architecture/guides/i18n-guide.md` for new AI keys

---

## 5. Recommended Sequencing (12-Week Timeline)

```
Weeks 1-2:  UI Design System + Provider Expansion (parallel tracks)
Weeks 2-3:  UI Component Library + Tool Calling Backend
Weeks 3-4:  UI Layout/UX + Tool Calling Frontend + RAG Backend
Weeks 4-5:  UI A11y/Performance + RAG Frontend + Conversation Features
Weeks 5-6:  Mobile Parity + Observability/Eval
Weeks 6-8:  Polish, bug fixes, docs, migration testing
Weeks 8-10: Beta with real API keys (OpenAI, Anthropic, NVIDIA, Ollama)
Weeks 10-12: Release hardening, performance tuning, security review
```

---

## 6. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| **Scope creep** | Strict phase gates; demo at end of each phase; defer "nice-to-have" to v2 |
| **Provider API changes** | Adapter pattern isolates changes; pin model versions in config |
| **SQLite scaling** | RAG embeddings → separate vector DB (Chroma/Weaviate) if needed; document migration path |
| **Mobile divergence** | Shared OpenAPI spec → generated TypeScript client for both web/mobile |
| **Security regressions** | Security review at Week 8; `code-review` skill at max level for AI routes |
| **Design system adoption** | Incremental migration; old CSS classes work alongside components |

---

## 7. Quick Wins (Do First, <1 Week)

1. **Add Anthropic provider** — 2 files (adapter + registry), high user demand
2. **Extract design tokens to JSON** — enables tooling, no visual change
3. **Add CSP headers** — security hardening, no UI change
4. **Virtualize notes grid** — immediate perf win for large workspaces
5. **Keyboard shortcut overlay (Cmd+/)** — discoverability for power users
6. **Token usage logging** — add `ai_usage` table + logging in `chat.service.ts`

---

## 8. File Map for Implementation

### UI
```
frontend/
├── design-tokens.json           # NEW: source of truth
├── vite.config.ts               # NEW: build pipeline
├── components/                  # NEW: Lit components
│   ├── pd-button.ts
│   ├── pd-input.ts
│   ├── pd-select.ts
│   ├── pd-dialog.ts
│   ├── pd-popover.ts
│   ├── pd-toast.ts
│   ├── pd-badge.ts
│   ├── pd-card.ts
│   ├── pd-avatar.ts
│   ├── pd-checklist.ts
│   ├── pd-color-picker.ts
│   └── index.ts
├── css/
│   ├── tokens.css               # GENERATED from JSON
│   └── components.css           # DEPRECATED → components/
├── js/
│   ├── app.ts                   # NEW: entry point (bundled)
│   ├── components-registry.ts   # NEW: define custom elements
│   └── (existing modules lazy-loaded)
└── index.html                   # UPDATED: CSP, module script, preload
```

### AI Backend
```
backend/src/services/ai/
├── providers/
│   ├── anthropic.ts             # NEW
│   ├── mistral.ts               # NEW
│   ├── groq.ts                  # NEW
│   ├── openrouter.ts            # NEW
│   └── ollama.ts                # NEW
├── tools/
│   ├── index.ts                 # NEW: tool registry + execution
│   ├── search-notes.ts
│   ├── read-note.ts
│   ├── create-note.ts
│   ├── update-note.ts
│   ├── list-workspaces.ts
│   ├── web-search.ts            # optional
│   └── fetch-url.ts             # optional
├── registry.ts                  # UPDATED: new providers
├── provider-types.ts            # UPDATED: new ProviderId enum
├── chat.service.ts              # UPDATED: tool calling loop
├── rag.service.ts               # NEW: embeddings + vector search
├── usage.service.ts             # NEW: token tracking + costs
└── eval/
    └── harness.ts               # NEW: eval framework
```

### AI Frontend
```
frontend/js/
├── ai-chat.js                   # UPDATED: tool UI, branching, files
├── ai-tools-renderer.ts         # NEW: renders tool calls/results
├── ai-prompt-library.ts         # NEW: saved prompts UI
└── ai-usage-dashboard.ts        # NEW: token/cost visualization
```

---

## 9. Definition of Done (Per Phase)

| Phase | Criteria |
|-------|----------|
| **Design System** | Tokens in JSON; build runs; CSP passes; Storybook (optional) shows all components |
| **Components** | 5+ pages migrated; no visual regression; a11y audit passes |
| **Providers** | Each new provider: connection test ✓, model list ✓, chat streaming ✓, tools ✓ (where supported) |
| **Tools** | 3+ built-in tools working; tool calls visible in UI; cancel works; audit log written |
| **RAG** | File upload → chat references file; citations link to notes; <5s end-to-end |
| **Conversation Features** | Branch, export, share, prompt library all functional |
| **Observability** | `/metrics` exposes AI metrics; eval suite runs in CI; alerts on P95 latency |

---

## 10. Notes for Implementation

- **Don't rewrite everything at once** — the current CSS/JS works. Migrate incrementally.
- **Keep the privacy model sacred** — every new feature must respect `ai_access` policies and grants.
- **Self-hosted constraints** — no external dependencies for core features; optional features (web search, embeddings) must degrade gracefully.
- **Mobile parity** — API changes must be backward-compatible; mobile app updates can lag but not break.
- **Test with real keys** — mock testing covers logic; live provider behavior (streaming shapes, rate limits, model catalogs) must be verified before release.

---

*Generated: 2026-11-13 | Based on codebase analysis of Pocket Diary (main branch, commit 6f14509)*