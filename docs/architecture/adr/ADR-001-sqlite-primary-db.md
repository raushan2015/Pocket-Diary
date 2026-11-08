# ADR 001: SQLite as Primary Database

**Status:** Accepted
**Date:** 2024-01-15
**Deciders:** Backend Team
**Technical Story:** Initial technology selection

## Context

Pocket Diary is a self-hosted notes application targeting personal users and small teams. Key requirements:
- Zero-configuration deployment (Docker Compose)
- Single binary/container for ease of operations
- Support for thousands of notes per workspace
- ACID transactions for data integrity
- Full-text search capability
- Embedded in application container (no external dependencies)

## Decision

Use **SQLite (better-sqlite3)** as the primary database with **WAL mode** enabled, accessed via **Drizzle ORM** for type-safe queries and migrations.

## Consequences

### Positive
- Zero external dependencies: runs in-container, no separate DB server to manage
- Simplicity: single file backup/restore, easy disaster recovery
- Performance: WAL mode handles concurrent reads well; thousands of notes query in <10ms
- Portability: database file is the backup; copy it anywhere
- Cost: no managed DB costs for self-hosters
- Drizzle ORM provides type safety, migration management, and schema-as-code

### Negative
- **No horizontal scaling**: Cannot run multiple app replicas against same DB file (SQLITE_BUSY locks)
- **Vertical scaling only**: Limited to single-node CPU/RAM
- **No built-in replication**: Requires application-level backup/replication strategy
- **Connection pooling limited**: better-sqlite3 is synchronous; not suitable for high-concurrency connection pools

### Neutral
- Migration path to PostgreSQL exists via Drizzle adapter swap (documented in ARCH-02)
- Attachments stored on filesystem (not in DB) — avoids BLOB bloat

## Alternatives Considered

| Alternative | Pros | Cons | Why Not Chosen |
|-------------|------|------|----------------|
| PostgreSQL | Horizontal scaling, mature ecosystem, replication | External dependency, more complex deployment, overkill for single-user/small-team | Adds operational burden for self-hosters |
| MySQL/MariaDB | Similar to PostgreSQL | Same operational complexity | Same reasoning |
| IndexedDB (browser-only) | Zero backend | No server-side auth, no multi-device sync, no shared workspaces | Doesn't meet product requirements |
| Redis + persistence | Fast, supports pub/sub | Not a primary document store, data modeling mismatch | Wrong tool for relational note data |

## Implementation Notes

- WAL mode enabled via PRAGMA in database initialization
- Drizzle migrations in `backend/src/db/migrate.ts` — versioned, immutable
- Backup scheduler runs `sqlite3 .backup` for consistent snapshots
- `BACKUP_REPLICATION_DIR` env var for off-host replication
- Maximum practical scale: ~10k notes, ~5 concurrent users per workspace before considering PostgreSQL migration

## References

- [SQLite WAL Mode Documentation](https://www.sqlite.org/wal.html)
- [Drizzle ORM SQLite Adapter](https://orm.drizzle.team/docs/get-started-sqlite)
- [Operational Limits (ARCH-02)](./ADR-002-operational-limits.md)