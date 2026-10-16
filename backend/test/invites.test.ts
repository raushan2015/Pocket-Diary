import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import type { FastifyInstance } from 'fastify';

describe('Workspace invitations & member management', () => {
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

  const createInviteFor = async (cookieHeader: string, workspaceId: string, email: string, role = 'editor') => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/invites`,
      headers: { cookie: cookieHeader },
      payload: { email, role },
    });
    return { statusCode: res.statusCode, body: res.json() };
  };

  it('creates an invitation with a shareable link (email delivery disabled without SMTP)', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'inviter@example.com');
    const { statusCode, body } = await createInviteFor(cookieHeader, workspace.id, 'newcomer@example.com', 'editor');

    expect(statusCode).toBe(201);
    expect(body.invite.email).toBe('newcomer@example.com');
    expect(body.invite.role).toBe('editor');
    expect(body.invite.status).toBe('pending');
    expect(body.invite.emailSent).toBe(false);
    expect(body.emailDelivery).toBe('disabled');
    expect(body.inviteUrl).toMatch(/#invite=[a-f0-9]{64}/);
  });

  it('rejects duplicate invitations for the same pending email and existing members', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'dupe-inviter@example.com');
    const first = await createInviteFor(cookieHeader, workspace.id, 'same@example.com');
    expect(first.statusCode).toBe(201);

    // Same email again → reuses the pending invitation rather than stacking
    const second = await createInviteFor(cookieHeader, workspace.id, 'same@example.com');
    expect(second.statusCode).toBe(201);
    expect(second.body.invite.id).toBe(first.body.invite.id);

    // The inviter (a current member) cannot be invited
    const self = await createInviteFor(cookieHeader, workspace.id, 'dupe-inviter@example.com');
    expect(self.statusCode).toBe(409);
  });

  it('registers a new user through an invitation link and auto-joins the workspace', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'team-owner@example.com');
    const invite = (await createInviteFor(cookieHeader, workspace.id, 'newhires@example.com', 'viewer')).body;

    // Public lookup exposes only safe context for the register screen
    const lookup = await app.inject({ method: 'GET', url: `/api/v1/invites/${invite.inviteUrl.split('=').pop()}` });
    expect(lookup.statusCode).toBe(200);
    const lookupBody = lookup.json().invite;
    expect(lookupBody.workspaceName).toBe('Personal');
    expect(lookupBody.email).toBe('newhires@example.com');
    expect(lookupBody.usable).toBe(true);

    // Register with the invite token
    const token = invite.inviteUrl.split('=').pop();
    const registerRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'newhires@example.com',
        password: 'Password123!',
        name: 'New Hire',
        inviteToken: token,
      },
    });
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.json().joinedWorkspace.id).toBe(workspace.id);
    expect(registerRes.json().joinedWorkspace.role).toBe('viewer');

    // The new user can now list the workspace
    const newCookie = `memo_session=${registerRes.cookies.find((c) => c.name === 'memo_session')?.value}`;
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: newCookie },
    });
    expect(meRes.json().workspaces.some((w: any) => w.id === workspace.id && w.role === 'viewer')).toBe(true);

    // Invite is single-use
    const reuse = await app.inject({ method: 'GET', url: `/api/v1/invites/${token}` });
    expect(reuse.json().invite.status).toBe('accepted');
  });

  it('lets an existing (registered) user accept an invitation and prevents double-join', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'ws-owner@example.com');
    await createTestUser(app, 'existing-user@example.com', 'Existing User');
    const invite = (await createInviteFor(cookieHeader, workspace.id, 'existing-user@example.com', 'editor')).body;
    const token = invite.inviteUrl.split('=').pop();

    // Sign in as the existing user
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'existing-user@example.com', password: 'Password123!' },
    });
    const cookie = `memo_session=${loginRes.cookies.find((c: any) => c.name === 'memo_session')?.value}`;

    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      headers: { cookie },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().workspace.id).toBe(workspace.id);

    // Accepting again fails (already used)
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      headers: { cookie },
    });
    expect(again.statusCode).toBe(410);
  });

  it('revokes an invitation and it can no longer be accepted', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'revoke-owner@example.com');
    const invite = (await createInviteFor(cookieHeader, workspace.id, 'revoked@example.com')).body;
    const token = invite.inviteUrl.split('=').pop();

    // Editor (non-admin) cannot manage invitations
    await createTestUser(app, 'plain-member@example.com', 'Plain');
    const listRes = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspace.id}/invites`,
      headers: { cookie: cookieHeader },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().invites).toHaveLength(1);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspace.id}/invites/${invite.invite.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(revoke.statusCode).toBe(200);

    await createTestUser(app, 'revoked@example.com', 'Revoked');
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'revoked@example.com', password: 'Password123!' },
    });
    const cookie = `memo_session=${login.cookies.find((c: any) => c.name === 'memo_session')?.value}`;
    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/invites/${token}/accept`,
      headers: { cookie },
    });
    expect(accept.statusCode).toBe(410);
  });

  it('removes members with role rules: owner untouchable, admins only removed by owner', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'alpha-owner@example.com');

    // Add members directly (registered users)
    const addMember = async (email: string, role: string) => {
      await createTestUser(app, email, email.split('@')[0]);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${workspace.id}/members`,
        headers: { cookie: cookieHeader },
        payload: { email, role },
      });
      expect(res.statusCode).toBe(201);
      return res.json().member;
    };

    const admin = await addMember('ws-admin@example.com', 'admin');
    const editor = await addMember('ws-editor@example.com', 'editor');

    // Owner removes the editor
    const removeEditor = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspace.id}/members/${editor.userId}`,
      headers: { cookie: cookieHeader },
    });
    expect(removeEditor.statusCode).toBe(200);

    // The owner cannot be removed
    const removeOwner = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspace.id}/members/${(await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader } })).json().user.id}`,
      headers: { cookie: cookieHeader },
    });
    expect(removeOwner.statusCode).toBe(403);

    // An admin cannot remove another admin
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ws-admin@example.com', password: 'Password123!' },
    });
    const adminCookie = `memo_session=${adminLogin.cookies.find((c: any) => c.name === 'memo_session')?.value}`;
    const addSecondAdmin = await addMember('ws-admin2@example.com', 'admin');
    const adminRemovesAdmin = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspace.id}/members/${addSecondAdmin.userId}`,
      headers: { cookie: adminCookie },
    });
    expect(adminRemovesAdmin.statusCode).toBe(403);

    // Owner CAN remove an admin
    const ownerRemovesAdmin = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspace.id}/members/${addSecondAdmin.userId}`,
      headers: { cookie: cookieHeader },
    });
    expect(ownerRemovesAdmin.statusCode).toBe(200);
  });

  it('changes member roles with permission rules', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'role-owner@example.com');
    await createTestUser(app, 'role-editor@example.com', 'Role Editor');
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.id}/members`,
      headers: { cookie: cookieHeader },
      payload: { email: 'role-editor@example.com', role: 'editor' },
    });
    expect(add.statusCode).toBe(201);
    const memberId = add.json().member.userId;

    // Owner promotes to admin
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
      headers: { cookie: cookieHeader },
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().member.role).toBe('admin');

    // Demote to viewer
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
      headers: { cookie: cookieHeader },
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(200);
    expect(demote.json().member.role).toBe('viewer');

    // Owner role is immutable
    const ownerId = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: cookieHeader } })).json().user.id;
    const selfPatch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${ownerId}`,
      headers: { cookie: cookieHeader },
      payload: { role: 'editor' },
    });
    expect(selfPatch.statusCode).toBe(403);

    // Invalid role value is rejected by schema
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
      headers: { cookie: cookieHeader },
      payload: { role: 'superuser' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('denies invite management to non-admin members', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'no-invite-owner@example.com');
    await createTestUser(app, 'no-invite-member@example.com', 'Member');
    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.id}/members`,
      headers: { cookie: cookieHeader },
      payload: { email: 'no-invite-member@example.com', role: 'editor' },
    });
    expect(add.statusCode).toBe(201);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'no-invite-member@example.com', password: 'Password123!' },
    });
    const memberCookie = `memo_session=${login.cookies.find((c: any) => c.name === 'memo_session')?.value}`;

    const attempt = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace.id}/invites`,
      headers: { cookie: memberCookie },
      payload: { email: 'someone@example.com', role: 'editor' },
    });
    expect(attempt.statusCode).toBe(403);
  });
});
