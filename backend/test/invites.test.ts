import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createDatabase } from '../src/db/index.js';
import { createTestUser } from './helpers.js';
import { hashSessionToken } from '../src/services/auth.service.js';
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';

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

  /**
   * Test fixture: place a registered user into a workspace with a role.
   * The HTTP endpoint that used to do this (POST /workspaces/:id/members)
   * was removed (audit H-3) because it bypassed invitation consent and
   * allowed account enumeration — memberships are seeded directly in the DB.
   */
  const addMemberDirect = async (workspaceId: string, email: string, role: string) => {
    const { user } = await createTestUser(app, email, email.split('@')[0]);
    dbCtx.sqlite
      .prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), workspaceId, user.id, role, Date.now());
    return { userId: user.id, email };
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

    // Memberships are seeded directly (audit H-3 removed the direct-add endpoint)
    const admin = await addMemberDirect(workspace.id, 'ws-admin@example.com', 'admin');
    const editor = await addMemberDirect(workspace.id, 'ws-editor@example.com', 'editor');

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
    const addSecondAdmin = await addMemberDirect(workspace.id, 'ws-admin2@example.com', 'admin');
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

  it('changes member roles with permission rules (audit H-8: admin role is owner-only)', async () => {
    const { workspace, cookieHeader } = await createTestUser(app, 'role-owner@example.com');
    const editorMember = await addMemberDirect(workspace.id, 'role-editor@example.com', 'editor');
    const memberId = editorMember.userId;
    const adminMember = await addMemberDirect(workspace.id, 'role-admin@example.com', 'admin');

    // Owner promotes to admin
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
      headers: { cookie: cookieHeader },
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().member.role).toBe('admin');

    // Audit H-8: a workspace admin may NOT demote a fellow admin — the
    // previous privilege model allowed demote-then-remove of other admins.
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'role-admin@example.com', password: 'Password123!' },
    });
    const adminCookie = `memo_session=${adminLogin.cookies.find((c: any) => c.name === 'memo_session')?.value}`;
    const adminDemotesAdmin = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
      headers: { cookie: adminCookie },
      payload: { role: 'viewer' },
    });
    expect(adminDemotesAdmin.statusCode).toBe(403);

    // Audit H-8: a workspace admin may NOT grant admin to a plain member
    const plainMember = await addMemberDirect(workspace.id, 'role-plain@example.com', 'editor');
    const adminGrantsAdmin = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${plainMember.userId}`,
      headers: { cookie: adminCookie },
      payload: { role: 'admin' },
    });
    expect(adminGrantsAdmin.statusCode).toBe(403);

    // An admin may still change a plain editor's role (non-admin transitions)
    const adminEditsEditor = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${plainMember.userId}`,
      headers: { cookie: adminCookie },
      payload: { role: 'viewer' },
    });
    expect(adminEditsEditor.statusCode).toBe(200);

    // Owner demotes back to editor, then to viewer
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
      headers: { cookie: cookieHeader },
      payload: { role: 'editor' },
    });
    expect(demote.statusCode).toBe(200);
    const demoteAgain = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace.id}/members/${memberId}`,
      headers: { cookie: cookieHeader },
      payload: { role: 'viewer' },
    });
    expect(demoteAgain.statusCode).toBe(200);
    expect(demoteAgain.json().member.role).toBe('viewer');

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
    await addMemberDirect(workspace.id, 'no-invite-member@example.com', 'editor');

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
