/**
 * Password reset service (MOCK-03 remediation).
 *
 * Implements the full forgot-password / reset-password flow:
 *  - `requestPasswordReset` generates a cryptographically secure single-use
 *    token, stores only its SHA-256 hash, invalidates previous pending tokens
 *    and emails a reset link when SMTP is configured.
 *  - `consumePasswordReset` verifies the token, updates the password with
 *    Argon2 and revokes every active session for the account.
 *
 * Responses never reveal whether an email address has an account.
 */
import crypto from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { users, passwordResets, sessions } from '../db/schema.js';
import type { DatabaseContext } from '../db/index.js';
import { hashPassword } from './auth.service.js';
import { sendEmail, renderPasswordResetEmail, isEmailEnabled } from './mailer.service.js';

export const PASSWORD_RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
export const PASSWORD_RESET_MIN_LENGTH = 6;
export const PASSWORD_RESET_MAX_LENGTH = 200;

export class PasswordResetError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'PasswordResetError';
    this.statusCode = statusCode;
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface PasswordResetRequestResult {
  /** Whether the instance has SMTP configured (server-wide, never account-specific). */
  emailConfigured: boolean;
  /** Whether the reset email was actually delivered (only meaningful when configured). */
  emailSent: boolean;
}

export async function requestPasswordReset(
  dbCtx: DatabaseContext,
  email: string,
  appUrl: string,
): Promise<PasswordResetRequestResult> {
  const normalized = String(email || '').trim().toLowerCase();
  const emailConfigured = isEmailEnabled();

  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { emailConfigured, emailSent: false };
  }

  const user = dbCtx.db.select().from(users).where(eq(users.email, normalized)).get();
  if (!user) {
    // Do not reveal account existence through response differences.
    return { emailConfigured, emailSent: false };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();

  dbCtx.db.transaction((tx) => {
    // Invalidate all outstanding reset tokens for this account.
    tx.update(passwordResets)
      .set({ usedAt: now })
      .where(and(
        eq(passwordResets.userId, user.id),
        isNull(passwordResets.usedAt),
        gt(passwordResets.expiresAt, now),
      ))
      .run();

    tx.insert(passwordResets)
      .values({
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: now + PASSWORD_RESET_EXPIRY_MS,
        usedAt: null,
        createdAt: now,
      })
      .run();
  });

  const resetUrl = `${appUrl.replace(/\/$/, '')}/#reset=${token}`;
  const message = renderPasswordResetEmail({
    userName: user.name,
    resetUrl,
    expiresInMinutes: Math.round(PASSWORD_RESET_EXPIRY_MS / 60000),
  });
  const emailSent = await sendEmail({ to: user.email, ...message });

  return { emailConfigured, emailSent };
}

export async function consumePasswordReset(
  dbCtx: DatabaseContext,
  token: string,
  newPassword: string,
): Promise<void> {
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken || normalizedToken.length < 16 || normalizedToken.length > 128) {
    throw new PasswordResetError('Invalid or expired password reset link', 400);
  }
  if (!newPassword || newPassword.length < PASSWORD_RESET_MIN_LENGTH || newPassword.length > PASSWORD_RESET_MAX_LENGTH) {
    throw new PasswordResetError(`New password must be between ${PASSWORD_RESET_MIN_LENGTH} and ${PASSWORD_RESET_MAX_LENGTH} characters`, 400);
  }

  const record = dbCtx.db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashToken(normalizedToken)))
    .get();

  if (!record) {
    throw new PasswordResetError('Invalid or expired password reset link', 400);
  }
  if (record.usedAt !== null) {
    throw new PasswordResetError('This password reset link has already been used', 400);
  }
  if (record.expiresAt < Date.now()) {
    throw new PasswordResetError('This password reset link has expired', 400);
  }

  const newHash = await hashPassword(newPassword);
  const now = Date.now();

  dbCtx.db.transaction((tx) => {
    // Audit M-15: claim the token CONDITIONALLY. The usedAt pre-check above
    // runs before the async hash, so two concurrent requests could both pass
    // it; only this conditional UPDATE decides the winner, and the loser
    // rolls back instead of consuming the token twice.
    const claim = tx.update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.id, record.id), isNull(passwordResets.usedAt)))
      .run();
    if (claim.changes === 0) {
      throw new PasswordResetError('This password reset link has already been used', 400);
    }

    tx.update(users)
      .set({ passwordHash: newHash, updatedAt: now })
      .where(eq(users.id, record.userId))
      .run();
    // Security: a reset invalidates every session on every device.
    tx.delete(sessions).where(eq(sessions.userId, record.userId)).run();
  });
}
