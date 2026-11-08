# ADR 007: Offline-First Sync Protocol (Mobile)

**Status:** Accepted
**Date:** 2024-01-22
**Deciders:** Mobile Team, Backend Team
**Technical Story:** Mobile sync architecture

## Context

Mobile offline requirements:
- Immediate local reads/writes (no spinner on note open)
- Durable writes: survive app kill, OS reclaim, device restart
- Conflict detection: concurrent edits on multiple devices
- Conflict resolution: user chooses (Keep Mine / Use Server)
- Idempotent creates: replay safe on retry
- Ordering: dependencies respected (folder before memo)
- No silent data loss: every conflict surfaced

## Decision

**SQLite Local-First + Durable Outbox + FIFO Push/Pull Sync** with:
- Local `expo-sqlite` mirrors server schema (subset)
- Outbox table: every mutation → local transaction + outbox insert (atomic)
- Client-generated UUIDs (`clientId`) for idempotent creates
- Optimistic concurrency: `version` sent on update, 409 = conflict
- Conflict parking: 409 responses stored locally, UI prompts resolution
- Sync engine: `push outbox (FIFO)` → `pull workspace (paginated)` → `reconcile`
- Background: best-effort via `expo-task-manager` + `expo-background-fetch` (OS-limited)
- Reminders: local scheduling + server reconciliation

## Consequences

### Positive
- **Zero-latency UX**: Local DB = instant reads/writes
- **Durability**: Writes hit local SQLite + outbox in single transaction
- **No silent overwrites**: 409 conflicts parked for explicit resolution
- **Idempotency**: `clientId` on create → safe retry after crash/restart
- **Network resilience**: Outbox persists across process death
- **Server authoritative**: Shared workspace state = server truth

### Negative
- **Complexity**: Sync engine is most complex mobile component
- **Conflict UX**: Requires user intervention (can't auto-merge text)
- **Background limits**: iOS/Android restrict background execution (no guaranteed sync)
- **Schema migration**: Local DB migrations must be backward-compatible with server
- **Storage growth**: Outbox + versions + attachments need cleanup policy

### Neutral
- **Pull is paginated**: 100 notes/page, full reconciliation periodic
- **Deletion = tombstone**: Soft delete synced; hard delete after trash empty
- **Attachment upload**: Queued after note create (dependency ordering)
- **Version coalescing**: Server coalesces rapid edits (5-min window)

## Sync Contract (Per Entity)

Every synced entity defines:
| Property | Description |
|----------|-------------|
| Stable IDs | `clientId` (mobile) ↔ `id` (server) mapping |
| Idempotency | Create: `clientId` unique per workspace; Update: `version` check |
| Mutation Order | Outbox FIFO; dependencies (folder→memo) encoded in payload |
| Conflict Policy | 409 on version mismatch → park → user resolves |
| Deletion | Soft delete (`deletedAt`) synced; hard delete via trash empty |
| Retryable Errors | 408, 429, 5xx → exponential backoff (max 5 retries) |
| Terminal Errors | 400, 401, 403, 404, 413, 415 → park, show error |
| Account Isolation | Local DB scoped by `serverUrl` + `userId` |
| Local Migration | Versioned SQL migrations run on app startup |

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| CRDTs (Yjs, Automerge) | Auto-merge, no conflicts | Complex, large bundle, overkill for notes | Text CRDTs still need intent for checklists |
| Operational Transform | Real-time collab | Server-centric, complex, not offline-first | Different problem |
| Last-Write-Wins | Simple | Silent data loss | Unacceptable for notes |
| Server-only (no offline) | Simple | Unusable offline | Core requirement |
| Background Sync API | Native browser API | Not available in React Native / Expo | Platform limitation |

## Implementation Notes

- `mobile-apps/features/sync/outbox.ts`: Outbox CRUD + status transitions
- `mobile-apps/features/sync/sync-engine.ts`: Push/pull orchestration
- `mobile-apps/features/sync/conflict-resolver.ts`: UI for Keep Mine / Use Server
- `mobile-apps/services/api/contracts.ts`: Zod schemas shared with backend
- `mobile-apps/services/db/migrations/`: Local schema versioning
- Server: `memo.service.ts` handles `clientId` idempotency + version check

## References

- [Sync Contract Specification](../sync-contract.md)
- [Mobile Architecture](../mobile-architecture.md)
- [Conflict Resolution UX](../guides/conflict-resolution.md)