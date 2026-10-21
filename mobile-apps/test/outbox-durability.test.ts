import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxQueue } from '@/features/sync/outbox';
import { NodeSqliteDriver } from '@/services/db/driver.node';
import { initializeDatabase } from '@/services/db/database';

describe('Outbox Queue Durability & Mutation Coalescing', () => {
  let db: NodeSqliteDriver;
  let outbox: OutboxQueue;
  const scope = { serverKey: 'https://notes.example.com', userId: 'user-abc' };

  beforeEach(() => {
    db = new NodeSqliteDriver(':memory:');
    initializeDatabase(db);
    outbox = new OutboxQueue(db, scope);
  });

  it('enqueues mutations durably with stable IDs and timestamps', () => {
    const entry = outbox.enqueue({
      entity: 'note',
      noteId: 'note-1',
      op: 'create',
      payload: { title: 'First Note', content: 'Hello' },
      clientId: 'mobile-client-12345',
    });

    expect(entry).not.toBeNull();
    expect(entry?.id).toBeDefined();
    expect(entry?.status).toBe('pending');
    expect(entry?.attempts).toBe(0);
    expect(entry?.clientId).toBe('mobile-client-12345');

    const fetched = outbox.getEntryById(entry!.id);
    expect(fetched).toEqual(entry);
    expect(outbox.getPendingCount()).toBe(1);
  });

  it('coalesces pending create + update into a single create operation', () => {
    outbox.enqueue({
      entity: 'note',
      noteId: 'note-1',
      op: 'create',
      payload: { title: 'Initial', color: 'default' },
      clientId: 'mobile-cid-1',
    });

    outbox.enqueue({
      entity: 'note',
      noteId: 'note-1',
      op: 'update',
      payload: { title: 'Updated Title', color: 'blue' },
    });

    expect(outbox.getPendingCount()).toBe(1);
    const ready = outbox.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0]?.op).toBe('create');
    expect(ready[0]?.payload.title).toBe('Updated Title');
    expect(ready[0]?.payload.color).toBe('blue');
    expect(ready[0]?.clientId).toBe('mobile-cid-1');
  });

  it('coalesces pending create + delete by dropping both ops (note never reached server)', () => {
    outbox.enqueue({
      entity: 'note',
      noteId: 'note-temp',
      op: 'create',
      payload: { title: 'Temporary Note' },
    });

    expect(outbox.getPendingCount()).toBe(1);

    const result = outbox.enqueue({
      entity: 'note',
      noteId: 'note-temp',
      op: 'delete',
      payload: {},
    });

    expect(result).toBeNull();
    expect(outbox.getPendingCount()).toBe(0);
    expect(outbox.getReadyEntries().length).toBe(0);
  });

  it('coalesces consecutive pending updates by merging patches', () => {
    outbox.enqueue({
      entity: 'note',
      noteId: 'server-note-1',
      op: 'update',
      payload: { title: 'Title Patch 1', color: 'red' },
      baseVersion: 2,
    });

    outbox.enqueue({
      entity: 'note',
      noteId: 'server-note-1',
      op: 'update',
      payload: { content: 'Content Patch 2', color: 'green' },
      baseVersion: 2,
    });

    expect(outbox.getPendingCount()).toBe(1);
    const ready = outbox.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0]?.payload.title).toBe('Title Patch 1');
    expect(ready[0]?.payload.content).toBe('Content Patch 2');
    expect(ready[0]?.payload.color).toBe('green'); // second update wins for conflicting color
  });

  it('replaces a pending update with delete when note is deleted while update is pending', () => {
    outbox.enqueue({
      entity: 'note',
      noteId: 'server-note-2',
      op: 'update',
      payload: { title: 'Pending Edit' },
    });

    outbox.enqueue({
      entity: 'note',
      noteId: 'server-note-2',
      op: 'delete',
      payload: {},
    });

    expect(outbox.getPendingCount()).toBe(1);
    const ready = outbox.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0]?.op).toBe('delete');
  });

  it('retains pending queue across app restart / driver reconnect', () => {
    const entry = outbox.enqueue({
      entity: 'note',
      noteId: 'note-reboot',
      op: 'create',
      payload: { title: 'Survives Restart' },
    });

    // Reconnect to same database
    const newOutbox = new OutboxQueue(db, scope);
    expect(newOutbox.getPendingCount()).toBe(1);

    const ready = newOutbox.getReadyEntries();
    expect(ready.length).toBe(1);
    expect(ready[0]?.id).toBe(entry?.id);
    expect(ready[0]?.payload.title).toBe('Survives Restart');
  });

  it('schedules retry with exponential backoff on retryable failures', () => {
    const entry = outbox.enqueue({
      entity: 'note',
      noteId: 'note-retry',
      op: 'create',
      payload: { title: 'Retry Test' },
    });

    const now = Date.now();
    outbox.markFailed(entry!.id, 'Network timeout', false);

    const failed = outbox.getEntryById(entry!.id);
    expect(failed?.attempts).toBe(1);
    expect(failed?.status).toBe('pending');
    expect(failed?.lastError).toBe('Network timeout');
    expect(failed?.nextAttemptAt).toBeGreaterThan(now);

    // Ready entries check at `now` should exclude it because nextAttemptAt is in the future
    const immediateReady = outbox.getReadyEntries(50, now);
    expect(immediateReady.some((e) => e.id === entry!.id)).toBe(false);

    // After delay passes, it becomes ready
    const laterReady = outbox.getReadyEntries(50, now + 10000);
    expect(laterReady.some((e) => e.id === entry!.id)).toBe(true);
  });

  it('parks persistent failures as failed and allows manual retry', () => {
    const entry = outbox.enqueue({
      entity: 'note',
      noteId: 'note-fatal',
      op: 'create',
      payload: { title: 'Fatal' },
    });

    outbox.markFailed(entry!.id, '400 Bad Request', true);

    const failed = outbox.getEntryById(entry!.id);
    expect(failed?.status).toBe('failed');
    expect(outbox.getFailedCount()).toBe(1);

    outbox.retryFailedOps();
    const retried = outbox.getEntryById(entry!.id);
    expect(retried?.status).toBe('pending');
    expect(retried?.nextAttemptAt).toBe(0);
    expect(outbox.getFailedCount()).toBe(0);
  });
});
