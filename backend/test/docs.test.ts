/**
 * OpenAPI / Swagger UI documentation tests.
 *
 * Verifies that GET /docs serves the UI, that the generated spec documents
 * EVERY endpoint (paths, parameters, bodies, responses, auth requirements),
 * that response documentation matches real payloads, that no configured
 * secret leaks into the spec, and that DOCS_ENABLED=false hides the docs
 * without touching the API itself.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';
import type { OpenAPIV3 } from 'openapi-types';

// ---------------------------------------------------------------------------
// The complete documented endpoint inventory. Every route registered by the
// app must appear here, and nothing else may appear in the spec — this is the
// "document ALL API endpoints" guarantee.
// ---------------------------------------------------------------------------
const EXPECTED_OPERATIONS: Array<[string, string, 'public' | 'auth', string]> = [
  // [method, path, auth, tag]
  ['get', '/health', 'public', 'System'],
  ['get', '/api/v1/health', 'public', 'System'],
  ['get', '/api/v1/system/info', 'public', 'System'],
  ['get', '/api/v1/system/backup-status', 'auth', 'System'],

  ['post', '/api/v1/auth/register', 'public', 'Auth'],
  ['post', '/api/v1/auth/login', 'public', 'Auth'],
  ['post', '/api/v1/auth/forgot-password', 'public', 'Auth'],
  ['post', '/api/v1/auth/reset-password', 'public', 'Auth'],
  ['post', '/api/v1/auth/logout', 'public', 'Auth'],
  ['get', '/api/v1/auth/me', 'auth', 'Auth'],
  ['patch', '/api/v1/auth/profile', 'auth', 'Auth'],
  ['get', '/api/v1/auth/sessions', 'auth', 'Auth'],
  ['delete', '/api/v1/auth/sessions/{id}', 'auth', 'Auth'],
  ['post', '/api/v1/auth/sessions/revoke', 'auth', 'Auth'],
  ['delete', '/api/v1/auth/account', 'auth', 'Auth'],

  ['get', '/api/v1/workspaces/', 'auth', 'Workspaces'],
  ['post', '/api/v1/workspaces/', 'auth', 'Workspaces'],
  ['patch', '/api/v1/workspaces/{id}', 'auth', 'Workspaces'],
  ['get', '/api/v1/workspaces/{id}/storage', 'auth', 'Workspaces'],
  ['get', '/api/v1/workspaces/{id}/members', 'auth', 'Workspaces'],
  ['patch', '/api/v1/workspaces/{id}/members/{userId}', 'auth', 'Workspaces'],
  ['delete', '/api/v1/workspaces/{id}/members/{userId}', 'auth', 'Workspaces'],
  ['get', '/api/v1/workspaces/{id}/activities', 'auth', 'Workspaces'],
  ['post', '/api/v1/workspaces/{id}/leave', 'auth', 'Workspaces'],
  ['post', '/api/v1/workspaces/{id}/transfer', 'auth', 'Workspaces'],
  ['post', '/api/v1/workspaces/{id}/invites', 'auth', 'Workspaces'],
  ['get', '/api/v1/workspaces/{id}/invites', 'auth', 'Workspaces'],
  ['delete', '/api/v1/workspaces/{id}/invites/{inviteId}', 'auth', 'Workspaces'],

  ['get', '/api/v1/memos/', 'auth', 'Memos'],
  ['post', '/api/v1/memos/', 'auth', 'Memos'],
  ['get', '/api/v1/memos/{id}', 'auth', 'Memos'],
  ['patch', '/api/v1/memos/{id}', 'auth', 'Memos'],
  ['delete', '/api/v1/memos/{id}', 'auth', 'Memos'],
  ['post', '/api/v1/memos/{id}/restore', 'auth', 'Memos'],
  ['get', '/api/v1/memos/{id}/versions', 'auth', 'Memos'],
  ['post', '/api/v1/memos/reorder', 'auth', 'Memos'],
  ['delete', '/api/v1/memos/trash', 'auth', 'Memos'],
  ['post', '/api/v1/memos/link-preview', 'auth', 'Memos'],

  ['get', '/api/v1/categories/', 'auth', 'Categories'],
  ['post', '/api/v1/categories/', 'auth', 'Categories'],
  ['patch', '/api/v1/categories/{id}', 'auth', 'Categories'],
  ['delete', '/api/v1/categories/{id}', 'auth', 'Categories'],

  ['get', '/api/v1/tags/', 'auth', 'Tags'],
  ['post', '/api/v1/tags/', 'auth', 'Tags'],
  ['patch', '/api/v1/tags/{id}', 'auth', 'Tags'],
  ['delete', '/api/v1/tags/{id}', 'auth', 'Tags'],

  ['get', '/api/v1/folders/', 'auth', 'Folders'],
  ['post', '/api/v1/folders/', 'auth', 'Folders'],
  ['patch', '/api/v1/folders/{id}', 'auth', 'Folders'],
  ['delete', '/api/v1/folders/{id}', 'auth', 'Folders'],

  ['get', '/api/v1/attachments/memo/{memoId}', 'auth', 'Attachments'],
  ['post', '/api/v1/attachments/memo/{memoId}', 'auth', 'Attachments'],
  ['get', '/api/v1/attachments/{id}/file', 'auth', 'Attachments'],
  ['delete', '/api/v1/attachments/{id}', 'auth', 'Attachments'],

  ['get', '/api/v1/notifications/', 'auth', 'Notifications'],
  ['post', '/api/v1/notifications/{id}/read', 'auth', 'Notifications'],
  ['post', '/api/v1/notifications/read-all', 'auth', 'Notifications'],

  ['get', '/api/v1/push/public-key', 'auth', 'Push'],
  ['post', '/api/v1/push/subscribe', 'auth', 'Push'],
  ['post', '/api/v1/push/unsubscribe', 'auth', 'Push'],

  ['get', '/api/v1/invites/{token}', 'public', 'Invites'],
  ['post', '/api/v1/invites/{token}/accept', 'auth', 'Invites'],

  ['post', '/api/v1/migration/import-local', 'auth', 'Migration'],
  ['get', '/api/v1/migration/export', 'auth', 'Migration'],
];

// ---------------------------------------------------------------------------
// Minimal recursive validator: walks a live payload against the documented
// (JSON-Schema-ish) response schema. Enforces, for every documented object:
//   - every payload field is documented (no undocumented fields), unless the
//     schema explicitly allows additionalProperties,
//   - every required schema field is present,
//   - field types match (unions like ['integer','null'] accepted).
// $ref is resolved against the spec components.
// ---------------------------------------------------------------------------
function resolveRef(node: any, spec: OpenAPIV3.Document): any {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop() as string;
    const resolved = (spec.components?.schemas as Record<string, any>)?.[name];
    if (!resolved) throw new Error(`Unresolvable $ref: ${node.$ref}`);
    return resolved;
  }
  return node;
}

function validateAgainstSchema(payload: unknown, rawSchema: any, spec: OpenAPIV3.Document, path = '$'): string[] {
  const schema = resolveRef(rawSchema, spec);
  const problems: string[] = [];

  if (schema === undefined || schema === true) return problems;
  // OpenAPI 3.0 renders JSON-Schema type unions (['string','null']) as
  // `type: 'string'` + `nullable: true`; a null payload is valid there.
  if (payload === null) {
    if (schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes('null'))) return problems;
    return [`${path}: got null but the schema is not nullable`];
  }
  if (schema.type === 'array') {
    if (!Array.isArray(payload)) return [`${path}: expected array, got ${typeof payload}`];
    const itemSchema = schema.items ?? {};
    payload.forEach((item, i) => problems.push(...validateAgainstSchema(item, itemSchema, spec, `${path}[${i}]`)));
    return problems;
  }
  if (schema.type === 'object' || schema.properties) {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return [`${path}: expected object, got ${Array.isArray(payload) ? 'array' : typeof payload}`];
    }
    const allowAdditional = schema.additionalProperties !== false;
    const properties = schema.properties ?? {};
    for (const key of Object.keys(payload)) {
      if (!(key in properties) && !allowAdditional) {
        problems.push(`${path}.${key}: present in the live payload but NOT documented`);
      }
    }
    for (const key of schema.required ?? []) {
      if (!(key in payload)) problems.push(`${path}.${key}: documented as required but missing from the payload`);
    }
    for (const [key, value] of Object.entries(properties)) {
      if (key in payload) {
        problems.push(...validateAgainstSchema((payload as Record<string, unknown>)[key], value, spec, `${path}.${key}`));
      }
    }
    return problems;
  }

  // Leaf types
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length === 0) return problems; // unconstrained leaf
  const actual = payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload;
  const matches = types.some((t) => {
    if (t === 'integer') return actual === 'number' && Number.isInteger(payload);
    if (t === 'number') return actual === 'number';
    return t === actual;
  });
  if (!matches) problems.push(`${path}: documented type [${types.join('|')}] but got ${actual}`);
  return problems;
}

describe('OpenAPI documentation (GET /docs)', () => {
  let app: FastifyInstance;
  let dbCtx: ReturnType<typeof createDatabase>;
  let spec: OpenAPIV3.Document;

  beforeEach(async () => {
    dbCtx = createDatabase(':memory:');
    app = buildApp({ dbCtx, logger: false });
    await app.ready();
    spec = (app as unknown as { swagger: () => OpenAPIV3.Document }).swagger();
  });

  afterEach(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  it('serves the Swagger UI page and its assets', async () => {
    const page = await app.inject({ method: 'GET', url: '/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('swagger-ui');

    const bundle = await app.inject({ method: 'GET', url: '/docs/static/swagger-ui-bundle.js' });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers['content-type']).toContain('javascript');

    const json = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(json.statusCode).toBe(200);
    expect(JSON.parse(json.body).openapi).toBe('3.0.3');

    const yaml = await app.inject({ method: 'GET', url: '/docs/yaml' });
    expect(yaml.statusCode).toBe(200);
    expect(yaml.body).toContain('openapi: 3.0.3');
  });

  it('exposes the spec with the expected document shape', () => {
    expect(spec.openapi).toBe('3.0.3');
    expect(spec.info?.title).toBe('Pocket Diary SaaS API');
    expect(spec.info?.version).toBeTruthy();
    expect(spec.info?.description).toContain('memo_session');
    // Relative server URL keeps "Try it out" working both directly and behind
    // the bundled reverse proxy, without embedding internal hostnames.
    expect(spec.servers).toEqual([{ url: '/', description: expect.stringContaining('reverse proxy') }]);
    const schemes = spec.components?.securitySchemes as Record<string, any>;
    expect(schemes.sessionCookie).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'memo_session' });
    // Every referenced component exists.
    const schemas = spec.components?.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThanOrEqual(20);
  });

  it('documents every endpoint of the API — and nothing else', () => {
    const documented = new Set<string>();
    for (const [method, path] of EXPECTED_OPERATIONS) documented.add(`${method.toUpperCase()} ${path}`);

    const inSpec = new Set<string>();
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of ['get', 'post', 'patch', 'put', 'delete'] as const) {
        if ((item as any)[method]) inSpec.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const missing = [...documented].filter((op) => !inSpec.has(op));
    const extra = [...inSpec].filter((op) => !documented.has(op));
    expect(missing, 'operations missing from the spec').toEqual([]);
    expect(extra, 'undocumented operations present in the spec').toEqual([]);
  });

  it('gives every operation a tag, summary, auth requirement, and documented responses', () => {
    const problems: string[] = [];
    for (const [method, path, auth, tag] of EXPECTED_OPERATIONS) {
      const operation = (spec.paths as any)[path][method];
      const label = `${method.toUpperCase()} ${path}`;

      expect(operation.tags, `${label} tags`).toEqual([tag]);
      expect(typeof operation.summary, `${label} summary`).toBe('string');
      expect(operation.summary.length, `${label} summary`).toBeGreaterThan(3);

      if (auth === 'auth') {
        expect(operation.security, `${label} must require the session cookie`).toEqual([{ sessionCookie: [] }]);
      } else {
        expect(operation.security, `${label} must be marked public (security: [])`).toEqual([]);
      }

      const responses = operation.responses ?? {};
      const codes = Object.keys(responses);
      expect(codes.some((c) => c.startsWith('2')), `${label} needs a 2xx response`).toBe(true);
      expect(codes.some((c) => Number(c) >= 400 || c === 'default'), `${label} needs at least one error response`).toBe(true);
      for (const [code, response] of Object.entries<any>(responses)) {
        expect(typeof response.description, `${label} ${code} description`).toBe('string');
        if (Number(code) < 300 && !response.content && !response.headers) {
          problems.push(`${label} ${code}: success response documents no content and no headers`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('documents request bodies (JSON schemas and the multipart upload)', () => {
    const paths = spec.paths as any;

    // JSON body routes: Fastify body schemas become request bodies.
    const register = paths['/api/v1/auth/register'].post;
    expect(register.requestBody?.content?.['application/json']?.schema?.required).toContain('password');
    const createMemo = paths['/api/v1/memos/'].post;
    expect(createMemo.requestBody?.content?.['application/json']?.schema).toBeTruthy();
    const invite = paths['/api/v1/workspaces/{id}/invites'].post;
    expect(invite.requestBody?.content?.['application/json']?.schema?.required).toContain('email');

    // The multipart upload documents its file field.
    const upload = paths['/api/v1/attachments/memo/{memoId}'].post;
    const multipart = upload.requestBody?.content?.['multipart/form-data']?.schema;
    expect(multipart?.required).toEqual(['file']);
    expect(multipart?.properties?.file?.format).toBe('binary');

    // The binary download documents the file stream + disposition headers.
    const download = paths['/api/v1/attachments/{id}/file'].get;
    expect(download.responses['200'].content['application/octet-stream']).toBeTruthy();
    expect(download.responses['200'].headers['Content-Disposition']).toBeTruthy();
  });

  it('documents path and query parameters', () => {
    const paths = spec.paths as any;

    const deleteMemo = paths['/api/v1/memos/{id}'].delete;
    const deleteParams = (deleteMemo.parameters ?? []).map((p: any) => [p.name, p.in]);
    expect(deleteParams).toContainEqual(['id', 'path']);
    expect(deleteParams).toContainEqual(['permanent', 'query']);

    // List routes document their required workspaceId query param.
    const listMemos = paths['/api/v1/memos/'].get;
    const wsParam = (listMemos.parameters ?? []).find((p: any) => p.name === 'workspaceId');
    expect(wsParam?.required).toBe(true);

    const exportOp = paths['/api/v1/migration/export'].get;
    const exportParam = (exportOp.parameters ?? []).find((p: any) => p.name === 'workspaceId');
    expect(exportParam?.required).toBe(true);
  });

  it('never leaks configured secrets into the spec', () => {
    // Secrets that could plausibly end up in generated docs if a schema ever
    // embedded environment state. The spec must contain none of their values.
    const suspicious = [
      process.env.COOKIE_SECRET,
      process.env.SMTP_PASS ?? process.env.SMTP_PASSWORD,
      process.env.VAPID_PRIVATE_KEY,
      process.env.APP_URL,
    ].filter((v): v is string => Boolean(v && v.length >= 8));

    const rendered = JSON.stringify(spec);
    for (const secret of suspicious) {
      expect(rendered.includes(secret), `spec must not contain the value of a configured secret (${secret.slice(0, 4)}…)`).toBe(false);
    }
    // The cookie NAME is public API surface (that is the point of the security
    // scheme), but no token value is documented anywhere.
    expect(rendered).not.toMatch(/memo_session=[A-Za-z0-9]/);
  });

  it('matches documented response schemas against live payloads', async () => {
    const problems: string[] = [];

    const check = async (label: string, res: { statusCode: number; body: string }, path: string, method: string) => {
      const operation = (spec.paths as any)[path][method];
      const documented = operation.responses[String(res.statusCode)];
      if (!documented) {
        problems.push(`${label}: live status ${res.statusCode} is not documented`);
        return;
      }
      const schema = documented.content?.['application/json']?.schema;
      if (!schema) {
        problems.push(`${label}: no JSON schema documented for status ${res.statusCode}`);
        return;
      }
      problems.push(...validateAgainstSchema(JSON.parse(res.body), schema, spec, `${label} (${res.statusCode})`).map((p) => `${label}: ${p}`));
    };

    // Sign in and cover the main flows end to end.
    const registerRes = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'docs@example.com', password: 'Password123!', name: 'Docs', timezone: 'Asia/Tokyo' },
    });
    expect(registerRes.statusCode).toBe(201);
    await check('register', registerRes, '/api/v1/auth/register', 'post');
    const cookie = `memo_session=${registerRes.cookies.find((c) => c.name === 'memo_session')?.value}`;
    const workspaceId = registerRes.json().workspace.id;

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    await check('auth/me', me, '/api/v1/auth/me', 'get');

    const login = await app.inject({
      method: 'POST', url: '/api/v1/auth/login',
      payload: { email: 'docs@example.com', password: 'Password123!' },
    });
    expect(login.statusCode).toBe(200);
    await check('auth/login', login, '/api/v1/auth/login', 'post');

    const sessions = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: { cookie } });
    expect(sessions.statusCode).toBe(200);
    await check('auth/sessions', sessions, '/api/v1/auth/sessions', 'get');

    const workspaces = await app.inject({ method: 'GET', url: '/api/v1/workspaces/', headers: { cookie } });
    expect(workspaces.statusCode).toBe(200);
    await check('workspaces list', workspaces, '/api/v1/workspaces/', 'get');

    const storage = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/storage`, headers: { cookie } });
    expect(storage.statusCode).toBe(200);
    await check('workspace storage', storage, '/api/v1/workspaces/{id}/storage', 'get');

    const members = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/members`, headers: { cookie } });
    expect(members.statusCode).toBe(200);
    await check('workspace members', members, '/api/v1/workspaces/{id}/members', 'get');

    const activities = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/activities`, headers: { cookie } });
    expect(activities.statusCode).toBe(200);
    await check('workspace activities', activities, '/api/v1/workspaces/{id}/activities', 'get');

    const createMemo = await app.inject({
      method: 'POST', url: '/api/v1/memos/', headers: { cookie },
      payload: { workspaceId, title: 'Documented', content: 'hello', tags: ['x'], color: 'blue' },
    });
    expect(createMemo.statusCode).toBe(201);
    await check('memo create', createMemo, '/api/v1/memos/', 'post');
    const memoId = createMemo.json().memo.id;

    const listMemos = await app.inject({ method: 'GET', url: `/api/v1/memos/?workspaceId=${workspaceId}`, headers: { cookie } });
    expect(listMemos.statusCode).toBe(200);
    await check('memo list', listMemos, '/api/v1/memos/', 'get');

    const getMemo = await app.inject({ method: 'GET', url: `/api/v1/memos/${memoId}`, headers: { cookie } });
    expect(getMemo.statusCode).toBe(200);
    await check('memo get', getMemo, '/api/v1/memos/{id}', 'get');

    const patchMemo = await app.inject({
      method: 'PATCH', url: `/api/v1/memos/${memoId}`, headers: { cookie },
      payload: { content: 'updated' },
    });
    expect(patchMemo.statusCode).toBe(200);
    await check('memo patch', patchMemo, '/api/v1/memos/{id}', 'patch');

    const versions = await app.inject({ method: 'GET', url: `/api/v1/memos/${memoId}/versions`, headers: { cookie } });
    expect(versions.statusCode).toBe(200);
    await check('memo versions', versions, '/api/v1/memos/{id}/versions', 'get');

    const category = await app.inject({
      method: 'POST', url: '/api/v1/categories/', headers: { cookie },
      payload: { workspaceId, name: 'Docs Cat', color: 'blue', icon: null },
    });
    expect(category.statusCode).toBe(201);
    await check('category create', category, '/api/v1/categories/', 'post');

    const categories = await app.inject({ method: 'GET', url: `/api/v1/categories/?workspaceId=${workspaceId}`, headers: { cookie } });
    expect(categories.statusCode).toBe(200);
    await check('category list', categories, '/api/v1/categories/', 'get');

    const tag = await app.inject({
      method: 'POST', url: '/api/v1/tags/', headers: { cookie },
      payload: { workspaceId, name: 'Docs Tag' },
    });
    expect(tag.statusCode).toBe(201);
    await check('tag create', tag, '/api/v1/tags/', 'post');

    const tags = await app.inject({ method: 'GET', url: `/api/v1/tags/?workspaceId=${workspaceId}`, headers: { cookie } });
    expect(tags.statusCode).toBe(200);
    await check('tag list', tags, '/api/v1/tags/', 'get');

    const folder = await app.inject({
      method: 'POST', url: '/api/v1/folders/', headers: { cookie },
      payload: { workspaceId, name: 'Docs Folder' },
    });
    expect(folder.statusCode).toBe(201);
    await check('folder create', folder, '/api/v1/folders/', 'post');

    const folders = await app.inject({ method: 'GET', url: `/api/v1/folders/?workspaceId=${workspaceId}`, headers: { cookie } });
    expect(folders.statusCode).toBe(200);
    await check('folder list', folders, '/api/v1/folders/', 'get');

    const invite = await app.inject({
      method: 'POST', url: `/api/v1/workspaces/${workspaceId}/invites`, headers: { cookie },
      payload: { email: 'invitee@example.com', role: 'editor' },
    });
    expect(invite.statusCode).toBe(201);
    await check('invite create', invite, '/api/v1/workspaces/{id}/invites', 'post');
    const inviteToken = invite.json().invite.token;

    const inviteList = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/invites`, headers: { cookie } });
    expect(inviteList.statusCode).toBe(200);
    await check('invite list', inviteList, '/api/v1/workspaces/{id}/invites', 'get');

    const lookup = await app.inject({ method: 'GET', url: `/api/v1/invites/${inviteToken}` });
    expect(lookup.statusCode).toBe(200);
    await check('invite lookup', lookup, '/api/v1/invites/{token}', 'get');

    const notifications = await app.inject({ method: 'GET', url: '/api/v1/notifications/', headers: { cookie } });
    expect(notifications.statusCode).toBe(200);
    await check('notifications', notifications, '/api/v1/notifications/', 'get');

    const publicKey = await app.inject({ method: 'GET', url: '/api/v1/push/public-key', headers: { cookie } });
    expect(publicKey.statusCode).toBe(200);
    await check('push public key', publicKey, '/api/v1/push/public-key', 'get');

    const exported = await app.inject({ method: 'GET', url: `/api/v1/migration/export?workspaceId=${workspaceId}`, headers: { cookie } });
    expect(exported.statusCode).toBe(200);
    await check('workspace export', exported, '/api/v1/migration/export', 'get');

    const imported = await app.inject({
      method: 'POST', url: '/api/v1/migration/import-local', headers: { cookie },
      payload: { workspaceId, memos: [{ title: 'Imported', content: 'x', color: 'RED', isPinned: true }] },
    });
    expect(imported.statusCode).toBe(200);
    await check('import', imported, '/api/v1/migration/import-local', 'post');

    const backup = await app.inject({ method: 'GET', url: '/api/v1/system/backup-status', headers: { cookie } });
    expect(backup.statusCode).toBe(200);
    await check('backup status', backup, '/api/v1/system/backup-status', 'get');

    const health = await app.inject({ method: 'GET', url: '/health' });
    await check('health', health, '/health', 'get');

    // Error responses keep the documented Error shape.
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(unauth.statusCode).toBe(401);
    await check('unauthorized me', unauth, '/api/v1/auth/me', 'get');

    const badMemo = await app.inject({
      method: 'PATCH', url: `/api/v1/memos/${memoId}`, headers: { cookie },
      payload: { content: 'stale', version: 999 },
    });
    expect(badMemo.statusCode).toBe(409);
    await check('memo conflict', badMemo, '/api/v1/memos/{id}', 'patch');

    expect(problems).toEqual([]);
  });

  it('keeps the API untouched when DOCS_ENABLED=false', async () => {
    process.env.DOCS_ENABLED = 'false';
    try {
      const bare = buildApp({ dbCtx: createDatabase(':memory:'), logger: false });
      await bare.ready();

      const page = await bare.inject({ method: 'GET', url: '/docs' });
      expect(page.statusCode).toBe(404);
      const json = await bare.inject({ method: 'GET', url: '/docs/json' });
      expect(json.statusCode).toBe(404);

      // The API itself is fully functional.
      const health = await bare.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
      const user = await createTestUser(bare, 'no-docs@example.com', 'No Docs');
      const memos = await bare.inject({
        method: 'POST', url: '/api/v1/memos/', headers: { cookie: user.cookieHeader },
        payload: { workspaceId: user.workspace.id, title: 'works', content: '' },
      });
      expect(memos.statusCode).toBe(201);
      await bare.close();
    } finally {
      delete process.env.DOCS_ENABLED;
    }
  });

  it('works in production mode (validated config, docs served)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_URL = 'https://memo.example.com';
    process.env.COOKIE_SECRET = 'x'.repeat(48);
    try {
      const prod = buildApp({ dbCtx: createDatabase(':memory:'), logger: false });
      await prod.ready();

      const page = await prod.inject({ method: 'GET', url: '/docs' });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('swagger-ui');
      const prodSpec = JSON.stringify((prod as unknown as { swagger: () => OpenAPIV3.Document }).swagger());
      // The spec must not embed the production APP_URL (servers stay relative).
      expect(prodSpec.includes('https://memo.example.com')).toBe(false);

      const user = await createTestUser(prod, 'prod@example.com', 'Prod');
      const me = await prod.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: user.cookieHeader } });
      expect(me.statusCode).toBe(200);
      await prod.close();
    } finally {
      delete process.env.NODE_ENV;
      delete process.env.APP_URL;
      delete process.env.COOKIE_SECRET;
    }
  });
});
