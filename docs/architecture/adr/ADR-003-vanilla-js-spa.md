# ADR 003: Vanilla JavaScript SPA (No Frontend Framework)

**Status:** Accepted
**Date:** 2024-01-15
**Deciders:** Frontend Team
**Technical Story:** Frontend technology selection

## Context

Pocket Diary's web client needs to be:
- Fast to load and interact with (Keep-like responsiveness)
- Work offline with Service Worker caching
- No build step complexity for contributors
- Small bundle size (<100KB gzipped)
- Compatible with existing codebase (vanilla JS SPA)

## Decision

**Vanilla JavaScript (ES Modules) Single Page Application** — no React, Vue, Svelte, or other frameworks. Plain HTML, CSS, and JS with:
- ES Modules for dependency management
- Event delegation for UI interactions
- Custom state management (`state.js`, `workspace-data.js`)
- Service Worker (`sw.js`) for offline caching
- Fastify reverse proxy serving frontend + API

## Consequences

### Positive
- **Zero build step**: Edit → Refresh. No Webpack/Vite/Rollup config.
- **Tiny bundle**: ~40KB JS gzipped, ~15KB CSS. Loads in <200ms on 3G.
- **Full control**: No framework abstractions leaking into performance or behavior.
- **Easy onboarding**: Any JS developer can contribute immediately.
- **Long-term stability**: No framework churn, breaking changes, or migration fatigue.
- **Service Worker friendly**: Direct control over caching strategy.

### Negative
- **Manual DOM management**: More boilerplate for complex UIs (mitigated by `memo-renderer.js`, `editor.js` utilities)
- **No reactive state**: Explicit `render()` calls needed (mitigated by centralized `state.js`)
- **No component ecosystem**: Build everything custom (but Keep-like UI is simple)
- **Type safety limited**: JSDoc + TypeScript check on backend only (frontend is plain JS)

### Neutral
- **Framework migration possible later**: If complexity grows, can wrap in React/Vue incrementally
- **Web Components** used for reusable UI bits (e.g., `<keep-modal>`, `<keep-popover>`)

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| React + Vite | Huge ecosystem, reactive, TypeScript | Build step, bundle size (~100KB+), framework churn | Overkill for Keep-like simplicity |
| Vue 3 + Vite | Simpler than React, good DX | Still build step, bundle size, less familiar to team | Same reasoning |
| Svelte | Compile-time, tiny runtime | Build step, smaller ecosystem | Build step adds friction |
| htmx + Go templates | Server-rendered, minimal JS | Doesn't support offline SPA UX | Offline-first is a core requirement |
| Alpine.js | Lightweight, reactive | Still a dependency, limited ecosystem | Vanilla is lighter and we already have it |

## Implementation Notes

- Entry point: `frontend/index.html` + `frontend/js/api.js` (API client)
- State: `state.js` (UI state), `workspace-data.js` (server data cache)
- Navigation: `navigation.js`, `sidebar.js`
- Editor: `editor.js`, `memo-renderer.js`, `markdown.js` (marked.js + DOMPurify)
- Keep-style features: `keep-*.js` modules (capture, modal, labels, DnD, import, drawing, etc.)
- Service Worker: `sw.js` caches static assets + API GET responses
- CSS: `frontend/css/` — tokens, layout, components, editor, auth, attachments

## References

- [Frontend Architecture Doc](../frontend-architecture.md)
- [Service Worker Strategy](../guides/offline-support.md)