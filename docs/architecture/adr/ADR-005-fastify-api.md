# ADR 005: Fastify for API Server

**Status:** Accepted
**Date:** 2024-01-10
**Deciders:** Backend Team
**Technical Story:** Backend framework selection

## Context

API server requirements:
- High performance (low latency, high throughput)
- TypeScript first-class support
- Built-in validation, serialization, OpenAPI
- Plugin ecosystem for auth, rate limiting, CORS, multipart
- Low overhead, minimal abstraction
- Compatible with vanilla JS frontend + Expo mobile

## Decision

**Fastify 5** with TypeScript, using:
- `@fastify/swagger` + `@fastify/swagger-ui` for OpenAPI 3.1 docs
- `@fastify/cookie` for HTTP-only session cookies
- `@fastify/cors` for cross-origin (dev) / credentialed requests
- `@fastify/rate-limit` for global + per-route limiting
- `@fastify/multipart` for attachment uploads
- Drizzle ORM for type-safe database access
- `better-sqlite3` driver (synchronous, fast)

## Consequences

### Positive
- **Performance**: Fastify is one of the fastest Node.js frameworks (~2x Express)
- **TypeScript native**: Full type inference for routes, schemas, hooks
- **Schema-based validation**: AJV compiles schemas to fast validation functions
- **OpenAPI generation**: Single source of truth (route schemas = runtime validation = docs)
- **Plugin architecture**: Clean separation of concerns (auth, rate limit, etc.)
- **Low overhead**: Minimal abstraction, close to raw http module
- **Hooks system**: `onRequest`, `preHandler`, `onSend` for cross-cutting concerns

### Negative
- **Smaller ecosystem**: Fewer middleware/plugins than Express
- **Learning curve**: Different patterns (encapsulation, hooks, decorators)
- **TypeScript strictness**: Requires explicit types for decorators, plugins
- **No built-in ORM**: Drizzle is separate (but preferred)

### Neutral
- **Migration from Express**: Straightforward (similar routing patterns)
- **Compatible with any frontend**: REST + JSON, no framework lock-in

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| Express | Huge ecosystem, familiar | Slower, no built-in validation/OpenAPI, callback-based | Performance & DX |
| Hono | Fast, lightweight, Web Standard APIs | Smaller ecosystem, newer, less middleware | Fastify more mature for full REST API |
| NestJS | Opinionated, DI, decorators, OpenAPI | Heavy, steep learning curve, over-engineering for this scope | Too much ceremony |
| Koa | Modern, async/await, middleware | No built-in validation, smaller plugin ecosystem | Fastify has better built-ins |
| tRPC | End-to-end types, no schema duplication | Requires React/Vue frontend, not REST | Mobile (Expo) needs REST + OpenAPI |

## Implementation Notes

- Route schemas define validation + OpenAPI in one place (`openapi.ts` extensions)
- Auth via `authPlugin` decorator: `request.user` + `request.authenticate()`
- Workspace RBAC enforced in services, not just routes
- Error envelopes: `{ error: string, message: string }` + status code
- Pagination: `page` + `limit` (max 100) on all list endpoints
- Optimistic concurrency: `version` field on memos, 409 on mismatch
- Health check: `/health` (root + `/api/v1/health`)

## References

- [Fastify Documentation](https://fastify.dev/)
- [Fastify TypeScript Guide](https://fastify.dev/docs/v5/Guides/TypeScript/)
- [OpenAPI Generation](./openapi-generation.md)