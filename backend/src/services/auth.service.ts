import crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { eq, and, gt } from 'drizzle-orm';
import { users, workspaces, workspaceMembers, sessions } from '../db/schema.js';
import type { User, Workspace } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';
import { config } from '../config.js';

export class AuthError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = statusCode;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function registerUser(
  db: DatabaseContext['db'],
  data: { email: string; password: string; name: string; ipAddress?: string; userAgent?: string }
): Promise<{ user: { id: string; email: string; name: string }; workspace: { id: string; name: string; slug: string }; sessionToken: string }> {
  const normalizedEmail = data.email.trim().toLowerCase();

  // Validate format
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new AuthError('Invalid email address format', 400);
  }

  if (!data.password || data.password.length < 6) {
    throw new AuthError('Password must be at least 6 characters long', 400);
  }

  if (!data.name || data.name.trim().length === 0) {
    throw new AuthError('Name is required', 400);
  }

  // Check if user already exists
  const existingUser = db.select().from(users).where(eq(users.email, normalizedEmail)).get();
  if (existingUser) {
    throw new AuthError('Email already registered', 409);
  }

  const passwordHash = await hashPassword(data.password);
  const userId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const sessionToken = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + config.sessionDurationMs;

  const slug = `personal-${userId.slice(0, 8)}`;
  const workspaceName = 'Personal';

  // Insert within transaction
  db.transaction((tx) => {
    // 1. Create user
    tx.insert(users).values({
      id: userId,
      email: normalizedEmail,
      passwordHash,
      name: data.name.trim(),
      timezone: 'UTC',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }).run();

    // 2. Create personal workspace
    tx.insert(workspaces).values({
      id: workspaceId,
      name: workspaceName,
      slug,
      ownerId: userId,
      createdAt: now,
      updatedAt: now,
    }).run();

    // 3. Link user as owner
    tx.insert(workspaceMembers).values({
      id: memberId,
      workspaceId,
      userId,
      role: 'owner',
      createdAt: now,
    }).run();

    // 4. Create session
    tx.insert(sessions).values({
      id: sessionToken,
      userId,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      expiresAt,
      createdAt: now,
    }).run();
  });

  return {
    user: {
      id: userId,
      email: normalizedEmail,
      name: data.name.trim(),
    },
    workspace: {
      id: workspaceId,
      name: workspaceName,
      slug,
    },
    sessionToken,
  };
}

export async function loginUser(
  db: DatabaseContext['db'],
  data: { email: string; password: string; ipAddress?: string; userAgent?: string }
): Promise<{ user: { id: string; email: string; name: string }; activeWorkspace: { id: string; name: string }; sessionToken: string }> {
  const normalizedEmail = data.email.trim().toLowerCase();

  if (!normalizedEmail || !data.password) {
    throw new AuthError('Email and password are required', 400);
  }

  const user = db.select().from(users).where(eq(users.email, normalizedEmail)).get();
  if (!user) {
    throw new AuthError('Invalid email or password', 401);
  }

  const isValidPassword = await verifyPassword(user.passwordHash, data.password);
  if (!isValidPassword) {
    throw new AuthError('Invalid email or password', 401);
  }

  if (user.status !== 'active') {
    throw new AuthError('Account is suspended or inactive', 403);
  }

  const sessionToken = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + config.sessionDurationMs;

  db.insert(sessions).values({
    id: sessionToken,
    userId: user.id,
    ipAddress: data.ipAddress,
    userAgent: data.userAgent,
    expiresAt,
    createdAt: now,
  }).run();

  // Find active workspace (owned or first membership)
  let activeWorkspace = db.select().from(workspaces).where(eq(workspaces.ownerId, user.id)).get();
  if (!activeWorkspace) {
    const member = db.select().from(workspaceMembers).where(eq(workspaceMembers.userId, user.id)).get();
    if (member) {
      activeWorkspace = db.select().from(workspaces).where(eq(workspaces.id, member.workspaceId)).get();
    }
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
    },
    activeWorkspace: {
      id: activeWorkspace?.id ?? '',
      name: activeWorkspace?.name ?? 'Personal',
    },
    sessionToken,
  };
}

export async function logoutUser(db: DatabaseContext['db'], sessionToken: string): Promise<void> {
  if (sessionToken) {
    db.delete(sessions).where(eq(sessions.id, sessionToken)).run();
  }
}

export async function validateSession(
  db: DatabaseContext['db'],
  sessionToken: string
): Promise<{ user: User; session: typeof sessions.$inferSelect } | null> {
  if (!sessionToken) return null;

  const now = Date.now();
  const session = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionToken), gt(sessions.expiresAt, now)))
    .get();

  if (!session) return null;

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user || user.status !== 'active') return null;

  return { user, session };
}

export async function getUserWorkspaces(
  db: DatabaseContext['db'],
  userId: string
): Promise<Array<{ id: string; name: string; role: string }>> {
  const memberships = db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId))
    .all();

  return memberships;
}
