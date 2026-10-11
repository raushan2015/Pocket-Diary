import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { folders, type Folder } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';

export class FolderNotFoundError extends Error {
  statusCode = 404;
  constructor(message = 'Folder not found') {
    super(message);
    this.name = 'FolderNotFoundError';
  }
}

export function listFolders(
  dbCtx: DatabaseContext,
  workspaceId: string
): Folder[] {
  return dbCtx.db
    .select()
    .from(folders)
    .where(eq(folders.workspaceId, workspaceId))
    .orderBy(folders.name)
    .all();
}

export function createFolder(
  dbCtx: DatabaseContext,
  workspaceId: string,
  data: { name: string; parentId?: string | null }
): Folder {
  const name = data.name?.trim();
  if (!name) {
    throw new Error('Folder name is required');
  }

  const folderId = crypto.randomUUID();
  const now = Date.now();

  dbCtx.db.insert(folders).values({
    id: folderId,
    workspaceId,
    name,
    parentId: data.parentId ?? null,
    createdAt: now,
    updatedAt: now,
  }).run();

  const created = dbCtx.db.select().from(folders).where(eq(folders.id, folderId)).get();
  if (!created) {
    throw new Error('Failed to create folder');
  }
  return created;
}

export function updateFolder(
  dbCtx: DatabaseContext,
  folderId: string,
  workspaceId: string,
  data: { name?: string; parentId?: string | null }
): Folder {
  const existing = dbCtx.db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
    .get();

  if (!existing) {
    throw new FolderNotFoundError();
  }

  const newName = data.name !== undefined ? data.name.trim() : existing.name;
  if (!newName) {
    throw new Error('Folder name cannot be empty');
  }

  const now = Date.now();
  dbCtx.db.update(folders)
    .set({
      name: newName,
      parentId: data.parentId !== undefined ? data.parentId : existing.parentId,
      updatedAt: now,
    })
    .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
    .run();

  return dbCtx.db.select().from(folders).where(eq(folders.id, folderId)).get()!;
}

export function deleteFolder(
  dbCtx: DatabaseContext,
  folderId: string,
  workspaceId: string
): void {
  const existing = dbCtx.db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
    .get();

  if (!existing) {
    throw new FolderNotFoundError();
  }

  dbCtx.db
    .delete(folders)
    .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
    .run();
}
