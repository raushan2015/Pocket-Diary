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

/**
 * Security (audit H-7): sessions are stored ONLY as SHA-256 hashes. Anyone
 * with read access to the database, a backup snapshot or an off-host replica
 * can no longer impersonate users — the raw token exists solely in the
 * user's browser cookie. Mirrors the password-reset token design.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Per-account login throttling (audit H-1)
// ---------------------------------------------------------------------------
// IP-based rate limiting can be bypassed with a spoofed X-Forwarded-For or
// a distributed attack; a per-account lockout guarantees brute-force
// protection for the account itself regardless of the source address.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

function pruneLoginFailures(now: number): void {
  if (loginFailures.size < 10_000) return;
  for (const [email, rec] of loginFailures) {
    if (rec.lockedUntil < now && rec.firstAt + LOGIN_FAILURE_WINDOW_MS < now) {
      loginFailures.delete(email);
    }
  }
}

/** Throws AuthError(429) while the account is locked out after repeated failures. */
function assertLoginNotLocked(normalizedEmail: string, now = Date.now()): void {
  pruneLoginFailures(now);
  const rec = loginFailures.get(normalizedEmail);
  if (rec && rec.lockedUntil > now) {
    throw new AuthError('Too many failed sign-in attempts for this account. Please try again in a few minutes.', 429);
  }
}

function recordLoginFailure(normalizedEmail: string, now = Date.now()): void {
  const rec = loginFailures.get(normalizedEmail);
  if (!rec || now - rec.firstAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.set(normalizedEmail, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILURES) {
    rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
}

function clearLoginFailures(normalizedEmail: string): void {
  loginFailures.delete(normalizedEmail);
}

/** Dummy hash verified for unknown emails so response timing cannot reveal account existence (audit M-14). */
const DUMMY_ARGON2_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdGVkc2FsdGVkc2FsdGVkc2FsdA$RdescudvJCsgt3ub+b+dWRWJTmaaJObGing5CaQ3V1c';

export async function registerUser(
  db: DatabaseContext['db'],
  data: { email: string; password: string; name: string; ipAddress?: string; userAgent?: string }
): Promise<{ user: { id: string; email: string; name: string; createdAt: number }; workspace: { id: string; name: string; slug: string }; sessionToken: string }> {
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

  // Insert within transaction. The first-user check runs INSIDE the
  // transaction (audit H-9): reading it outside allowed two simultaneous
  // sign-ups on a fresh instance to both become instance administrator.
  db.transaction((tx) => {
    // The very first account created on an instance becomes the instance
    // administrator (self-hosted bootstrap owner). Admins can access system
    // telemetry such as backup status (see /api/v1/system/*).
    const isFirstUser = tx.select({ id: users.id }).from(users).limit(1).get() === undefined;

    // 1. Create user
    tx.insert(users).values({
      id: userId,
      email: normalizedEmail,
      passwordHash,
      name: data.name.trim(),
      timezone: 'UTC',
      status: 'active',
      isInstanceAdmin: isFirstUser ? 1 : 0,
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

    // 4. Create session (audit H-7: store only the SHA-256 hash of the token)
    tx.insert(sessions).values({
      id: hashSessionToken(sessionToken),
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
      createdAt: now,
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
): Promise<{ user: { id: string; email: string; name: string; createdAt: number }; activeWorkspace: { id: string; name: string }; sessionToken: string }> {
  const normalizedEmail = data.email.trim().toLowerCase();

  if (!normalizedEmail || !data.password) {
    throw new AuthError('Email and password are required', 400);
  }

  // Audit H-1: per-account lockout — checked before any password work so a
  // locked account cannot be probed further, regardless of source IP.
  assertLoginNotLocked(normalizedEmail);

  const user = db.select().from(users).where(eq(users.email, normalizedEmail)).get();
  if (!user) {
    // Timing equalization (audit M-14): run argon2 against a dummy hash so
    // response time cannot reveal whether the account exists.
    await verifyPassword(DUMMY_ARGON2_HASH, data.password);
    throw new AuthError('Invalid email or password', 401);
  }

  const isValidPassword = await verifyPassword(user.passwordHash, data.password);
  if (!isValidPassword) {
    recordLoginFailure(normalizedEmail);
    throw new AuthError('Invalid email or password', 401);
  }

  if (user.status !== 'active') {
    throw new AuthError('Account is suspended or inactive', 403);
  }

  clearLoginFailures(normalizedEmail);

  const sessionToken = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + config.sessionDurationMs;

  db.insert(sessions).values({
    id: hashSessionToken(sessionToken),
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
      createdAt: Number(user.createdAt),
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
    db.delete(sessions).where(eq(sessions.id, hashSessionToken(sessionToken))).run();
  }
}

export async function validateSession(
  db: DatabaseContext['db'],
  sessionToken: string
): Promise<{ user: User; session: typeof sessions.$inferSelect } | null> {
  if (!sessionToken) return null;

  const now = Date.now();
  // Audit H-7: look sessions up by their SHA-256 hash, never by raw token.
  const session = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, hashSessionToken(sessionToken)), gt(sessions.expiresAt, now)))
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
