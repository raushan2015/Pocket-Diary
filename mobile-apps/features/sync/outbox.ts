/**
 * Durable Outbox Queue (SQLite-backed).
 *
 * Implements:
 *  - Coalescing of consecutive mutations on the same entity while pending:
 *      create + update -> merge into create
 *      create + delete -> drop both (note never left device)
 *      update + update -> merge patches (latest field values win)
 *      update + delete -> replace with delete
 *  - Stable operation IDs, timestamps, attempt counts, backoff delay.
 *  - Isolation by (server_key, user_id).
 */
import type { SqliteDriver } from '@/services/db/driver';
import { defaultIdGen, type IdGen } from '@/utils/ids';
import { backoffDelay } from '@/utils/time';

export type OutboxOpType = 'create' | 'update' | 'delete' | 'restore' | 'attachment_upload' | 'attachment_delete';
export type OutboxStatus = 'pending' | 'in_flight' | 'conflicted' | 'failed';

/** Note-lifecycle ops that participate in coalescing. */
const LIFECYCLE_OPS = new Set<OutboxOpType>(['create', 'update', 'delete', 'restore']);

export interface OutboxEntry {
  id: string;
  serverKey: string;
  userId: string;
  entity: string; // 'note'
  noteId: string;
  op: OutboxOpType;
  payload: Record<string, any>;
  baseVersion: number | null;
  clientId: string | null;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueOpInput {
  entity: 'note';
  noteId: string;
  op: OutboxOpType;
  payload: Record<string, any>;
  baseVersion?: number | null;
  clientId?: string | null;
}

export interface OutboxScope {
  serverKey: string;
  userId: string;
}

export class OutboxQueue {
  private db: SqliteDriver;
  private scope: OutboxScope;
  private idGen: IdGen;

  constructor(db: SqliteDriver, scope: OutboxScope, idGen: IdGen = defaultIdGen) {
    this.db = db;
    this.scope = scope;
    this.idGen = idGen;
  }

  setScope(scope: OutboxScope): void {
    this.scope = scope;
  }

  private mapRow(r: any): OutboxEntry {
    return {
      id: r.id,
      serverKey: r.server_key,
      userId: r.user_id,
      entity: r.entity,
      noteId: r.note_id,
      op: r.op as OutboxOpType,
      payload: JSON.parse(r.payload || '{}'),
      baseVersion: r.base_version != null ? Number(r.base_version) : null,
      clientId: r.client_id ?? null,
      status: r.status as OutboxStatus,
      attempts: Number(r.attempts ?? 0),
      nextAttemptAt: Number(r.next_attempt_at ?? 0),
      lastError: r.last_error ?? null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  /**
   * Enqueues an operation with coalescing.
   * Runs in the same transaction as local note state changes for ACID durability.
   */
  enqueue(input: EnqueueOpInput): OutboxEntry | null {
    const now = Date.now();

    return this.db.transaction(() => {
      // Attachment ops never merge into note-lifecycle ops. A pending upload
      // for the same attachment replaces the earlier one (re-pick / retry);
      // a note delete elides its pending uploads (they would 404 anyway).
      if (!LIFECYCLE_OPS.has(input.op)) {
        if (input.op === 'attachment_upload' && input.payload.attachmentId) {
          this.db.run(
            `DELETE FROM outbox
             WHERE server_key = ? AND user_id = ? AND note_id = ?
               AND op = 'attachment_upload' AND status = 'pending'
               AND json_extract(payload, '$.attachmentId') = ?`,
            [this.scope.serverKey, this.scope.userId, input.noteId, String(input.payload.attachmentId)],
          );
        }
        const id = this.idGen();
        this.db.run(
          `INSERT INTO outbox (
            id, server_key, user_id, entity, note_id, op, payload,
            base_version, client_id, status, attempts, next_attempt_at,
            last_error, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?,
            ?, ?, 'pending', 0, 0,
            NULL, ?, ?
          )`,
          [
            id,
            this.scope.serverKey,
            this.scope.userId,
            input.entity,
            input.noteId,
            input.op,
            JSON.stringify(input.payload || {}),
            input.baseVersion ?? null,
            input.clientId ?? null,
            now,
            now,
          ],
        );
        return this.getEntryById(id);
      }

      // Find the latest pending lifecycle op for the same note (attachment
      // ops must not hide an older lifecycle op from coalescing).
      const pendingRow = this.db.get<any>(
        `SELECT * FROM outbox
         WHERE server_key = ? AND user_id = ? AND note_id = ? AND status = 'pending'
           AND op IN ('create', 'update')
         ORDER BY created_at DESC LIMIT 1`,
        [this.scope.serverKey, this.scope.userId, input.noteId],
      );

      if (pendingRow) {
        const existing = this.mapRow(pendingRow);

        // Case 1: Existing create
        if (existing.op === 'create') {
          if (input.op === 'update') {
            // Merge update into create payload
            const mergedPayload = { ...existing.payload, ...input.payload };
            this.db.run(
              `UPDATE outbox SET payload = ?, updated_at = ? WHERE id = ?`,
              [JSON.stringify(mergedPayload), now, existing.id],
            );
            return this.getEntryById(existing.id);
          }
          if (input.op === 'delete') {
            // Note was created and deleted offline: delete outbox entry completely!
            this.db.run('DELETE FROM outbox WHERE id = ?', [existing.id]);
            return null;
          }
        }

        // Case 2: Existing update
        if (existing.op === 'update') {
          if (input.op === 'update') {
            // Merge update patches
            const mergedPayload = { ...existing.payload, ...input.payload };
            this.db.run(
              `UPDATE outbox SET payload = ?, updated_at = ? WHERE id = ?`,
              [JSON.stringify(mergedPayload), now, existing.id],
            );
            return this.getEntryById(existing.id);
          }
          if (input.op === 'delete') {
            // Replace pending update with delete
            this.db.run(
              `UPDATE outbox SET op = 'delete', payload = ?, updated_at = ? WHERE id = ?`,
              [JSON.stringify(input.payload || {}), now, existing.id],
            );
            return this.getEntryById(existing.id);
          }
        }
      }

      if (input.op === 'delete') {
        // A trashed note's pending uploads are moot — they would 404 after
        // the delete lands. Elide them (keeps FIFO order intact otherwise).
        this.db.run(
          `DELETE FROM outbox
           WHERE server_key = ? AND user_id = ? AND note_id = ?
             AND op = 'attachment_upload' AND status = 'pending'`,
          [this.scope.serverKey, this.scope.userId, input.noteId],
        );
      }

      // No pending op to coalesce with — insert fresh op
      const id = this.idGen();
      this.db.run(
        `INSERT INTO outbox (
          id, server_key, user_id, entity, note_id, op, payload,
          base_version, client_id, status, attempts, next_attempt_at,
          last_error, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, 'pending', 0, 0,
          NULL, ?, ?
        )`,
        [
          id,
          this.scope.serverKey,
          this.scope.userId,
          input.entity,
          input.noteId,
          input.op,
          JSON.stringify(input.payload || {}),
          input.baseVersion ?? null,
          input.clientId ?? null,
          now,
          now,
        ],
      );

      return this.getEntryById(id);
    });
  }

  getEntryById(id: string): OutboxEntry | null {
    const row = this.db.get<any>(
      'SELECT * FROM outbox WHERE id = ? AND server_key = ? AND user_id = ?',
      [id, this.scope.serverKey, this.scope.userId],
    );
    return row ? this.mapRow(row) : null;
  }

  /**
   * Returns pending entries ready for processing (respecting next_attempt_at).
   */
  getReadyEntries(limit = 50, now = Date.now()): OutboxEntry[] {
    const rows = this.db.all<any>(
      `SELECT * FROM outbox
       WHERE server_key = ? AND user_id = ? AND status = 'pending' AND next_attempt_at <= ?
       ORDER BY created_at ASC LIMIT ?`,
      [this.scope.serverKey, this.scope.userId, now, limit],
    );
    return rows.map((r) => this.mapRow(r));
  }

  getPendingCount(): number {
    const row = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM outbox
       WHERE server_key = ? AND user_id = ? AND status IN ('pending', 'in_flight')`,
      [this.scope.serverKey, this.scope.userId],
    );
    return row ? Number(row.cnt) : 0;
  }

  getFailedCount(): number {
    const row = this.db.get<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM outbox
       WHERE server_key = ? AND user_id = ? AND status IN ('failed', 'conflicted')`,
      [this.scope.serverKey, this.scope.userId],
    );
    return row ? Number(row.cnt) : 0;
  }

  markInFlight(id: string): void {
    this.db.run(
      `UPDATE outbox SET status = 'in_flight', updated_at = ? WHERE id = ?`,
      [Date.now(), id],
    );
  }

  /**
   * Crash recovery: requeues operations that were mid-flight when the app
   * died. Without this, an `in_flight` op is stranded forever (it is never
   * picked up by getReadyEntries, which only selects `pending`). Every op is
   * idempotent or version-guarded, so replaying is safe. Returns the number
   * of requeued ops.
   */
  requeueInFlight(now = Date.now()): number {
    const result = this.db.run(
      `UPDATE outbox SET status = 'pending', next_attempt_at = 0, updated_at = ?
       WHERE server_key = ? AND user_id = ? AND status = 'in_flight'`,
      [now, this.scope.serverKey, this.scope.userId],
    );
    return result.changes;
  }

  markCompleted(id: string): void {
    this.db.run('DELETE FROM outbox WHERE id = ?', [id]);
  }

  markFailed(id: string, error: string, fatal = false): void {
    const entry = this.getEntryById(id);
    if (!entry) return;

    const attempts = entry.attempts + 1;
    const now = Date.now();

    if (fatal || attempts >= 8) {
      // Park as failed for user inspection/retry in settings
      this.db.run(
        `UPDATE outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        [attempts, error, now, id],
      );
    } else {
      // Exponential backoff with jitter
      const delay = backoffDelay(attempts);
      const nextAttemptAt = now + delay;
      this.db.run(
        `UPDATE outbox SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        [attempts, nextAttemptAt, error, now, id],
      );
    }
  }

  markConflicted(id: string, error: string): void {
    this.db.run(
      `UPDATE outbox SET status = 'conflicted', last_error = ?, updated_at = ? WHERE id = ?`,
      [error, Date.now(), id],
    );
  }

  retryFailedOps(): void {
    this.db.run(
      `UPDATE outbox SET status = 'pending', next_attempt_at = 0, updated_at = ?
       WHERE server_key = ? AND user_id = ? AND status = 'failed'`,
      [Date.now(), this.scope.serverKey, this.scope.userId],
    );
  }

  /** Requeues one parked operation (by id) for the current scope. */
  retryOp(opId: string): void {
    this.db.run(
      `UPDATE outbox SET status = 'pending', next_attempt_at = 0, attempts = 0, updated_at = ?
       WHERE id = ? AND server_key = ? AND user_id = ? AND status = 'failed'`,
      [Date.now(), opId, this.scope.serverKey, this.scope.userId],
    );
  }

  /**
   * Drops every pending/in-flight op for a note — used when a note that
   * never reached the server is discarded locally (empty draft cleanup,
   * permanent delete of an unsynced note). Ops already completed are rows
   * that no longer exist; conflicted/failed lifecycle ops keep their state
   * so nothing disappears silently — callers only invoke this for notes
   * with no server identity.
   */
  removeNoteOps(noteId: string): void {
    this.db.run(
      `DELETE FROM outbox
       WHERE server_key = ? AND user_id = ? AND note_id = ?
         AND status IN ('pending', 'in_flight')`,
      [this.scope.serverKey, this.scope.userId, noteId],
    );
  }

  listAllEntries(): OutboxEntry[] {
    const rows = this.db.all<any>(
      `SELECT * FROM outbox
       WHERE server_key = ? AND user_id = ?
       ORDER BY created_at DESC`,
      [this.scope.serverKey, this.scope.userId],
    );
    return rows.map((r) => this.mapRow(r));
  }
}
