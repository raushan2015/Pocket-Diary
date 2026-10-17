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

/**
 * Validation error surfaced as HTTP 400 (audit M-6): blank names and invalid
 * parent references previously escaped as plain `Error`s — or as raw SQLite
 * foreign-key failures — and produced HTTP 500s.
 */
export class FolderValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'FolderValidationError';
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

/**
 * Audit M-4: validate a parent folder reference. Previously `parentId` was
 * never checked — a folder could be its own parent, form cycles (hanging any
 * recursive tree walk in the UI), or point at a folder in another workspace
 * (500 via the FK constraint).
 */
function validateParent(
  dbCtx: DatabaseContext,
  workspaceId: string,
  folderId: string | null,
  parentId: string | null
): void {
  if (parentId == null || parentId === '') return;

  if (parentId === folderId) {
    throw new FolderValidationError('A folder cannot be its own parent');
  }

  const parent = dbCtx.db
    .select()
    .from(folders)
    .where(and(eq(folders.id, parentId), eq(folders.workspaceId, workspaceId)))
    .get();
  if (!parent) {
    throw new FolderValidationError('Parent folder not found in this workspace');
  }

  // Cycle check: walk up from the proposed parent; reaching this folder
  // means the hierarchy would loop.
  let cursor: typeof parent | undefined = parent;
  const seen = new Set<string>();
  while (cursor && cursor.parentId) {
    if (cursor.parentId === folderId) {
      throw new FolderValidationError('Folder hierarchy cannot contain cycles');
    }
    if (seen.has(cursor.parentId)) break; // defensive: pre-existing cycle
    seen.add(cursor.parentId);
    cursor = dbCtx.db
      .select()
      .from(folders)
      .where(and(eq(folders.id, cursor.parentId!), eq(folders.workspaceId, workspaceId)))
      .get();
  }
}

export function createFolder(
  dbCtx: DatabaseContext,
  workspaceId: string,
  data: { name: string; parentId?: string | null }
): Folder {
  const name = data.name?.trim();
  if (!name) {
    // Audit M-6: typed 400 instead of a plain Error (which surfaced as 500).
    throw new FolderValidationError('Folder name is required');
  }

  validateParent(dbCtx, workspaceId, null, data.parentId ?? null);

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
    throw new FolderValidationError('Folder name cannot be empty');
  }

  const newParentId = data.parentId !== undefined ? (data.parentId || null) : existing.parentId;
  validateParent(dbCtx, workspaceId, folderId, newParentId);

  const now = Date.now();
  dbCtx.db.update(folders)
    .set({
      name: newName,
      parentId: newParentId,
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

  // Audit M-5: subfolders survive their parent's deletion — their parent
  // link is cleared instead of cascade-deleting whole folder subtrees (the
  // raw SQL schema used ON DELETE CASCADE while the Drizzle schema had no
  // FK, and the silent data loss surprised both).
  dbCtx.db
    .update(folders)
    .set({ parentId: null, updatedAt: Date.now() })
    .where(and(eq(folders.parentId, folderId), eq(folders.workspaceId, workspaceId)))
    .run();

  dbCtx.db
    .delete(folders)
    .where(and(eq(folders.id, folderId), eq(folders.workspaceId, workspaceId)))
    .run();
}
