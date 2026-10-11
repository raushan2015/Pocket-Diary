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
