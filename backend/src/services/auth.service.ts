import crypto from 'node:crypto';
import * as argon2 from 'argon2';
import { eq, and, gt, lt, or, ne, isNull, isNotNull } from 'drizzle-orm';
import { users, workspaces, workspaceMembers, sessions, passwordResets, workspaceInvites, memos, memoVersions } from '../db/schema.js';
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

/**
 * Server-enforced password policy (audit L-9): the client-side strength
 * meter was decorative — the server accepted any 6-character string.
 * Now: minimum 8 characters and must contain both a letter and a digit.
 * (A breached-password check needs an external API and stays a documented
 * follow-up for the self-hosted default.)
 */
export const PASSWORD_MIN_LENGTH = 8;

export function validatePasswordStrength(password: string): void {
  if (!password || password.length < PASSWORD_MIN_LENGTH) {
    throw new AuthError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters long`, 400);
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new AuthError('Password must contain at least one letter and one number', 400);
  }
}

/**
 * Normalizes + validates an IANA timezone for storage on the user record
 * (audit M-16). Empty/invalid values fall back to UTC.
 */
export function normalizeTimezone(timezone: string | undefined): string {
  const tz = String(timezone ?? '').trim();
  if (!tz) return 'UTC';
  try {
    const supported: string[] = Intl.DateTimeFormat().resolvedOptions().timeZone
      ? (Intl as any).supportedValuesOf?.('timeZone') ?? []
      : [];
    if (supported.length > 0 && !supported.includes(tz)) return 'UTC';
    return tz.slice(0, 64);
  } catch {
    return 'UTC';
  }
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
  data: { email: string; password: string; name: string; ipAddress?: string; userAgent?: string; timezone?: string }
): Promise<{ user: { id: string; email: string; name: string; createdAt: number }; workspace: { id: string; name: string; slug: string }; sessionToken: string }> {
  const normalizedEmail = data.email.trim().toLowerCase();

  // Validate format
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new AuthError('Invalid email address format', 400);
  }

  // Audit L-9: the server now enforces the password policy itself.
  validatePasswordStrength(data.password);

  if (!data.name || data.name.trim().length === 0) {
    throw new AuthError('Name is required', 400);
  }

  const timezone = normalizeTimezone(data.timezone);

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
      timezone, // audit M-16: used when formatting reminder email times
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

    // 4. Create session (audit H-7: store only the SHA-256 hash of the token;
    // audit L-8: publicId lets the user revoke this device individually)
    tx.insert(sessions).values({
      id: hashSessionToken(sessionToken),
      publicId: crypto.randomUUID(),
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
  data: { email: string; password: string; ipAddress?: string; userAgent?: string; timezone?: string }
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

  // Audit M-16: remember the browser's timezone so reminder emails render
  // times the user actually recognizes.
  const timezone = normalizeTimezone(data.timezone);
  if (timezone && timezone !== user.timezone) {
    db.update(users).set({ timezone, updatedAt: Date.now() }).where(eq(users.id, user.id)).run();
  }

  const sessionToken = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + config.sessionDurationMs;

  db.insert(sessions).values({
    id: hashSessionToken(sessionToken),
    publicId: crypto.randomUUID(),
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

  // Audit L-7: sliding renewal — an active session is extended as it nears
  // expiry, so regular users never fall off a cliff after 7 idle days while
  // abandoned sessions still expire on schedule.
  const halfLifetime = Math.floor(config.sessionDurationMs / 2);
  if (now - Number(session.createdAt) > halfLifetime && Number(session.expiresAt) - now < halfLifetime) {
    db.update(sessions)
      .set({ expiresAt: now + config.sessionDurationMs })
      .where(eq(sessions.id, session.id))
      .run();
  }

  return { user, session };
}

/**
 * Housekeeping (audit L-7): expired sessions, consumed/expired password-reset
 * rows and long-dead invitations used to accumulate forever. Runs alongside
 * the reminder scheduler's nightly cleanup.
 */
export function pruneExpiredAuthArtifacts(db: DatabaseContext['db']): {
  sessions: number;
  passwordResets: number;
  invites: number;
} {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  const expiredSessions = db.delete(sessions).where(lt(sessions.expiresAt, now)).run().changes;

  // Password resets: consumed, or expired more than a day ago.
  const oldResets = db
    .delete(passwordResets)
    .where(
      or(
        and(isNull(passwordResets.usedAt), lt(passwordResets.expiresAt, now - day)),
        and(isNotNull(passwordResets.usedAt), lt(passwordResets.usedAt, now - 30 * day)),
      ),
    )
    .run().changes;

  // Invitations: anything not pending, or pending-but-expired over 30 days ago.
  const oldInvites = db
    .delete(workspaceInvites)
    .where(
      or(
        and(ne(workspaceInvites.status, 'pending'), lt(workspaceInvites.createdAt, now - 30 * day)),
        and(eq(workspaceInvites.status, 'pending'), lt(workspaceInvites.expiresAt, now - 30 * day)),
      ),
    )
    .run().changes;

  return { sessions: expiredSessions, passwordResets: oldResets, invites: oldInvites };
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

/**
 * Permanently delete a user account (audit L-8).
 *
 * Requires the current password (verified by the route). Rules:
 *  - Workspaces the user OWNS with other members block deletion — they must
 *    transfer ownership first (data belongs to the team, not just to them).
 *  - Solo workspaces the user owns are deleted outright (their memos cascade);
 *    attachment files on disk are unlinked best-effort by the route.
 *  - Notes the user created inside OTHER people's workspaces are reassigned
 *    to those workspaces' owners, so shared content survives.
 */
export function deleteAccount(
  dbCtx: DatabaseContext,
  userId: string
): { deletedWorkspaces: string[]; reassignedMemos: number } {
  const { db, sqlite } = dbCtx;

  // 1. Owned workspaces: solo ones go away; shared ones block deletion.
  const ownedWorkspaces = db.select().from(workspaces).where(eq(workspaces.ownerId, userId)).all();
  const sharedOwned = ownedWorkspaces.filter((ws) => {
    const others = db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ws.id), ne(workspaceMembers.userId, userId)))
      .all();
    return others.length > 0;
  });
  if (sharedOwned.length > 0) {
    throw new AuthError(
      `Transfer ownership of (or delete) these workspaces before deleting your account: ${sharedOwned.map((w) => w.name).join(', ')}`,
      409,
    );
  }

  const deletedWorkspaces: string[] = [];
  let reassignedMemos = 0;

  db.transaction((tx) => {
    // 2. Notes the user authored in workspaces they do NOT own are reassigned
    //    to those workspaces' owners so shared content stays intact.
    const foreignMemos = tx
      .select({ memoId: memos.id, workspaceId: memos.workspaceId })
      .from(memos)
      .innerJoin(workspaces, eq(workspaces.id, memos.workspaceId))
      .where(and(eq(memos.createdBy, userId), ne(workspaces.ownerId, userId)))
      .all() as Array<{ memoId: string; workspaceId: string }>;
    for (const memo of foreignMemos) {
      const ws = tx.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, memo.workspaceId)).get();
      if (!ws) continue;
      tx.update(memos).set({ createdBy: ws.ownerId }).where(eq(memos.id, memo.memoId)).run();
      tx.update(memoVersions).set({ changedBy: ws.ownerId }).where(eq(memoVersions.memoId, memo.memoId)).run();
      reassignedMemos++;
    }

    // 3. Invitations sent by the user are re-attributed to the workspace
    //    owner so pending invites keep working.
    const sentInvites = tx
      .select({ inviteId: workspaceInvites.id, workspaceId: workspaceInvites.workspaceId })
      .from(workspaceInvites)
      .where(eq(workspaceInvites.invitedBy, userId))
      .all();
    for (const invite of sentInvites) {
      const ws = tx.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, invite.workspaceId)).get();
      if (ws) {
        tx.update(workspaceInvites).set({ invitedBy: ws.ownerId }).where(eq(workspaceInvites.id, invite.inviteId)).run();
      }
    }

    // 4. Delete the user's solo workspaces (memos cascade via workspace_id).
    for (const ws of ownedWorkspaces) {
      tx.delete(workspaces).where(eq(workspaces.id, ws.id)).run();
      deletedWorkspaces.push(ws.id);
    }

    // 5. Finally the user; sessions, memberships, notifications and push
    //    subscriptions cascade away.
    tx.delete(users).where(eq(users.id, userId)).run();
  });

  return { deletedWorkspaces, reassignedMemos };
}
