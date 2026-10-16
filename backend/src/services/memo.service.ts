import crypto from 'node:crypto';
import { eq, and, sql, inArray, isNotNull } from 'drizzle-orm';
import {
  memos,
  categories,
  tags,
  memoTags,
  memoVersions,
  type Memo,
  type Category,
  type Tag,
  type MemoVersion,
} from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';

export const VALID_STATUSES = ['draft', 'pending', 'in_progress', 'completed', 'archived'] as const;
export const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

export type MemoStatus = typeof VALID_STATUSES[number];
export type MemoPriority = typeof VALID_PRIORITIES[number];

export class MemoNotFoundError extends Error {
  statusCode = 404;
  constructor(message = 'Memo not found') {
    super(message);
    this.name = 'MemoNotFoundError';
  }
}

export class MemoConflictError extends Error {
  statusCode = 409;
  currentVersion: number;
  constructor(message: string, currentVersion: number) {
    super(message);
    this.name = 'MemoConflictError';
    this.currentVersion = currentVersion;
  }
}

export class ValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const VALID_MEMO_COLORS = [
  'default',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'darkblue',
  'purple',
  'pink',
  'brown',
  'gray',
] as const;

export const VALID_THEMES = [
  'default',
  'none',
  'grocery',
  'food',
  'music',
  'recipes',
  'notes',
  'places',
  'travel',
  'celebration',
] as const;

export interface ChecklistItem {
  id: string;
  text: string;
  /** Whether the item is done. Frontend writers use `checked`; legacy payloads use `completed`. */
  checked?: boolean;
  completed?: boolean;
  sortOrder?: number;
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
}

export interface MemoAttachmentDto {
  id: string;
  memoId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: number;
  url: string;
}

export interface FormattedMemo {
  id: string;
  workspaceId: string;
  folderId: string | null;
  title: string;
  content: string;
  color: string;
  theme: string;
  priority: MemoPriority;
  status: MemoStatus;
  isFavorite: boolean;
  isPinned: boolean;
  isArchived: boolean;
  noteType: string;
  sortOrder: number;
  dueDate: number | null;
  reminderTime: number | null;
  reminderLocation: string | null;
  collaborators: string[];
  checklistData: ChecklistItem[];
  linkPreviews: LinkPreview[];
  attachments: MemoAttachmentDto[];
  categoryId: string | null;
  category: { id: string; name: string; color: string | null; icon: string | null } | null;
  tags: string[];
  version: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ListMemosOptions {
  workspaceId: string;
  status?: string;
  priority?: string;
  categoryId?: string;
  tagId?: string;
  tagName?: string;
  folderId?: string;
  isFavorite?: boolean | string;
  isPinned?: boolean | string;
  isArchived?: boolean | string;
  hasReminder?: boolean | string;
  includeDeleted?: boolean | string;
  deletedOnly?: boolean | string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CreateMemoInput {
  workspaceId: string;
  folderId?: string | null;
  categoryId?: string | null;
  title?: string;
  content?: string;
  color?: string;
  theme?: string;
  priority?: MemoPriority;
  status?: MemoStatus;
  isFavorite?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  noteType?: string;
  sortOrder?: number;
  dueDate?: number | null;
  reminderTime?: number | null;
  reminderLocation?: string | null;
  collaborators?: string[];
  checklistData?: ChecklistItem[];
  linkPreviews?: LinkPreview[];
  tags?: string[];
}

export interface UpdateMemoInput {
  folderId?: string | null;
  categoryId?: string | null;
  title?: string;
  content?: string;
  color?: string;
  theme?: string;
  priority?: MemoPriority;
  status?: MemoStatus;
  isFavorite?: boolean;
  isPinned?: boolean;
  isArchived?: boolean;
  noteType?: string;
  sortOrder?: number;
  dueDate?: number | null;
  reminderTime?: number | null;
  reminderLocation?: string | null;
  collaborators?: string[];
  checklistData?: ChecklistItem[];
  linkPreviews?: LinkPreview[];
  tags?: string[];
  version?: number;
}

/**
 * Builds a safe SQLite FTS5 search query from user input.
 * Strips operators and punctuation that cause FTS5 parse errors,
 * and formats each search term with prefix matching (e.g. "term"*).
 */
export function buildFtsQuery(searchTerm: string): string {
  if (!searchTerm || typeof searchTerm !== 'string') return '';
  const cleaned = searchTerm.replace(/["*^:()\-]/g, ' ').trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' ');
}

/**
 * Hydrates an array of raw memo rows with categories and tags.
 */
function hydrateMemos(
  sqlite: DatabaseContext['sqlite'],
  rawMemos: any[]
): FormattedMemo[] {
  if (rawMemos.length === 0) return [];

  const memoIds = rawMemos.map((m) => m.id);
  const categoryIds = rawMemos
    .map((m) => m.category_id || m.categoryId)
    .filter(Boolean);

  // Fetch categories
  const categoryMap = new Map<string, { id: string; name: string; color: string | null; icon: string | null }>();
  if (categoryIds.length > 0) {
    const placeholders = categoryIds.map(() => '?').join(',');
    const catRows = sqlite
      .prepare(`SELECT id, name, color, icon FROM categories WHERE id IN (${placeholders})`)
      .all(...categoryIds) as any[];
    for (const c of catRows) {
      categoryMap.set(c.id, { id: c.id, name: c.name, color: c.color, icon: c.icon });
    }
  }

  // Fetch tags for memos
  const tagsMap = new Map<string, string[]>();
  if (memoIds.length > 0) {
    const placeholders = memoIds.map(() => '?').join(',');
    const tagRows = sqlite
      .prepare(`
        SELECT mt.memo_id, t.name
        FROM memo_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.memo_id IN (${placeholders})
        ORDER BY t.name ASC
      `)
      .all(...memoIds) as any[];

    for (const tr of tagRows) {
      if (!tagsMap.has(tr.memo_id)) {
        tagsMap.set(tr.memo_id, []);
      }
      tagsMap.get(tr.memo_id)!.push(tr.name);
    }
  }

  // Fetch attachments for memos
  const attachmentsMap = new Map<string, MemoAttachmentDto[]>();
  if (memoIds.length > 0) {
    const placeholders = memoIds.map(() => '?').join(',');
    const attRows = sqlite
      .prepare(`
        SELECT id, memo_id, file_name, file_size, mime_type, created_at
        FROM attachments
        WHERE memo_id IN (${placeholders})
        ORDER BY created_at ASC, id ASC
      `)
      .all(...memoIds) as any[];

    for (const ar of attRows) {
      if (!attachmentsMap.has(ar.memo_id)) {
        attachmentsMap.set(ar.memo_id, []);
      }
      attachmentsMap.get(ar.memo_id)!.push({
        id: ar.id,
        memoId: ar.memo_id,
        fileName: ar.file_name,
        fileSize: ar.file_size,
        mimeType: ar.mime_type,
        createdAt: ar.created_at,
        url: `/api/v1/attachments/${encodeURIComponent(ar.id)}/file`,
      });
    }
  }

  const parseJson = (val: any, fallback: any) => {
    if (!val) return fallback;
    if (typeof val !== 'string') return Array.isArray(val) ? val : fallback;
    try {
      const parsed = JSON.parse(val);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  };

  return rawMemos.map((m) => {
    const catId = m.category_id !== undefined ? m.category_id : m.categoryId;
    const isArchived = Boolean(
      m.is_archived !== undefined
        ? m.is_archived
        : m.isArchived !== undefined
        ? m.isArchived
        : (m.status || '') === 'archived'
    );
    return {
      id: m.id,
      workspaceId: m.workspace_id !== undefined ? m.workspace_id : m.workspaceId,
      folderId: m.folder_id !== undefined ? m.folder_id : m.folderId,
      title: m.title ?? '',
      content: m.content ?? '',
      color: m.color ?? 'default',
      theme: m.theme ?? 'default',
      priority: (m.priority ?? 'medium') as MemoPriority,
      status: (m.status ?? 'pending') as MemoStatus,
      isFavorite: Boolean(m.is_favorite !== undefined ? m.is_favorite : m.isFavorite),
      isPinned: Boolean(m.is_pinned !== undefined ? m.is_pinned : m.isPinned),
      isArchived,
      noteType: m.note_type !== undefined ? m.note_type : (m.noteType || 'text'),
      sortOrder: Number(m.sort_order !== undefined ? m.sort_order : (m.sortOrder || 0)),
      dueDate: m.due_date !== undefined ? m.due_date : m.dueDate,
      reminderTime: m.reminder_time !== undefined ? m.reminder_time : (m.reminderTime || null),
      reminderLocation: m.reminder_location !== undefined ? m.reminder_location : (m.reminderLocation || null),
      collaborators: parseJson(m.collaborators, []),
      checklistData: parseJson(m.checklist_data !== undefined ? m.checklist_data : m.checklistData, []),
      linkPreviews: parseJson(m.link_previews !== undefined ? m.link_previews : m.linkPreviews, []),
      attachments: attachmentsMap.get(m.id) ?? [],
      categoryId: catId ?? null,
      category: catId ? categoryMap.get(catId) ?? null : null,
      tags: tagsMap.get(m.id) ?? [],
      version: Number(m.version ?? 1),
      createdBy: m.created_by !== undefined ? m.created_by : m.createdBy,
      createdAt: Number(m.created_at !== undefined ? m.created_at : m.createdAt),
      updatedAt: Number(m.updated_at !== undefined ? m.updated_at : m.updatedAt),
      deletedAt: m.deleted_at !== undefined ? m.deleted_at : m.deletedAt,
    };
  });
}

/**
 * List memos with filtering, pagination, sorting, and full-text search.
 */
export function listMemos(
  dbCtx: DatabaseContext,
  options: ListMemosOptions
): { memos: FormattedMemo[]; total: number; page: number; limit: number } {
  const {
    workspaceId,
    status,
    priority,
    categoryId,
    tagId,
    tagName,
    folderId,
    isFavorite,
    isPinned,
    isArchived,
    hasReminder,
    includeDeleted,
    deletedOnly,
    search,
    page = 1,
    limit = 50,
    sortBy = 'updated_at',
    sortOrder = 'desc',
  } = options;

  const { sqlite } = dbCtx;
  const conditions: string[] = ['m.workspace_id = ?'];
  const params: any[] = [workspaceId];

  // Soft deletion filtering
  const showDeleted = includeDeleted === true || includeDeleted === 'true';
  const onlyDeleted = deletedOnly === true || deletedOnly === 'true';
  if (onlyDeleted) {
    conditions.push('m.deleted_at IS NOT NULL');
  } else if (!showDeleted) {
    conditions.push('m.deleted_at IS NULL');
  }

  // Status filter
  if (status) {
    conditions.push('m.status = ?');
    params.push(status);
  }

  // Archive filter
  if (isArchived !== undefined && isArchived !== '') {
    const archBool = isArchived === true || isArchived === 'true';
    if (archBool) {
      conditions.push('(m.is_archived = 1 OR m.status = ?)');
      params.push('archived');
    } else {
      conditions.push('(m.is_archived = 0 AND m.status != ?)');
      params.push('archived');
    }
  }

  // Reminder filter
  if (hasReminder !== undefined && hasReminder !== '') {
    const remBool = hasReminder === true || hasReminder === 'true';
    if (remBool) {
      conditions.push('(m.reminder_time IS NOT NULL OR m.due_date IS NOT NULL)');
    }
  }

  // Priority filter
  if (priority) {
    conditions.push('m.priority = ?');
    params.push(priority);
  }

  // Category filter
  if (categoryId) {
    conditions.push('m.category_id = ?');
    params.push(categoryId);
  }

  // Folder filter
  if (folderId) {
    conditions.push('m.folder_id = ?');
    params.push(folderId);
  }

  // Favorite filter
  if (isFavorite !== undefined && isFavorite !== '') {
    const favBool = isFavorite === true || isFavorite === 'true';
    conditions.push('m.is_favorite = ?');
    params.push(favBool ? 1 : 0);
  }

  // Pinned filter
  if (isPinned !== undefined && isPinned !== '') {
    const pinnedBool = isPinned === true || isPinned === 'true';
    conditions.push('m.is_pinned = ?');
    params.push(pinnedBool ? 1 : 0);
  }

  // Tag filter by id or name
  if (tagId) {
    conditions.push('EXISTS (SELECT 1 FROM memo_tags mt WHERE mt.memo_id = m.id AND mt.tag_id = ?)');
    params.push(tagId);
  } else if (tagName) {
    conditions.push(`
      EXISTS (
        SELECT 1 FROM memo_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.memo_id = m.id AND t.name = ? AND t.workspace_id = ?
      )
    `);
    params.push(tagName, workspaceId);
  }

  // Sorting
  const allowedSortCols: Record<string, string> = {
    updatedAt: 'm.updated_at',
    updated_at: 'm.updated_at',
    createdAt: 'm.created_at',
    created_at: 'm.created_at',
    dueDate: 'm.due_date',
    due_date: 'm.due_date',
    reminderTime: 'm.reminder_time',
    reminder_time: 'm.reminder_time',
    sortOrder: 'm.sort_order',
    sort_order: 'm.sort_order',
    title: 'm.title',
    priority: 'm.priority',
    status: 'm.status',
  };
  const sortCol = allowedSortCols[sortBy] || 'm.updated_at';
  const order = sortOrder?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const sanitizedSearch = search?.trim() ? buildFtsQuery(search.trim()) : '';
  const offset = Math.max(0, (page - 1) * limit);

  let rawMemos: any[] = [];
  let total = 0;

  if (sanitizedSearch) {
    // FTS5 Full-Text Search
    const ftsConditions = ['memos_fts MATCH ?', ...conditions];
    const ftsParams = [sanitizedSearch, ...params];

    const countSql = `
      SELECT COUNT(*) as cnt
      FROM memos_fts
      JOIN memos m ON m.rowid = memos_fts.rowid
      WHERE ${ftsConditions.join(' AND ')}
    `;
    const countRow = sqlite.prepare(countSql).get(...ftsParams) as { cnt: number };
    total = countRow ? countRow.cnt : 0;

    const dataSql = `
      SELECT m.*, memos_fts.rank
      FROM memos_fts
      JOIN memos m ON m.rowid = memos_fts.rowid
      WHERE ${ftsConditions.join(' AND ')}
      ORDER BY memos_fts.rank ASC, ${sortCol} ${order}
      LIMIT ? OFFSET ?
    `;
    rawMemos = sqlite.prepare(dataSql).all(...ftsParams, limit, offset);
  } else {
    // Standard query
    const countSql = `
      SELECT COUNT(*) as cnt
      FROM memos m
      WHERE ${conditions.join(' AND ')}
    `;
    const countRow = sqlite.prepare(countSql).get(...params) as { cnt: number };
    total = countRow ? countRow.cnt : 0;

    const dataSql = `
      SELECT m.*
      FROM memos m
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${sortCol} ${order}
      LIMIT ? OFFSET ?
    `;
    rawMemos = sqlite.prepare(dataSql).all(...params, limit, offset);
  }

  const formatted = hydrateMemos(sqlite, rawMemos);

  return {
    memos: formatted,
    total,
    page,
    limit,
  };
}

/**
 * Get single memo by ID.
 * Returns null if not found or outside user's workspace.
 */
export function getMemoById(
  dbCtx: DatabaseContext,
  memoId: string,
  workspaceId: string
): FormattedMemo | null {
  const { sqlite } = dbCtx;
  const rawMemo = sqlite
    .prepare('SELECT * FROM memos WHERE id = ? AND workspace_id = ?')
    .get(memoId, workspaceId) as any;

  if (!rawMemo) return null;

  const [formatted] = hydrateMemos(sqlite, [rawMemo]);
  return formatted || null;
}

/**
 * Create a new memo.
 */
export function createMemo(
  dbCtx: DatabaseContext,
  data: CreateMemoInput,
  userId: string
): FormattedMemo {
  const { db, sqlite } = dbCtx;
  const {
    workspaceId,
    folderId = null,
    categoryId = null,
    title = '',
    content = '',
    color = 'default',
    priority = 'medium',
    status = 'pending',
    isFavorite = false,
    isPinned = false,
    dueDate = null,
    tags: memoTagNames = [],
  } = data;

  if (!workspaceId) {
    throw new ValidationError('workspaceId is required');
  }

  if (priority && !VALID_PRIORITIES.includes(priority)) {
    throw new ValidationError(`Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }

  if (status && !VALID_STATUSES.includes(status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (!VALID_MEMO_COLORS.includes(color as any)) throw new ValidationError('Invalid memo color');
  if (data.theme && !VALID_THEMES.includes(data.theme as any)) throw new ValidationError('Invalid memo theme');

  if (categoryId && !sqlite.prepare('SELECT id FROM categories WHERE id = ? AND workspace_id = ?').get(categoryId, workspaceId)) {
    throw new ValidationError('Category must belong to the same workspace as the memo');
  }
  if (folderId && !sqlite.prepare('SELECT id FROM folders WHERE id = ? AND workspace_id = ?').get(folderId, workspaceId)) {
    throw new ValidationError('Folder must belong to the same workspace as the memo');
  }

  const memoId = crypto.randomUUID();
  const now = Date.now();
  const initialVersion = 1;

  db.transaction((tx) => {
    // 1. Insert memo
    tx.insert(memos).values({
      id: memoId,
      workspaceId,
      folderId: folderId || null,
      categoryId: categoryId || null,
      title: title ?? '',
      content: content ?? '',
      color,
      theme: data.theme && VALID_THEMES.includes(data.theme as any) ? data.theme : 'default',
      priority: priority || 'medium',
      status: status || 'pending',
      isFavorite: isFavorite ? 1 : 0,
      isPinned: isPinned ? 1 : 0,
      isArchived: data.isArchived !== undefined ? (data.isArchived ? 1 : 0) : (status === 'archived' ? 1 : 0),
      noteType: data.noteType || 'text',
      sortOrder: data.sortOrder || 0,
      dueDate: dueDate ?? null,
      reminderTime: data.reminderTime ?? null,
      reminderLocation: data.reminderLocation ?? null,
      collaborators: JSON.stringify(data.collaborators || []),
      checklistData: JSON.stringify(data.checklistData || []),
      linkPreviews: JSON.stringify(data.linkPreviews || []),
      version: initialVersion,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }).run();

    // 2. Handle tags
    if (Array.isArray(memoTagNames) && memoTagNames.length > 0) {
      for (const rawName of memoTagNames) {
        const name = String(rawName).trim();
        if (!name) continue;

        let tag = tx.select().from(tags).where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, name))).get();
        if (!tag) {
          const tagId = crypto.randomUUID();
          tx.insert(tags).values({
            id: tagId,
            workspaceId,
            name,
            createdAt: now,
          }).run();
          tag = { id: tagId, workspaceId, name, createdAt: now };
        }

        tx.insert(memoTags).values({
          memoId,
          tagId: tag.id,
        }).run();
      }
    }

    // 3. Snapshot initial version
    tx.insert(memoVersions).values({
      id: crypto.randomUUID(),
      memoId,
      versionNumber: initialVersion,
      title: title ?? '',
      content: content ?? '',
      changedBy: userId,
      createdAt: now,
    }).run();
  });

  const created = getMemoById(dbCtx, memoId, workspaceId);
  if (!created) {
    throw new Error('Failed to retrieve newly created memo');
  }
  return created;
}

/**
 * Update an existing memo with optimistic locking verification.
 */
export function updateMemo(
  dbCtx: DatabaseContext,
  memoId: string,
  workspaceId: string,
  data: UpdateMemoInput,
  userId: string
): FormattedMemo {
  const { db, sqlite } = dbCtx;

  const existing = sqlite
    .prepare('SELECT * FROM memos WHERE id = ? AND workspace_id = ?')
    .get(memoId, workspaceId) as any;

  if (!existing) {
    throw new MemoNotFoundError('Memo not found');
  }

  // Optimistic Concurrency Check
  if (data.version !== undefined && data.version !== existing.version) {
    throw new MemoConflictError(
      `Version conflict: memo version is ${existing.version}, but update requested version ${data.version}`,
      existing.version
    );
  }

  if (data.priority && !VALID_PRIORITIES.includes(data.priority)) {
    throw new ValidationError(`Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }

  if (data.status && !VALID_STATUSES.includes(data.status)) {
    throw new ValidationError(`Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const nextVersion = existing.version + 1;
  const now = Date.now();

  const newTitle = data.title !== undefined ? data.title : existing.title;
  const newContent = data.content !== undefined ? data.content : existing.content;
  const newColor = data.color !== undefined ? data.color : (existing.color || 'default');
  if (!VALID_MEMO_COLORS.includes(newColor as any)) throw new ValidationError('Invalid memo color');
  const newTheme = data.theme !== undefined ? data.theme : (existing.theme || 'default');
  if (!VALID_THEMES.includes(newTheme as any)) throw new ValidationError('Invalid memo theme');
  const newPriority = data.priority !== undefined ? data.priority : existing.priority;
  const newStatus = data.status !== undefined ? data.status : existing.status;
  const newFolderId = data.folderId !== undefined ? data.folderId : existing.folder_id;
  const newCategoryId = data.categoryId !== undefined ? data.categoryId : existing.category_id;
  const newDueDate = data.dueDate !== undefined ? data.dueDate : existing.due_date;
  const newReminderTime = data.reminderTime !== undefined ? data.reminderTime : existing.reminder_time;
  const newReminderLocation = data.reminderLocation !== undefined ? data.reminderLocation : existing.reminder_location;
  const newIsArchived = data.isArchived !== undefined
    ? (data.isArchived ? 1 : 0)
    : (data.status === 'archived' ? 1 : (existing.is_archived || (existing.status === 'archived' ? 1 : 0)));
  const newNoteType = data.noteType !== undefined ? data.noteType : (existing.note_type || 'text');
  const newSortOrder = data.sortOrder !== undefined ? data.sortOrder : (existing.sort_order || 0);
  const newCollaborators = data.collaborators !== undefined ? JSON.stringify(data.collaborators) : (existing.collaborators || '[]');
  const newChecklistData = data.checklistData !== undefined ? JSON.stringify(data.checklistData) : (existing.checklist_data || '[]');
  const newLinkPreviews = data.linkPreviews !== undefined ? JSON.stringify(data.linkPreviews) : (existing.link_previews || '[]');

  if (newCategoryId && !sqlite.prepare('SELECT id FROM categories WHERE id = ? AND workspace_id = ?').get(newCategoryId, workspaceId)) {
    throw new ValidationError('Category must belong to the same workspace as the memo');
  }
  if (newFolderId && !sqlite.prepare('SELECT id FROM folders WHERE id = ? AND workspace_id = ?').get(newFolderId, workspaceId)) {
    throw new ValidationError('Folder must belong to the same workspace as the memo');
  }
  const newIsFavorite = data.isFavorite !== undefined ? (data.isFavorite ? 1 : 0) : existing.is_favorite;
  const newIsPinned = data.isPinned !== undefined ? (data.isPinned ? 1 : 0) : existing.is_pinned;

  db.transaction((tx) => {
    // 1. Update memo table
    tx.update(memos)
      .set({
        title: newTitle,
        content: newContent,
        color: newColor,
        theme: newTheme,
        priority: newPriority,
        status: newStatus,
        folderId: newFolderId,
        categoryId: newCategoryId,
        dueDate: newDueDate,
        reminderTime: newReminderTime,
        reminderLocation: newReminderLocation,
        isFavorite: newIsFavorite,
        isPinned: newIsPinned,
        isArchived: newIsArchived,
        noteType: newNoteType,
        sortOrder: newSortOrder,
        collaborators: newCollaborators,
        checklistData: newChecklistData,
        linkPreviews: newLinkPreviews,
        version: nextVersion,
        updatedAt: now,
      })
      .where(and(eq(memos.id, memoId), eq(memos.workspaceId, workspaceId)))
      .run();

    // 2. Handle tags if provided
    if (data.tags !== undefined) {
      // Remove current associations
      tx.delete(memoTags).where(eq(memoTags.memoId, memoId)).run();

      for (const rawName of data.tags) {
        const name = String(rawName).trim();
        if (!name) continue;

        let tag = tx.select().from(tags).where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, name))).get();
        if (!tag) {
          const tagId = crypto.randomUUID();
          tx.insert(tags).values({
            id: tagId,
            workspaceId,
            name,
            createdAt: now,
          }).run();
          tag = { id: tagId, workspaceId, name, createdAt: now };
        }

        tx.insert(memoTags).values({
          memoId,
          tagId: tag.id,
        }).run();
      }
    }

    // 3. Insert snapshot into memo_versions only when memo content changed.
    const contentChanged = newTitle !== existing.title || newContent !== existing.content;
    if (contentChanged) tx.insert(memoVersions).values({
      id: crypto.randomUUID(),
      memoId,
      versionNumber: nextVersion,
      title: newTitle,
      content: newContent,
      changedBy: userId,
      createdAt: now,
    }).run();
  });

  const updated = getMemoById(dbCtx, memoId, workspaceId);
  if (!updated) {
    throw new Error('Failed to retrieve updated memo');
  }
  return updated;
}

/**
 * Delete a memo (soft delete by default, or permanent hard delete).
 */
export function deleteMemo(
  dbCtx: DatabaseContext,
  memoId: string,
  workspaceId: string,
  permanent = false
): void {
  const { db, sqlite } = dbCtx;

  const existing = sqlite
    .prepare('SELECT id FROM memos WHERE id = ? AND workspace_id = ?')
    .get(memoId, workspaceId) as any;

  if (!existing) {
    throw new MemoNotFoundError('Memo not found');
  }

  if (permanent) {
    // Hard delete (triggers will delete from memos_fts, cascade from memo_tags and memo_versions)
    db.delete(memos).where(and(eq(memos.id, memoId), eq(memos.workspaceId, workspaceId))).run();
  } else {
    // Soft delete
    db.update(memos)
      .set({
        deletedAt: Date.now(),
        updatedAt: Date.now(),
      })
      .where(and(eq(memos.id, memoId), eq(memos.workspaceId, workspaceId)))
      .run();
  }
}

export interface EmptyTrashResult {
  /** Number of memos permanently removed. */
  deletedCount: number;
  /** On-disk attachment files that belong to the purged memos (for caller-side cleanup). */
  attachmentPaths: string[];
}

/**
 * Permanently delete every soft-deleted memo in the workspace ("Empty Trash").
 * Cascades remove memo_tags, memo_versions, notifications and attachment rows;
 * the caller unlinks the returned attachment files from disk.
 */
export function emptyTrash(dbCtx: DatabaseContext, workspaceId: string): EmptyTrashResult {
  const { db, sqlite } = dbCtx;

  const attachmentRows = sqlite
    .prepare(
      `SELECT a.storage_path FROM attachments a
       JOIN memos m ON m.id = a.memo_id
       WHERE m.workspace_id = ? AND m.deleted_at IS NOT NULL`
    )
    .all(workspaceId) as Array<{ storage_path: string }>;

  const deletedCount = db
    .delete(memos)
    .where(and(eq(memos.workspaceId, workspaceId), isNotNull(memos.deletedAt)))
    .run().changes;

  return {
    deletedCount,
    attachmentPaths: attachmentRows.map((row) => row.storage_path),
  };
}

/**
 * Restore a soft-deleted memo.
 */
export function restoreMemo(
  dbCtx: DatabaseContext,
  memoId: string,
  workspaceId: string
): FormattedMemo {
  const { db, sqlite } = dbCtx;

  const existing = sqlite
    .prepare('SELECT id FROM memos WHERE id = ? AND workspace_id = ?')
    .get(memoId, workspaceId) as any;

  if (!existing) {
    throw new MemoNotFoundError('Memo not found');
  }

  db.update(memos)
    .set({
      deletedAt: null,
      updatedAt: Date.now(),
    })
    .where(and(eq(memos.id, memoId), eq(memos.workspaceId, workspaceId)))
    .run();

  const restored = getMemoById(dbCtx, memoId, workspaceId);
  if (!restored) {
    throw new Error('Failed to retrieve restored memo');
  }
  return restored;
}

/**
 * Retrieve revision history for a memo.
 */
export function getMemoVersions(
  dbCtx: DatabaseContext,
  memoId: string,
  workspaceId: string
): MemoVersion[] {
  const { db, sqlite } = dbCtx;

  const existing = sqlite
    .prepare('SELECT id FROM memos WHERE id = ? AND workspace_id = ?')
    .get(memoId, workspaceId) as any;

  if (!existing) {
    throw new MemoNotFoundError('Memo not found');
  }

  return db
    .select()
    .from(memoVersions)
    .where(eq(memoVersions.memoId, memoId))
    .orderBy(memoVersions.versionNumber)
    .all();
}

/**
 * Reorder memos in a workspace (Google Keep drag and drop).
 */
export function reorderMemos(
  dbCtx: DatabaseContext,
  workspaceId: string,
  memoIds: string[]
): void {
  const { db, sqlite } = dbCtx;
  const updateStmt = sqlite.prepare('UPDATE memos SET sort_order = ? WHERE id = ? AND workspace_id = ?');
  db.transaction(() => {
    memoIds.forEach((id, index) => {
      updateStmt.run(index, id, workspaceId);
    });
  });
}

