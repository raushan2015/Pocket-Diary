import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { workspaces, workspaceMembers } from '../db/schema.js';
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

  db.delete(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .run();
}

/** Change a member's role. The owner's role cannot be changed. */
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

  db.update(workspaceMembers)
    .set({ role: newRole })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .run();

  return { userId: targetUserId, role: newRole };
}
