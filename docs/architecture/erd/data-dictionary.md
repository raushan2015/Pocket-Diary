# Pocket Diary - Data Dictionary

Generated from Drizzle ORM schema (`backend/src/db/schema.ts`)

| Table | Column | Type | Constraints | Description |
|-------|--------|------|-------------|-------------|
| users | id | text | | UUID, primary key |
| users | email | text | | Unique, not null |
| users | passwordHash | text | | Argon2 hash, not null |
| users | name | text | | Display name, not null |
| users | avatarUrl | text | | Optional profile image URL |
| users | timezone | text | | IANA timezone, default UTC |
| users | status | text | | active | suspended | pending_verification |
| users | isInstanceAdmin | integer | | First registered user flag (0/1) |
| users | createdAt | integer | | Unix epoch ms |
| users | updatedAt | integer | | Unix epoch ms |
| sessions | id | text | | SHA-256 hash of session token (PK) |
| sessions | publicId | text | | Opaque device identifier for revocation |
| sessions | userId | text | | FK → users.id (cascade) |
| workspaces | id | text | | UUID, primary key |
| workspaces | name | text | | Workspace name, not null |
| workspaces | slug | text | | URL-safe unique identifier |
| workspaces | ownerId | text | | FK → users.id, not null |
| workspaces | createdAt | integer | | Unix epoch ms |
| workspaces | updatedAt | integer | | Unix epoch ms |
| workspace_members | id | text | | UUID, primary key |
| workspace_members | workspaceId | text | | FK → workspaces.id (cascade) |
| folders | id | text | | UUID, primary key |
| folders | workspaceId | text | | FK → workspaces.id (cascade) |
| categories | id | text | | UUID, primary key |
| categories | workspaceId | text | | FK → workspaces.id (cascade) |
| tags | id | text | | UUID, primary key |
| tags | workspaceId | text | | FK → workspaces.id (cascade) |
| memos | id | text | | UUID, primary key |
| memos | workspaceId | text | | FK → workspaces.id (cascade) |
| memo_tags | memoId | text | | FK → memos.id (cascade, PK part 1) |
| memo_versions | id | text | | UUID, primary key |
| memo_versions | memoId | text | | FK → memos.id (cascade) |
| attachments | id | text | | UUID, primary key |
| attachments | memoId | text | | FK → memos.id (cascade) |
| notifications | id | text | | UUID, primary key |
| notifications | userId | text | | FK → users.id (cascade) |
| push_subscriptions | id | text | | UUID, primary key |
| push_subscriptions | userId | text | | FK → users.id (cascade) |
| workspace_invites | id | text | | UUID, primary key |
| workspace_invites | workspaceId | text | | FK → workspaces.id (cascade) |
| password_resets | id | text | | UUID, primary key |
| password_resets | userId | text | | FK → users.id (cascade) |