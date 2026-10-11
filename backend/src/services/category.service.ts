import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { categories, type Category } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';

export class CategoryNotFoundError extends Error {
  statusCode = 404;
  constructor(message = 'Category not found') {
    super(message);
    this.name = 'CategoryNotFoundError';
  }
}

export function listCategories(
  dbCtx: DatabaseContext,
  workspaceId: string
): Category[] {
  return dbCtx.db
    .select()
    .from(categories)
    .where(eq(categories.workspaceId, workspaceId))
    .orderBy(categories.name)
    .all();
}

export function createCategory(
  dbCtx: DatabaseContext,
  workspaceId: string,
  data: { name: string; color?: string | null; icon?: string | null }
): Category {
  const name = data.name?.trim();
  if (!name) {
    throw new Error('Category name is required');
  }

  const categoryId = crypto.randomUUID();
  const now = Date.now();

  dbCtx.db.insert(categories).values({
    id: categoryId,
    workspaceId,
    name,
    color: data.color ?? null,
    icon: data.icon ?? null,
    createdAt: now,
  }).run();

  const created = dbCtx.db.select().from(categories).where(eq(categories.id, categoryId)).get();
  if (!created) {
    throw new Error('Failed to create category');
  }
  return created;
}

export function updateCategory(
  dbCtx: DatabaseContext,
  categoryId: string,
  workspaceId: string,
  data: { name?: string; color?: string | null; icon?: string | null }
): Category {
  const existing = dbCtx.db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)))
    .get();

  if (!existing) {
    throw new CategoryNotFoundError();
  }

  const newName = data.name !== undefined ? data.name.trim() : existing.name;
  if (!newName) {
    throw new Error('Category name cannot be empty');
  }

  dbCtx.db.update(categories)
    .set({
      name: newName,
      color: data.color !== undefined ? data.color : existing.color,
      icon: data.icon !== undefined ? data.icon : existing.icon,
    })
    .where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)))
    .run();

  return dbCtx.db.select().from(categories).where(eq(categories.id, categoryId)).get()!;
}

export function deleteCategory(
  dbCtx: DatabaseContext,
  categoryId: string,
  workspaceId: string
): void {
  const existing = dbCtx.db
    .select()
    .from(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)))
    .get();

  if (!existing) {
    throw new CategoryNotFoundError();
  }

  dbCtx.db
    .delete(categories)
    .where(and(eq(categories.id, categoryId), eq(categories.workspaceId, workspaceId)))
    .run();
}
