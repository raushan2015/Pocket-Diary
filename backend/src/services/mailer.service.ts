/**
 * Email delivery service (optional, SMTP-driven).
 * Disabled unless SMTP_HOST is configured; callers must handle the no-op gracefully.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { smtpConfig } from '../config.js';

let cachedTransport: Transporter | null = null;
let transportBroken = false;

export function isEmailEnabled(): boolean {
  return smtpConfig.enabled;
}

function getTransport(): Transporter | null {
  if (!smtpConfig.enabled) return null;
  if (transportBroken) return null;
  if (cachedTransport) return cachedTransport;

  try {
    cachedTransport = nodemailer.createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth: smtpConfig.user ? { user: smtpConfig.user, pass: smtpConfig.pass } : undefined,
    });
    return cachedTransport;
  } catch {
    transportBroken = true;
    return null;
  }
}

export async function sendEmail(options: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<boolean> {
  const transport = getTransport();
  if (!transport) return false;

  try {
    await transport.sendMail({
      from: smtpConfig.from,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    return true;
  } catch (error) {
    // Never let a mail outage break the main request or reminder scan.
    console.warn('[mailer] send failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

function escapeHtmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReminderEmail(params: {
  userName: string;
  memoTitle: string;
  memoBody: string;
  reminderTime: number | null;
  appUrl: string;
  /** IANA timezone stored on the user (audit M-16) — falls back to UTC. */
  timezone?: string;
}): { subject: string; text: string; html: string } {
  // Audit M-16: format the reminder time in the USER's timezone. The server
  // (often a UTC container) previously decided, so users in Tokyo saw
  // reminders scheduled for 09:00 local arrive labelled 00:00.
  let tz = params.timezone && params.timezone.trim() ? params.timezone.trim() : 'UTC';
  let when: string;
  try {
    when = params.reminderTime
      ? new Date(params.reminderTime).toLocaleString('en-US', {
          weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
          timeZone: tz,
        })
      : 'now';
  } catch {
    tz = 'UTC';
    when = params.reminderTime
      ? new Date(params.reminderTime).toLocaleString('en-US', {
          weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
        })
      : 'now';
  }
  const subject = `Reminder: ${params.memoTitle}`;

  const textLines: string[] = [
    `Hi ${params.userName},`,
    '',
    `This is your reminder for the note "${params.memoTitle}" (${when}).`,
  ];
  if (params.memoBody) textLines.push('', `Note preview: ${params.memoBody.slice(0, 280)}`);
  textLines.push('', `Open your notes: ${params.appUrl}`, '', '— Pocket Diary');
  const text = textLines.join('\n');

  const escapedTitle = escapeHtmlText(params.memoTitle);
  const html = [
    '<div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; color: #1f2328;">',
    `<h2 style="margin-bottom: 0.25rem;">⏰ ${escapedTitle}</h2>`,
    `<p style="color: #57606a; margin-top: 0;">Reminder for <strong>${escapeHtmlText(params.userName)}</strong> · ${when}</p>`,
    params.memoBody
      ? `<blockquote style="border-left: 3px solid #fbbc04; margin: 0.75rem 0; padding: 0.35rem 0.85rem; color: #57606a;">${escapeHtmlText(params.memoBody.slice(0, 280))}…</blockquote>`
      : '',
    `<p><a href="${params.appUrl}" style="background: #fbbc04; color: #202124; padding: 0.55rem 1rem; border-radius: 18px; text-decoration: none; font-weight: 600;">Open Pocket Diary</a></p>`,
    '<p style="font-size: 0.75rem; color: #8b949e;">Sent by your self-hosted Pocket Diary instance.</p>',
    '</div>',
  ].join('\n');

  return { subject, text, html };
}

export function renderInviteEmail(params: {
  workspaceName: string;
  inviterName: string;
  inviteUrl: string;
  role: string;
}): { subject: string; text: string; html: string } {
  const subject = `You've been invited to join "${params.workspaceName}" on Pocket Diary`;

  const text = [
    `Hi there,`,
    '',
    `${params.inviterName} has invited you to collaborate in the "${params.workspaceName}" workspace (as ${params.role}).`,
    '',
    `Accept the invitation: ${params.inviteUrl}`,
    '',
    'The link expires in 7 days. If you already have an account you will join the workspace after signing in.',
    '',
    '— Pocket Diary',
  ].join('\n');

  const escapedName = escapeHtmlText(params.workspaceName);
  const html = [
    '<div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; color: #1f2328;">',
    `<h2>You've been invited to "${escapedName}"</h2>`,
    `<p>${escapeHtmlText(params.inviterName)} invited you to collaborate as <strong>${escapeHtmlText(params.role)}</strong>.</p>`,
    `<p><a href="${params.inviteUrl}" style="background: #fbbc04; color: #202124; padding: 0.55rem 1rem; border-radius: 18px; text-decoration: none; font-weight: 600;">Accept invitation</a></p>`,
    '<p style="font-size: 0.75rem; color: #8b949e;">This link expires in 7 days.</p>',
    '</div>',
  ].join('\n');

  return { subject, text, html };
}

/** Render the password recovery email (used by the forgot-password flow). */
export function renderPasswordResetEmail(params: {
  userName: string;
  resetUrl: string;
  expiresInMinutes: number;
}): { subject: string; text: string; html: string } {
  const subject = 'Reset your Pocket Diary password';

  const text = [
    `Hi ${params.userName},`,
    '',
    'We received a request to reset the password for your Pocket Diary account.',
    `Reset your password within ${params.expiresInMinutes} minutes using this link:`,
    '',
    params.resetUrl,
    '',
    'If you did not request this, you can safely ignore this email — the link expires and your password stays unchanged.',
    '',
    '— Pocket Diary',
  ].join('\n');

  const html = [
    '<div style="font-family: Arial, Helvetica, sans-serif; max-width: 520px; margin: 0 auto; color: #1f2328;">',
    `<h2>Password reset requested</h2>`,
    `<p>Hi <strong>${escapeHtmlText(params.userName)}</strong>, use the button below to choose a new password. This link is valid for <strong>${params.expiresInMinutes} minutes</strong> and can be used only once.</p>`,
    `<p><a href="${params.resetUrl}" style="background: #fbbc04; color: #202124; padding: 0.55rem 1rem; border-radius: 18px; text-decoration: none; font-weight: 600;">Reset password</a></p>`,
    '<p style="font-size: 0.8rem; color: #8b949e;">If you did not request a password reset, ignore this email and your password will stay unchanged.</p>',
    '<p style="font-size: 0.75rem; color: #8b949e;">Sent by your self-hosted Pocket Diary instance.</p>',
    '</div>',
  ].join('\n');

  return { subject, text, html };
}

/** Test hook: reset cached transport state. */
export function __resetMailerForTests(): void {
  cachedTransport = null;
  transportBroken = false;
}
