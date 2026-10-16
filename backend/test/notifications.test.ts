import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { scanDueReminders, pruneNotifications } from '../src/services/notification.service.js';
import type { FastifyInstance } from 'fastify';

describe('Server-side reminder notifications (/api/v1/notifications)', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
  });

  const createMemoWithReminder = async (cookieHeader: string, workspaceId: string, body: object) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/memos',
      headers: { cookie: cookieHeader },
      payload: { workspaceId, title: 'Reminder note', content: 'check the oven', ...body },
    });
    expect(res.statusCode).toBe(201);
    return res.json().memo;
  };

  it('creates one notification per user when a reminder becomes due', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'remind-user@example.com');
    const now = Date.now();
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 60_000 });

    const scan1 = await scanDueReminders(dbCtx, { now: now + 1000 });
    expect(scan1.created).toBe(1);

    // Second scan must not duplicate the same trigger
    const scan2 = await scanDueReminders(dbCtx, { now: now + 2000 });
    expect(scan2.created).toBe(0);

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { cookie: cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    const data = listRes.json();
    expect(data.notifications).toHaveLength(1);
    expect(data.unread).toBe(1);
    expect(data.notifications[0].title).toBe('Reminder note');
    expect(data.notifications[0].memoId).toBeTruthy();
    expect(data.notifications[0].readAt).toBeNull();
  });

  it('ignores long-overdue reminders (no restart spam) and completed/archived notes', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'old-remind@example.com');
    const now = Date.now();

    // Overdue by 3 days: outside the fresh window, must NOT notify
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 3 * 24 * 3600_000 });
    // Archived note with a fresh reminder: must NOT notify
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 60_000, isArchived: true });

    const scan = await scanDueReminders(dbCtx, { now: now + 1000 });
    expect(scan.created).toBe(0);
  });

  it('marks a single notification read and then read-all', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'read-remind@example.com');
    const now = Date.now();
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 60_000 });
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 30_000 });
    await scanDueReminders(dbCtx, { now: now + 1000 });

    const list = (await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { cookie: cookieHeader },
    })).json();
    expect(list.unread).toBe(2);

    const first = list.notifications[0];
    const readRes = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${first.id}/read`,
      headers: { cookie: cookieHeader },
    });
    expect(readRes.statusCode).toBe(200);

    const afterOne = (await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { cookie: cookieHeader },
    })).json();
    expect(afterOne.unread).toBe(1);

    const readAllRes = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: { cookie: cookieHeader },
    });
    expect(readAllRes.statusCode).toBe(200);
    expect(readAllRes.json().updated).toBe(1);

    const afterAll = (await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { cookie: cookieHeader },
    })).json();
    expect(afterAll.unread).toBe(0);
  });

  it('does not leak notifications across users', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'owner-a@example.com');
    const { cookieHeader: cookieB } = await createTestUser(app, 'other-b@example.com');
    const now = Date.now();
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 60_000 });
    await scanDueReminders(dbCtx, { now: now + 1000 });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { cookie: cookieB },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notifications).toHaveLength(0);
    expect(res.json().unread).toBe(0);
  });

  it('rejects unauthenticated access and marks foreign notifications 404', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    expect(anon.statusCode).toBe(401);

    const { workspace, cookieHeader } = await createTestUser(app, 'iso@example.com');
    const { cookieHeader: cookieB } = await createTestUser(app, 'iso-b@example.com');
    const now = Date.now();
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 60_000 });
    await scanDueReminders(dbCtx, { now: now + 1000 });

    const list = (await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: { cookie: cookieHeader },
    })).json();
    const id = list.notifications[0].id;

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${id}/read`,
      headers: { cookie: cookieB },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('prunes old read notifications', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'prune@example.com');
    const now = Date.now();
    await createMemoWithReminder(cookieHeader, workspace.id, { reminderTime: now - 60_000 });
    await scanDueReminders(dbCtx, { now: now + 1000 });

    await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read-all',
      headers: { cookie: cookieHeader },
    });

    // Age the notification beyond the prune horizon
    dbCtx.sqlite.prepare('UPDATE notifications SET created_at = ?').run(now - 91 * 24 * 3600_000);
    const removed = pruneNotifications(dbCtx);
    expect(removed).toBe(1);
  });
});
