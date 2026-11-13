/**
 * Antigravity CLI (`agy`) runtime & Google Subscription OAuth manager.
 *
 * Isolates each Pocket Diary user's Google OAuth token in a dedicated
 * per-user HOME directory inside the persistent data volume (`agy-homes/<userId>`),
 * so users never share Google subscription credentials across accounts.
 *
 * Interactive OAuth flow (headless / containerized):
 *  1. `startAntigravityLogin(userId)` spawns `agy` in a Python PTY bridge.
 *  2. Extracts the Google OAuth URL + verification state/login code and keeps
 *     the PKCE session alive in memory.
 *  3. `submitAntigravityLogin(userId, sessionId, tokenOrCode)` writes the
 *     user-pasted authorization code (or callback URL) to the PTY, waits for
 *     PKCE token exchange, and verifies `antigravity-oauth-token` was saved.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const LOGIN_TTL_MS = 58_000;
const START_WAIT_MS = 12_000;
const SUBMIT_WAIT_MS = 25_000;

const PTY_BRIDGE_SCRIPT = `
import os, pty, select, sys, subprocess, fcntl
master, slave = pty.openpty()
proc = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
fl = fcntl.fcntl(sys.stdin, fcntl.F_GETFL)
fcntl.fcntl(sys.stdin, fcntl.F_SETFL, fl | os.O_NONBLOCK)
while True:
    rlist = [master]
    if proc.poll() is None:
        rlist.append(sys.stdin.fileno())
    r, _, _ = select.select(rlist, [], [], 0.2)
    if master in r:
        try:
            data = os.read(master, 4096)
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        except OSError:
            break
    if sys.stdin.fileno() in r:
        try:
            inp = os.read(sys.stdin.fileno(), 4096)
            if inp:
                os.write(master, inp)
        except BlockingIOError:
            pass
    if proc.poll() is not None:
        while True:
            r2, _, _ = select.select([master], [], [], 0.05)
            if master not in r2:
                break
            try:
                data = os.read(master, 4096)
                if not data:
                    break
                sys.stdout.buffer.write(data)
                sys.stdout.buffer.flush()
            except OSError:
                break
        break
rc = proc.wait()
os.close(master)
sys.exit(rc)
`.trim();

export class AntigravityCliError extends Error {
  statusCode: number;
  code: string;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = 'AntigravityCliError';
  }
}

export interface AntigravityAuthStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  email: string | null;
  authMethod: string | null;
  activeSession: {
    sessionId: string;
    authUrl: string;
    loginCode: string;
    expiresAt: number;
    status: 'waiting' | 'exchanging' | 'failed' | 'expired';
    error?: string;
  } | null;
}

interface LoginSession {
  sessionId: string;
  userId: string;
  userHome: string;
  tokenPath: string;
  backupTokenPath: string;
  hadBackup: boolean;
  proc: ChildProcess;
  authUrl: string;
  loginCode: string;
  expiresAt: number;
  status: 'waiting' | 'exchanging' | 'succeeded' | 'failed' | 'expired';
  outputBuffer: string;
  error?: string;
  timer: NodeJS.Timeout;
}

const activeSessions = new Map<string, LoginSession>();

function dataRootDir(): string {
  const dbPath = process.env.DATABASE_PATH?.trim();
  if (dbPath && dbPath !== ':memory:') {
    return path.dirname(path.resolve(dbPath));
  }
  return path.resolve(process.cwd(), 'data');
}

export function resolveAgyBinary(): string {
  const configured = process.env.AGY_BIN?.trim();
  if (configured) return configured;
  const candidates = [
    '/usr/local/bin/agy',
    path.join(os.homedir(), '.local', 'bin', 'agy'),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return 'agy';
}

export function getAgyHomesDir(): string {
  return process.env.AGY_HOMES_DIR?.trim() || path.join(dataRootDir(), 'agy-homes');
}

export function getAgySandboxDir(): string {
  const dir = process.env.AGY_SANDBOX_DIR?.trim() || path.join(dataRootDir(), 'agy-sandbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  return dir;
}

export function getUserAgyHome(userId: string): string {
  const safeId = String(userId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  if (!safeId) throw new AntigravityCliError('invalid_user', 'Invalid user id', 400);
  const homeDir = path.join(getAgyHomesDir(), safeId);
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  // Keep per-user Antigravity config minimal: disable unnecessary plugins (like swarm)
  // to reduce prompt/startup overhead on Pocket Diary chat calls.
  try {
    const cfgDir = path.join(homeDir, '.gemini', 'config');
    const cfgPath = path.join(cfgDir, 'config.json');
    fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
    let cfg: Record<string, unknown> = {};
    if (fs.existsSync(cfgPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cfg = parsed as Record<string, unknown>;
      } catch { /* rewrite clean */ }
    }
    const plugins = (cfg.plugins && typeof cfg.plugins === 'object' ? cfg.plugins : {}) as Record<string, unknown>;
    const swarm = (plugins.swarm && typeof plugins.swarm === 'object' ? plugins.swarm : {}) as Record<string, unknown>;
    if (swarm.enabled !== false) {
      cfg.plugins = { ...plugins, swarm: { ...swarm, enabled: false } };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    }
  } catch { /* best-effort */ }
  return homeDir;
}

export function getUserTokenPath(userId: string): string {
  return path.join(getUserAgyHome(userId), '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
}

function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
}

function readTokenSummary(tokenPath: string): { authenticated: boolean; email: string | null; authMethod: string | null } {
  try {
    if (!fs.existsSync(tokenPath)) {
      return { authenticated: false, email: null, authMethod: null };
    }
    const raw = fs.readFileSync(tokenPath, 'utf8');
    const parsed = JSON.parse(raw) as { token?: unknown; id_token_email?: unknown; auth_method?: unknown };
    if (!parsed || typeof parsed !== 'object' || !parsed.token) {
      return { authenticated: false, email: null, authMethod: null };
    }
    return {
      authenticated: true,
      email: typeof parsed.id_token_email === 'string' && parsed.id_token_email.trim() ? parsed.id_token_email.trim() : null,
      authMethod: typeof parsed.auth_method === 'string' && parsed.auth_method.trim() ? parsed.auth_method.trim() : null,
    };
  } catch {
    return { authenticated: false, email: null, authMethod: null };
  }
}

export async function checkAgyInstalled(): Promise<{ installed: boolean; version: string | null }> {
  const bin = resolveAgyBinary();
  try {
    const { stdout } = await execFileAsync(bin, ['--version'], {
      timeout: 4000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const version = stdout.trim().split(/\s+/)[0] || 'installed';
    return { installed: true, version };
  } catch {
    return { installed: false, version: null };
  }
}

function restoreBackupIfNeeded(session: LoginSession): void {
  if (session.hadBackup && fs.existsSync(session.backupTokenPath) && !fs.existsSync(session.tokenPath)) {
    try {
      fs.mkdirSync(path.dirname(session.tokenPath), { recursive: true, mode: 0o700 });
      fs.renameSync(session.backupTokenPath, session.tokenPath);
    } catch {
      // non-fatal
    }
  } else if (fs.existsSync(session.backupTokenPath)) {
    try { fs.unlinkSync(session.backupTokenPath); } catch { /* ignore */ }
  }
}

function cleanupSession(userId: string, preserveErrorState = false): void {
  const existing = activeSessions.get(userId);
  if (!existing) return;
  clearTimeout(existing.timer);
  try {
    if (!existing.proc.killed && existing.proc.exitCode === null) {
      existing.proc.kill('SIGTERM');
    }
  } catch {
    // ignore
  }
  restoreBackupIfNeeded(existing);
  if (!preserveErrorState) {
    activeSessions.delete(userId);
  }
}

export async function getAntigravityStatus(userId: string): Promise<AntigravityAuthStatus> {
  const { installed, version } = await checkAgyInstalled();
  const tokenPath = getUserTokenPath(userId);
  const tokenInfo = readTokenSummary(tokenPath);
  const session = activeSessions.get(userId);

  let activeSession: AntigravityAuthStatus['activeSession'] = null;
  if (session) {
    if (session.status === 'waiting' && Date.now() >= session.expiresAt) {
      session.status = 'expired';
      session.error = 'Login link expired. Generate a new login link.';
      cleanupSession(userId, true);
    }
    if (session.status !== 'succeeded') {
      activeSession = {
        sessionId: session.sessionId,
        authUrl: session.authUrl,
        loginCode: session.loginCode,
        expiresAt: session.expiresAt,
        status: session.status,
        ...(session.error ? { error: session.error } : {}),
      };
    }
  }

  return {
    installed,
    version,
    authenticated: tokenInfo.authenticated,
    email: tokenInfo.email,
    authMethod: tokenInfo.authMethod,
    activeSession,
  };
}

/**
 * Extract the OAuth authorization code whether the user pasted the bare code
 * (`4/0A...`) or the full redirect URL (`https://antigravity.google/oauth-callback?code=...`).
 */
export function extractAuthCode(rawInput: string): string {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) {
    throw new AntigravityCliError('invalid_code', 'Paste the authorization code or callback URL from Google Sign-In.', 400);
  }
  if (/[\r\n\0]/.test(trimmed)) {
    throw new AntigravityCliError('invalid_code', 'Authorization code must be a single line.', 400);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const code = parsed.searchParams.get('code')?.trim();
      if (!code) {
        throw new AntigravityCliError('invalid_code', 'The pasted URL does not contain a Google authorization code parameter.', 400);
      }
      return code;
    } catch (err) {
      if (err instanceof AntigravityCliError) throw err;
      throw new AntigravityCliError('invalid_code', 'Could not parse the pasted callback URL.', 400);
    }
  }
  if (/^(?:[?&]?)(?:state=[^&]+&)?code=/.test(trimmed)) {
    const params = new URLSearchParams(trimmed.replace(/^\?/, ''));
    const code = params.get('code')?.trim();
    if (code) return code;
  }
  return trimmed;
}

function deriveLoginCode(authUrl: string): string {
  try {
    const u = new URL(authUrl);
    const state = u.searchParams.get('state')?.trim();
    if (state) return state;
    const challenge = u.searchParams.get('code_challenge')?.trim();
    if (challenge) return challenge.slice(0, 16);
  } catch {
    // fallback below
  }
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

export async function startAntigravityLogin(userId: string): Promise<{
  sessionId: string;
  authUrl: string;
  loginCode: string;
  expiresAt: number;
}> {
  const { installed } = await checkAgyInstalled();
  if (!installed) {
    throw new AntigravityCliError(
      'cli_not_installed',
      'Antigravity CLI (agy) is not installed in this container.',
      503
    );
  }

  cleanupSession(userId, false);

  const userHome = getUserAgyHome(userId);
  const sandboxDir = getAgySandboxDir();
  const tokenPath = getUserTokenPath(userId);
  const backupTokenPath = `${tokenPath}.bak`;
  let hadBackup = false;

  if (fs.existsSync(tokenPath)) {
    try {
      fs.renameSync(tokenPath, backupTokenPath);
      hadBackup = true;
    } catch {
      throw new AntigravityCliError('io_error', 'Could not prepare Google OAuth session.', 500);
    }
  }

  const bin = resolveAgyBinary();
  const pythonBin = process.env.PYTHON_BIN?.trim() || 'python3';
  const sessionId = crypto.randomUUID();
  const expiresAt = Date.now() + LOGIN_TTL_MS;

  const proc = spawn(
    pythonBin,
    ['-u', '-c', PTY_BRIDGE_SCRIPT, bin, '-p', 'Hello'],
    {
      cwd: sandboxDir,
      env: {
        ...process.env,
        HOME: userHome,
        TERM: 'xterm-256color',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  const session: LoginSession = {
    sessionId,
    userId,
    userHome,
    tokenPath,
    backupTokenPath,
    hadBackup,
    proc,
    authUrl: '',
    loginCode: '',
    expiresAt,
    status: 'waiting',
    outputBuffer: '',
    timer: setTimeout(() => {
      if (session.status === 'waiting') {
        session.status = 'expired';
        session.error = 'Login link expired after 60s. Click Generate Login Link to try again.';
        cleanupSession(userId, true);
      }
    }, LOGIN_TTL_MS),
  };

  activeSessions.set(userId, session);

  return new Promise((resolve, reject) => {
    let settled = false;
    const waitTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupSession(userId, false);
      reject(new AntigravityCliError(
        'login_start_timeout',
        'Antigravity CLI did not emit a Google login URL in time.',
        504
      ));
    }, START_WAIT_MS);

    const handleOutput = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString('utf8'));
      session.outputBuffer += text;
      if (session.outputBuffer.length > 32_000) {
        session.outputBuffer = session.outputBuffer.slice(-32_000);
      }

      if (!settled) {
        const urlMatch = session.outputBuffer.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s\r\n]+/);
        const readyPrompt = /paste the authorization code/i.test(session.outputBuffer);
        if (urlMatch && readyPrompt) {
          settled = true;
          clearTimeout(waitTimer);
          session.authUrl = urlMatch[0];
          session.loginCode = deriveLoginCode(session.authUrl);
          resolve({
            sessionId: session.sessionId,
            authUrl: session.authUrl,
            loginCode: session.loginCode,
            expiresAt: session.expiresAt,
          });
        }
      }
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(waitTimer);
        cleanupSession(userId, false);
        reject(new AntigravityCliError('cli_spawn_error', `Failed to launch Antigravity CLI: ${err.message}`, 500));
      }
    });

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(waitTimer);
        cleanupSession(userId, false);
        reject(new AntigravityCliError(
          'login_start_failed',
          `Antigravity CLI exited early (status ${code ?? 'unknown'}).`,
          502
        ));
      } else if (session.status === 'waiting') {
        session.status = 'expired';
        session.error = 'OAuth session closed before the code was submitted.';
        restoreBackupIfNeeded(session);
      }
    });
  });
}

export async function submitAntigravityLogin(
  userId: string,
  sessionId: string,
  rawTokenOrCode: string
): Promise<{ ok: true; authenticated: true; email: string | null; authMethod: string | null }> {
  const session = activeSessions.get(userId);
  if (!session || session.sessionId !== sessionId) {
    throw new AntigravityCliError(
      'session_not_found',
      'No active Google login session found. Click "Generate Login Link" first.',
      404
    );
  }
  if (session.status === 'expired' || Date.now() >= session.expiresAt || session.proc.exitCode !== null) {
    cleanupSession(userId, false);
    throw new AntigravityCliError(
      'session_expired',
      'The login code expired (60s limit). Generate a new login link and try again.',
      410
    );
  }
  if (session.status !== 'waiting') {
    throw new AntigravityCliError('invalid_session_state', 'This login session is already being verified.', 409);
  }

  const code = extractAuthCode(rawTokenOrCode);
  session.status = 'exchanging';
  const offsetBefore = session.outputBuffer.length;

  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      session.status = 'failed';
      session.error = 'Timed out waiting for Google OAuth verification.';
      cleanupSession(userId, false);
      reject(new AntigravityCliError('auth_timeout', session.error, 504));
    }, SUBMIT_WAIT_MS);

    const finishOk = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (pollTimer) clearInterval(pollTimer);
      clearTimeout(session.timer);
      session.status = 'succeeded';
      if (fs.existsSync(session.backupTokenPath)) {
        try { fs.unlinkSync(session.backupTokenPath); } catch { /* ignore */ }
      }
      try {
        if (!session.proc.killed && session.proc.exitCode === null) {
          session.proc.kill('SIGTERM');
        }
      } catch {
        // ignore
      }
      activeSessions.delete(userId);
      const summary = readTokenSummary(session.tokenPath);
      resolve({
        ok: true,
        authenticated: true,
        email: summary.email,
        authMethod: summary.authMethod,
      });
    };

    const finishFail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (pollTimer) clearInterval(pollTimer);
      session.status = 'failed';
      session.error = message;
      cleanupSession(userId, false);
      reject(new AntigravityCliError('auth_failed', message, 400));
    };

    const checkState = () => {
      if (settled) return;
      const summary = readTokenSummary(session.tokenPath);
      if (summary.authenticated) {
        finishOk();
        return;
      }
      const recentOut = session.outputBuffer.slice(offsetBefore);
      if (/authentication failed|invalid_grant|token exchange failed|timed out/i.test(recentOut)) {
        finishFail('Google rejected the authorization code or it expired. Generate a new login link and try again.');
      }
    };

    session.proc.once('exit', (exitCode) => {
      if (settled) return;
      const summary = readTokenSummary(session.tokenPath);
      if (summary.authenticated) {
        finishOk();
      } else {
        finishFail(
          exitCode === 0
            ? 'Login finished without saving a token. Try generating a new login link.'
            : 'Google authentication failed. Verify the code and try again.'
        );
      }
    });

    pollTimer = setInterval(checkState, 150);

    try {
      session.proc.stdin?.write(`${code}\n`);
    } catch (err) {
      finishFail(`Failed to send authorization code to Antigravity CLI: ${(err as Error).message}`);
    }
  });
}

export function logoutAntigravity(userId: string): void {
  cleanupSession(userId, false);
  const tokenPath = getUserTokenPath(userId);
  const backupPath = `${tokenPath}.bak`;
  for (const p of [tokenPath, backupPath]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

export async function listAntigravityModels(userId: string): Promise<Array<{ id: string; label: string }>> {
  const { installed } = await checkAgyInstalled();
  if (!installed) {
    throw new AntigravityCliError('cli_not_installed', 'Antigravity CLI (agy) is not installed.', 503);
  }
  const summary = readTokenSummary(getUserTokenPath(userId));
  if (!summary.authenticated) {
    throw new AntigravityCliError('auth_required', 'Sign in with your Google Subscription in AI Settings first.', 401);
  }

  const userHome = getUserAgyHome(userId);
  const bin = resolveAgyBinary();
  const { stdout } = await execFileAsync(bin, ['models'], {
    cwd: getAgySandboxDir(),
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: userHome,
      NO_COLOR: '1',
    },
  });

  const models: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of stripAnsi(stdout).split('\n')) {
    const line = rawLine.trim();
    if (!line || /^fetching/i.test(line)) continue;
    const match = line.match(/^([a-z0-9][a-z0-9._-]+)\s+(.+)$/i);
    if (!match) continue;
    const id = match[1].trim();
    const label = match[2].trim();
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}
