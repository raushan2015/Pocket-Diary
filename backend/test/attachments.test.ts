import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Memo attachment API', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-attachments-'));
    process.env.ATTACHMENTS_DIR = storageRoot;
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dbCtx.sqlite.close();
    delete process.env.ATTACHMENTS_DIR;
    fs.rmSync(storageRoot, { recursive: true, force: true });
  });

  async function createMemoFor(cookieHeader: string, workspaceId: string) {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/memos', headers: { cookie: cookieHeader },
      payload: { workspaceId, title: 'Images in my note', content: 'test note' },
    });
    expect(response.statusCode).toBe(201);
    return response.json().memo;
  }

  it('uploads, lists, serves and deletes an authorized PNG image', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);
    const memo = await createMemoFor(cookieHeader, workspace.id);
    const png = Buffer.from('fake png body for API lifecycle test');
    const boundary = 'memo-test-boundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sketch.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: 'POST', url: `/api/v1/attachments/memo/${memo.id}`,
      headers: { cookie: cookieHeader, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const attachment = upload.json().attachment;
    expect(attachment.fileName).toBe('sketch.png');
    expect(attachment.fileSize).toBe(png.length);

    const list = await app.inject({ method: 'GET', url: `/api/v1/attachments/memo/${memo.id}`, headers: { cookie: cookieHeader } });
    expect(list.statusCode).toBe(200);
    expect(list.json().attachments).toHaveLength(1);

    const memosList = await app.inject({ method: 'GET', url: `/api/v1/memos?workspaceId=${workspace.id}`, headers: { cookie: cookieHeader } });
    expect(memosList.statusCode).toBe(200);
    const foundMemo = memosList.json().memos.find((m: any) => m.id === memo.id);
    expect(foundMemo.attachments).toHaveLength(1);
    expect(foundMemo.attachments[0].id).toBe(attachment.id);

    const file = await app.inject({ method: 'GET', url: attachment.url, headers: { cookie: cookieHeader } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.body).toBe(png.toString());

    const remove = await app.inject({ method: 'DELETE', url: `/api/v1/attachments/${attachment.id}`, headers: { cookie: cookieHeader } });
    expect(remove.statusCode).toBe(200);
    expect(fs.existsSync(path.join(storageRoot, workspace.id, memo.id, `${attachment.id}.png`))).toBe(false);
  });

  it('prevents another tenant from listing or downloading private attachments', async () => {
    const owner = await createTestUser(app, 'owner@example.com', 'Owner');
    const other = await createTestUser(app, 'other@example.com', 'Other');
    const memo = await createMemoFor(owner.cookieHeader, owner.workspace.id);
    const png = Buffer.from('tenant-isolated');
    const boundary = 'memo-test-boundary-2';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: 'POST', url: `/api/v1/attachments/memo/${memo.id}`,
      headers: { cookie: owner.cookieHeader, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const id = upload.json().attachment.id;

    const list = await app.inject({ method: 'GET', url: `/api/v1/attachments/memo/${memo.id}`, headers: { cookie: other.cookieHeader } });
    expect(list.statusCode).toBe(404);
    const download = await app.inject({ method: 'GET', url: `/api/v1/attachments/${id}/file`, headers: { cookie: other.cookieHeader } });
    expect(download.statusCode).toBe(404);
    const remove = await app.inject({ method: 'DELETE', url: `/api/v1/attachments/${id}`, headers: { cookie: other.cookieHeader } });
    expect(remove.statusCode).toBe(404);
  });

  it('rejects unsupported upload media types', async () => {
    const { workspace, cookieHeader } = await createTestUser(app);
    const memo = await createMemoFor(cookieHeader, workspace.id);
    const boundary = 'memo-test-boundary-3';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="archive.zip"\r\nContent-Type: application/zip\r\n\r\nPK123\r\n--${boundary}--\r\n`);
    const response = await app.inject({
      method: 'POST', url: `/api/v1/attachments/memo/${memo.id}`,
      headers: { cookie: cookieHeader, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode).toBe(415);
  });
});
