import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import {
  memos,
  categories,
  tags,
  memoTags,
  memoVersions,
  folders,
  type Category,
  type Tag,
  type Folder,
} from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';
import {
  VALID_PRIORITIES,
  VALID_STATUSES,
  type MemoPriority,
  type MemoStatus,
  listMemos,
} from './memo.service.js';

export interface LocalCategoryInput {
  name: string;
  color?: string | null;
  icon?: string | null;
}

export interface LocalMemoInput {
  localId?: string;
  id?: string;
  title?: string;
  content?: string;
  priority?: string;
  status?: string;
  isFavorite?: boolean;
  isPinned?: boolean;
  category?: string | null;
  categoryId?: string | null;
  tags?: string[];
  dueDate?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface ImportLocalPayload {
  workspaceId: string;
  memos?: LocalMemoInput[];
  categories?: (LocalCategoryInput | string)[];
  tags?: string[];
}

export interface ImportResult {
  success: boolean;
  importedMemos: number;
  importedCategories: number;
  importedTags: number;
}

export interface ExportData {
  workspaceId: string;
  exportedAt: number;
  categories: Category[];
  tags: Tag[];
  folders: Folder[];
  memos: any[];
}

export function importLocalData(
  dbCtx: DatabaseContext,
  userId: string,
  payload: ImportLocalPayload
): ImportResult {
  const { db } = dbCtx;
  const { workspaceId, memos: rawMemos = [], categories: rawCategories = [], tags: rawTags = [] } = payload;

  if (!workspaceId) {
    throw new Error('workspaceId is required for migration');
  }

  const now = Date.now();
  let importedCategories = 0;
  let importedTags = 0;
  let importedMemos = 0;

  db.transaction((tx) => {
    // 1. Build lookup for existing categories in workspace
    const existingCategories = tx
      .select()
      .from(categories)
      .where(eq(categories.workspaceId, workspaceId))
      .all();

    const categoryNameToId = new Map<string, string>();
    for (const c of existingCategories) {
      categoryNameToId.set(c.name.toLowerCase(), c.id);
    }

    // Process categories from payload
    for (const cat of rawCategories) {
      const catName = typeof cat === 'string' ? cat.trim() : cat?.name?.trim();
      if (!catName) continue;
      const lower = catName.toLowerCase();

      if (!categoryNameToId.has(lower)) {
        const catId = crypto.randomUUID();
        const color = typeof cat === 'object' && cat ? cat.color ?? null : null;
        const icon = typeof cat === 'object' && cat ? cat.icon ?? null : null;

        tx.insert(categories).values({
          id: catId,
          workspaceId,
          name: catName,
          color,
          icon,
          createdAt: now,
        }).run();

        categoryNameToId.set(lower, catId);
        importedCategories++;
      }
    }

    // 2. Build lookup for existing tags in workspace
    const existingTags = tx
      .select()
      .from(tags)
      .where(eq(tags.workspaceId, workspaceId))
      .all();

    const tagNameToId = new Map<string, string>();
    for (const t of existingTags) {
      tagNameToId.set(t.name.toLowerCase(), t.id);
    }

    // Also collect tags present in rawTags + individual memos
    const allTagNames = new Set<string>();
    for (const t of rawTags) {
      if (t && typeof t === 'string' && t.trim()) {
        allTagNames.add(t.trim());
      }
    }
    for (const m of rawMemos) {
      if (Array.isArray(m.tags)) {
        for (const t of m.tags) {
          if (t && typeof t === 'string' && t.trim()) {
            allTagNames.add(t.trim());
          }
        }
      }
    }

    for (const tagName of allTagNames) {
      const lower = tagName.toLowerCase();
      if (!tagNameToId.has(lower)) {
        const tagId = crypto.randomUUID();
        tx.insert(tags).values({
          id: tagId,
          workspaceId,
          name: tagName,
          createdAt: now,
        }).run();

        tagNameToId.set(lower, tagId);
        importedTags++;
      }
    }

    // 3. Process memos
    for (const m of rawMemos) {
      const memoId = crypto.randomUUID();
      const createdAt = m.createdAt || now;
      const updatedAt = m.updatedAt || createdAt;

      // Resolve category
      let categoryId: string | null = null;
      if (m.categoryId && existingCategories.some((c) => c.id === m.categoryId)) {
        categoryId = m.categoryId;
      } else if (m.category) {
        const lowerCat = m.category.trim().toLowerCase();
        if (categoryNameToId.has(lowerCat)) {
          categoryId = categoryNameToId.get(lowerCat)!;
        } else {
          // Create on the fly if not in category list
          const newCatId = crypto.randomUUID();
          tx.insert(categories).values({
            id: newCatId,
            workspaceId,
            name: m.category.trim(),
            color: null,
            icon: null,
            createdAt: now,
          }).run();
          categoryNameToId.set(lowerCat, newCatId);
          importedCategories++;
          categoryId = newCatId;
        }
      }

      // Priority & status validation
      const priority: MemoPriority =
        m.priority && VALID_PRIORITIES.includes(m.priority as MemoPriority)
          ? (m.priority as MemoPriority)
          : 'medium';

      const status: MemoStatus =
        m.status && VALID_STATUSES.includes(m.status as MemoStatus)
          ? (m.status as MemoStatus)
          : 'pending';

      const title = m.title ?? '';
      const content = m.content ?? '';

      // Insert memo
      tx.insert(memos).values({
        id: memoId,
        workspaceId,
        folderId: null,
        categoryId,
        title,
        content,
        priority,
        status,
        isFavorite: m.isFavorite ? 1 : 0,
        isPinned: m.isPinned ? 1 : 0,
        dueDate: m.dueDate ?? null,
        version: 1,
        createdBy: userId,
        createdAt,
        updatedAt,
        deletedAt: null,
      }).run();

      // Associate tags
      if (Array.isArray(m.tags)) {
        for (const t of m.tags) {
          const lower = String(t).trim().toLowerCase();
          const tagId = tagNameToId.get(lower);
          if (tagId) {
            tx.insert(memoTags).values({
              memoId,
              tagId,
            }).run();
          }
        }
      }

      // Snapshot version 1
      tx.insert(memoVersions).values({
        id: crypto.randomUUID(),
        memoId,
        versionNumber: 1,
        title,
        content,
        changedBy: userId,
        createdAt,
      }).run();

      importedMemos++;
    }
  });

  return {
    success: true,
    importedMemos,
    importedCategories,
    importedTags,
  };
}

export function exportWorkspaceData(
  dbCtx: DatabaseContext,
  workspaceId: string
): ExportData {
  const { db } = dbCtx;

  const workspaceCategories = db
    .select()
    .from(categories)
    .where(eq(categories.workspaceId, workspaceId))
    .all();

  const workspaceTags = db
    .select()
    .from(tags)
    .where(eq(tags.workspaceId, workspaceId))
    .all();

  const workspaceFolders = db
    .select()
    .from(folders)
    .where(eq(folders.workspaceId, workspaceId))
    .all();

  // A backup export must include Trash entries as well as active memos.
  const { memos: workspaceMemos } = listMemos(dbCtx, {
    workspaceId,
    includeDeleted: true,
    limit: 100000,
  });

  return {
    workspaceId,
    exportedAt: Date.now(),
    categories: workspaceCategories,
    tags: workspaceTags,
    folders: workspaceFolders,
    memos: workspaceMemos,
  };
}
