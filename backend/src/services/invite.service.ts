/**
 * Workspace invitation service.
 * Token-based invites that work with or without email delivery:
 *  - With SMTP configured, an invite email is sent automatically.
 *  - Without SMTP, the caller surfaces the invite link for manual sharing.
 *
 * Security (audit H-7, M-1): only the SHA-256 hash of an invitation token is
 * stored. A database/backup reader can no longer accept invites. Re-inviting
 * a pending (or expired-pending) address now issues a FRESH token and a new
 * expiry window — the previous code returned the stale token with its old,
 * possibly already-past, expiresAt, making the link dead on arrival.
 */
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { users, workspaceInvites, workspaceMembers, workspaces } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';
import { sendEmail, renderInviteEmail, isEmailEnabled } from './mailer.service.js';

export const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Hashes an invite token for storage/lookup — the raw token is only ever returned once at creation. */
export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class InviteError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'InviteError';
    this.statusCode = statusCode;
  }
}

export interface InviteResult {
  invite: {
    id: string;
    email: string;
    role: string;
    status: string;
    /** Raw invitation token — clients build shareable links from their own origin. */
    token: string;
    expiresAt: number;
    createdAt: number;
    emailSent: boolean;
  };
  inviteUrl: string;
}

export function createInvite(
  dbCtx: DatabaseContext,
  params: { workspaceId: string; email: string; role: string; invitedByUserId: string; appUrl: string },
): InviteResult {
  const normalizedEmail = params.email.trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new InviteError('A valid email address is required', 400);
  }

  const role = ['viewer', 'editor', 'admin'].includes(params.role) ? params.role : 'editor';

  // Target already a member?
  const existingMember = dbCtx.sqlite
    .prepare(
      `SELECT u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND LOWER(u.email) = ?`,
    )
    .get(params.workspaceId, normalizedEmail) as { email: string } | undefined;
  if (existingMember) {
    throw new InviteError('This user is already a member of the workspace', 409);
  }

  // Reuse a pending invite row for the same email instead of stacking
  // duplicates — but issue a FRESH token and reset the expiry window so the
  // re-sent link actually works (audit M-1).
  const now = Date.now();
  const existingInvite = dbCtx.db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, params.workspaceId),
        eq(workspaceInvites.email, normalizedEmail),
        eq(workspaceInvites.status, 'pending'),
      ),
    )
    .get();

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashInviteToken(token);
  const expiresAt = now + INVITE_EXPIRY_MS;
  const inviteId = existingInvite?.id ?? crypto.randomUUID();

  if (!existingInvite) {
    dbCtx.db
      .insert(workspaceInvites)
      .values({
        id: inviteId,
        workspaceId: params.workspaceId,
        email: normalizedEmail,
        role,
        token: tokenHash,
        status: 'pending',
        invitedBy: params.invitedByUserId,
        expiresAt,
        createdAt: now,
      })
      .run();
  } else {
    dbCtx.db
      .update(workspaceInvites)
      .set({ role, token: tokenHash, expiresAt })
      .where(eq(workspaceInvites.id, inviteId))
      .run();
  }

  const inviteUrl = `${params.appUrl.replace(/\/$/, '')}/#invite=${token}`;
  return {
    invite: {
      id: inviteId,
      email: normalizedEmail,
      role,
      status: 'pending',
      // Raw token — returned exactly once; only its hash is persisted.
      token,
      expiresAt,
      createdAt: existingInvite?.createdAt ?? now,
      emailSent: false,
    },
    inviteUrl,
  };
}

/** Send (or re-send) the invitation email for a pending invite. */
export async function sendInviteEmail(
  dbCtx: DatabaseContext,
  params: { inviteId: string; token: string; appUrl: string },
): Promise<boolean> {
  if (!isEmailEnabled()) return false;

  const invite = dbCtx.db.select().from(workspaceInvites).where(eq(workspaceInvites.id, params.inviteId)).get();
  if (!invite || invite.status !== 'pending') return false;

  const workspace = dbCtx.db.select().from(workspaces).where(eq(workspaces.id, invite.workspaceId)).get();
  const inviter = dbCtx.db.select().from(users).where(eq(users.id, invite.invitedBy)).get();
  if (!workspace || !inviter) return false;

  // Only the token hash is persisted (audit H-7); the raw token is passed in
  // by the caller that just generated it.
  const inviteUrl = `${params.appUrl.replace(/\/$/, '')}/#invite=${params.token}`;
  const email = renderInviteEmail({
    workspaceName: workspace.name,
    inviterName: inviter.name,
    inviteUrl,
    role: invite.role,
  });

  const sent = await sendEmail({ to: invite.email, ...email });
  if (sent) {
    dbCtx.db
      .update(workspaceInvites)
      .set({ emailSentAt: Date.now() })
      .where(eq(workspaceInvites.id, invite.id))
      .run();
  }
  return sent;
}

export function listInvites(
  dbCtx: DatabaseContext,
  workspaceId: string,
): Array<{
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: number;
  createdAt: number;
  emailSentAt: number | null;
}> {
  return dbCtx.db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.workspaceId, workspaceId))
    .all()
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      status: i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
      emailSentAt: i.emailSentAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function revokeInvite(dbCtx: DatabaseContext, workspaceId: string, inviteId: string): boolean {
  const result = dbCtx.db
    .update(workspaceInvites)
    .set({ status: 'revoked' })
    .where(
      and(
        eq(workspaceInvites.id, inviteId),
        eq(workspaceInvites.workspaceId, workspaceId),
        eq(workspaceInvites.status, 'pending'),
      ),
    )
    .run();
  return result.changes > 0;
}

export interface InviteLookup {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: string;
  status: string;
  expiresAt: number;
}

export function lookupInvite(dbCtx: DatabaseContext, token: string): InviteLookup | null {
  if (!token) return null;
  const row = dbCtx.sqlite
    .prepare(
      `SELECT i.id, i.workspace_id, i.email, i.role, i.status, i.expires_at, w.name AS workspace_name
       FROM workspace_invites i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.token = ?`,
    )
    .get(hashInviteToken(token)) as any;
  if (!row) return null;

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    email: row.email,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

/** Accept a pending invite: joins the user to the workspace with the invited role. */
export function acceptInvite(dbCtx: DatabaseContext, token: string, userId: string): InviteLookup {
  const invite = lookupInvite(dbCtx, token);
  if (!invite) throw new InviteError('Invitation not found', 404);
  if (invite.status === 'revoked') throw new InviteError('This invitation has been revoked', 410);
  if (invite.status === 'accepted') throw new InviteError('This invitation has already been used', 410);
  if (invite.expiresAt < Date.now()) throw new InviteError('This invitation has expired', 410);

  // Security (SEC-02): invitations are addressed to a specific email address.
  // Only the authenticated account that owns that address may claim the invite —
  // otherwise a leaked/forwarded token would grant workspace access (and the
  // invited role's permissions) to any third party.
  const currentUser = dbCtx.db.select().from(users).where(eq(users.id, userId)).get();
  if (!currentUser || currentUser.email.trim().toLowerCase() !== String(invite.email).trim().toLowerCase()) {
    throw new InviteError('This invitation was sent to a different email address. Sign in with the invited account to accept it.', 403);
  }

  const alreadyMember = dbCtx.db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, invite.workspaceId), eq(workspaceMembers.userId, userId)))
    .get();
  if (alreadyMember) {
    throw new InviteError('You are already a member of this workspace', 409);
  }

  const now = Date.now();
  dbCtx.db.transaction((tx) => {
    tx.insert(workspaceMembers)
      .values({ id: crypto.randomUUID(), workspaceId: invite.workspaceId, userId, role: invite.role, createdAt: now })
      .run();
    tx.update(workspaceInvites)
      .set({ status: 'accepted' })
      .where(eq(workspaceInvites.id, invite.id))
      .run();
  });

  return invite;
}
