import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { tags, type Tag } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';

export class TagNotFoundError extends Error {
  statusCode = 404;
  constructor(message = 'Tag not found') {
    super(message);
    this.name = 'TagNotFoundError';
  }
}

export function listTags(
  dbCtx: DatabaseContext,
  workspaceId: string
): Tag[] {
  return dbCtx.db
    .select()
    .from(tags)
    .where(eq(tags.workspaceId, workspaceId))
    .orderBy(tags.name)
    .all();
}

export function createTag(
  dbCtx: DatabaseContext,
  workspaceId: string,
  name: string
): Tag {
  const trimmed = name?.trim();
  if (!trimmed) {
    throw new Error('Tag name is required');
  }

  // Return existing tag if already present
  const existing = dbCtx.db
    .select()
    .from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, trimmed)))
    .get();

  if (existing) {
    return existing;
  }

  const tagId = crypto.randomUUID();
  const now = Date.now();

  dbCtx.db.insert(tags).values({
    id: tagId,
    workspaceId,
    name: trimmed,
    createdAt: now,
  }).run();

  const created = dbCtx.db.select().from(tags).where(eq(tags.id, tagId)).get();
  if (!created) {
    throw new Error('Failed to create tag');
  }
  return created;
}


export function renameTag(dbCtx: DatabaseContext, tagId: string, workspaceId: string, name: string): Tag {
  const trimmed = String(name || '').trim().replace(/^[#\s]+/, '').toLowerCase();
  if (!trimmed) throw new Error('Tag name is required');
  const existing = dbCtx.db.select().from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId))).get();
  if (!existing) throw new TagNotFoundError();
  const duplicate = dbCtx.db.select().from(tags)
    .where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, trimmed))).get();
  if (duplicate && duplicate.id !== tagId) throw new Error('A tag with that name already exists');
  // Tag labels are also stored as memo tag strings, so update both representations atomically.
  dbCtx.sqlite.transaction(() => {
    dbCtx.sqlite.prepare('UPDATE tags SET name = ? WHERE id = ? AND workspace_id = ?').run(trimmed, tagId, workspaceId);
  })();
  return dbCtx.db.select().from(tags).where(eq(tags.id, tagId)).get()!;
}

export function deleteTag(
  dbCtx: DatabaseContext,
  tagId: string,
  workspaceId: string
): void {
  const existing = dbCtx.db
    .select()
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId)))
    .get();

  if (!existing) {
    throw new TagNotFoundError();
  }

  dbCtx.db
    .delete(tags)
    .where(and(eq(tags.id, tagId), eq(tags.workspaceId, workspaceId)))
    .run();
}
