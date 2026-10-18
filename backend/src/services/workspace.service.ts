import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { workspaces, workspaceMembers, notifications } from '../db/schema.js';
import type { Workspace, WorkspaceMember } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';

export class WorkspaceAccessError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 403) {
    super(message);
    this.name = 'WorkspaceAccessError';
    this.statusCode = statusCode;
  }
}

export function getWorkspaceMembership(
  db: DatabaseContext['db'],
  userId: string,
  workspaceId: string
): WorkspaceMember | undefined {
  return db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.workspaceId, workspaceId)
      )
    )
    .get();
}

export function verifyWorkspaceMembership(
  db: DatabaseContext['db'],
  userId: string,
  workspaceId: string,
  allowedRoles?: string[]
): WorkspaceMember {
  if (!workspaceId) {
    throw new WorkspaceAccessError('workspaceId is required', 400);
  }

  const member = getWorkspaceMembership(db, userId, workspaceId);
  if (!member) {
    throw new WorkspaceAccessError('Access denied: You are not a member of this workspace', 403);
  }

  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(member.role)) {
    throw new WorkspaceAccessError('Insufficient permissions in this workspace', 403);
  }

  return member;
}

export function getUserWorkspaces(
  db: DatabaseContext['db'],
  userId: string
): Array<{ id: string; name: string; slug: string; role: string }> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .all();
}

export function createWorkspace(
  db: DatabaseContext['db'],
  userId: string,
  data: { name: string; slug?: string }
): { id: string; name: string; slug: string; role: string } {
  const name = data.name.trim();
  if (!name) {
    throw new WorkspaceAccessError('Workspace name is required', 400);
  }

  const workspaceId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const slug = (data.slug?.trim() || `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${workspaceId.slice(0, 8)}`).toLowerCase();
  const now = Date.now();

  try {
    db.transaction((tx) => {
      tx.insert(workspaces).values({
        id: workspaceId,
        name,
        slug,
        ownerId: userId,
        createdAt: now,
        updatedAt: now,
      }).run();

      tx.insert(workspaceMembers).values({
        id: memberId,
        workspaceId,
        userId,
        role: 'owner',
        createdAt: now,
      }).run();
    });
  } catch (err: unknown) {
    // Audit M-6: a duplicate slug previously escaped as an unhandled UNIQUE
    // constraint violation (HTTP 500). Surface it as a 409 Conflict.
    const message = err instanceof Error ? err.message : String(err);
    if (/unique/i.test(message) && /slug/i.test(message)) {
      throw new WorkspaceAccessError('A workspace with this slug already exists. Choose a different slug.', 409);
    }
    throw err;
  }

  return {
    id: workspaceId,
    name,
    slug,
    role: 'owner',
  };
}

/**
 * Remove a member from a workspace. The workspace owner can never be removed;
 * admins may be removed only by the owner.
 */
export function removeWorkspaceMember(
  db: DatabaseContext['db'],
  actorUserId: string,
  workspaceId: string,
  targetUserId: string
): void {
  const actor = getWorkspaceMembership(db, actorUserId, workspaceId);
  if (!actor) throw new WorkspaceAccessError('Access denied: You are not a member of this workspace', 403);

  const target = getWorkspaceMembership(db, targetUserId, workspaceId);
  if (!target) throw new WorkspaceAccessError('Member not found in this workspace', 404);

  if (target.role === 'owner') {
    throw new WorkspaceAccessError('The workspace owner cannot be removed', 403);
  }

  // Owner can remove anyone; admins can only remove editors/viewers; editors/viewers cannot remove anyone.
  const canRemove =
    actor.role === 'owner' ||
    (actor.role === 'admin' && target.role !== 'admin');
  if (!canRemove) {
    throw new WorkspaceAccessError('You do not have permission to remove this member', 403);
  }

  db.transaction((tx) => {
    tx.delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .run();
    // Audit L-13: the removed member's notifications for this workspace
    // (note titles + body snippets) disappear with their membership.
    tx.delete(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, targetUserId)))
      .run();
  });
}

/**
 * Change a member's role. The owner's role cannot be changed.
 *
 * Audit H-8: the privilege model is now consistent with removeWorkspaceMember —
 * only the owner may change an admin's role or grant admin to anyone.
 * Previously a workspace admin could demote a fellow admin to viewer and
 * then remove them, sidestepping the protection that removal had.
 */
export function changeMemberRole(
  db: DatabaseContext['db'],
  actorUserId: string,
  workspaceId: string,
  targetUserId: string,
  newRole: string
): { userId: string; role: string } {
  const actor = getWorkspaceMembership(db, actorUserId, workspaceId);
  if (!actor) throw new WorkspaceAccessError('Access denied: You are not a member of this workspace', 403);

  if (!['admin', 'editor', 'viewer'].includes(newRole)) {
    throw new WorkspaceAccessError('Role must be one of: admin, editor, viewer', 400);
  }

  const target = getWorkspaceMembership(db, targetUserId, workspaceId);
  if (!target) throw new WorkspaceAccessError('Member not found in this workspace', 404);
  if (target.role === 'owner') {
    throw new WorkspaceAccessError('The workspace owner role cannot be changed', 403);
  }
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new WorkspaceAccessError('Only owners and admins can change member roles', 403);
  }

  // Audit H-8: touching the admin role in either direction is owner-only.
  if (actor.role !== 'owner' && (target.role === 'admin' || newRole === 'admin')) {
    throw new WorkspaceAccessError(
      'Only the workspace owner can change an admin\'s role or grant admin permissions',
      403,
    );
  }

  db.update(workspaceMembers)
    .set({ role: newRole })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .run();

  return { userId: targetUserId, role: newRole };
}

/**
 * Leave a workspace (audit L-8). Owners must transfer ownership (or delete the
 * workspace) first. Leaving also clears the member's notifications for that
 * workspace (audit L-13) so they no longer see other members' reminder noise.
 */
export function leaveWorkspace(
  db: DatabaseContext['db'],
  userId: string,
  workspaceId: string
): void {
  const member = getWorkspaceMembership(db, userId, workspaceId);
  if (!member) throw new WorkspaceAccessError('You are not a member of this workspace', 404);
  if (member.role === 'owner') {
    throw new WorkspaceAccessError(
      'The workspace owner cannot leave. Transfer ownership to another member or delete the workspace first.',
      403,
    );
  }

  db.transaction((tx) => {
    tx.delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
      .run();
    // Audit L-13: their per-workspace notifications disappear with the membership.
    tx.delete(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.userId, userId)))
      .run();
  });
}

/**
 * Transfer workspace ownership (audit L-8). The current owner becomes an
 * admin; the target member becomes the owner. Owner-only by definition.
 */
export function transferWorkspaceOwnership(
  db: DatabaseContext['db'],
  actorUserId: string,
  workspaceId: string,
  targetUserId: string
): { workspaceId: string; newOwnerId: string } {
  const actor = getWorkspaceMembership(db, actorUserId, workspaceId);
  if (!actor) throw new WorkspaceAccessError('Access denied: You are not a member of this workspace', 403);
  if (actor.role !== 'owner') {
    throw new WorkspaceAccessError('Only the workspace owner can transfer ownership', 403);
  }

  const target = getWorkspaceMembership(db, targetUserId, workspaceId);
  if (!target) throw new WorkspaceAccessError('The target user is not a member of this workspace', 404);
  if (targetUserId === actorUserId) {
    throw new WorkspaceAccessError('You already own this workspace', 400);
  }

  const now = Date.now();
  db.transaction((tx) => {
    tx.update(workspaces)
      .set({ ownerId: targetUserId, updatedAt: now })
      .where(eq(workspaces.id, workspaceId))
      .run();
    tx.update(workspaceMembers)
      .set({ role: 'owner' })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
      .run();
    tx.update(workspaceMembers)
      .set({ role: 'admin' })
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorUserId)))
      .run();
  });

  return { workspaceId, newOwnerId: targetUserId };
}
