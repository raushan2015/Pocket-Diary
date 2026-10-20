/**
 * Authentication & Session Controller
 * Handles user login, registration (with password strength + confirmation +
 * workspace-invitation links), password recovery, session detection, and logout.
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { navigateTo } from './navigation.js';
import { fetchWorkspaceData, resetStorageWidget } from './workspace-data.js';

// Active workspace invitation token captured from the URL (#invite=<token>)
let pendingInviteToken = null;
let pendingInviteContext = null;
// One-time password reset token captured from the URL (#reset=<token>)
let pendingResetToken = null;

export function setPendingInvite(token, context = null) {
  pendingInviteToken = token || null;
  pendingInviteContext = context;
}

export function getPendingInvite() {
  return { token: pendingInviteToken, context: pendingInviteContext };
}

export function clearPendingInvite() {
  pendingInviteToken = null;
  pendingInviteContext = null;
}

/** Read and strip `#invite=<token>` from the URL. Returns the token or null. */
export function consumeInviteFromUrl() {
  if (!window.location.hash.startsWith('#invite=')) return null;
  const token = window.location.hash.slice('#invite='.length).trim();
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch {}
  return token || null;
}

/** Read and strip `#reset=<token>` from the URL. Returns the token or null. */
export function consumeResetTokenFromUrl() {
  if (!window.location.hash.startsWith('#reset=')) return null;
  const token = window.location.hash.slice('#reset='.length).trim();
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch {}
  return token || null;
}

/**
 * Password recovery link entry point (#reset=<token>): switches the auth view
 * to the reset-password form so the user can choose a new password.
 */
export async function handleIncomingResetToken() {
  const token = consumeResetTokenFromUrl();
  if (!token) return false;
  pendingResetToken = token;
  setAuthMode('reset');
  navigateTo('auth', { mode: 'reset' });
  return true;
}

// ==========================================================================
// Password strength + caps lock helpers
// ==========================================================================

const STRENGTH_LEVELS = [
  { label: 'Too short', color: '#ef4444' },
  { label: 'Weak', color: '#ef4444' },
  { label: 'Fair', color: '#f59e0b' },
  { label: 'Good', color: '#10b981' },
  { label: 'Strong', color: '#059669' },
];

export function passwordStrength(password) {
  let score = 0;
  if (!password) return 0;
  if (password.length >= 8) score++;
  if (password.length >= 10) score++;
  if (/[a-zA-Z]/.test(password) && /\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password) || password.length >= 14) score++;
  return Math.min(score, 4);
}

export function renderStrengthMeter(meterEl, labelEl, password) {
  if (!meterEl) return;
  const bars = meterEl.querySelectorAll('.password-strength-bars span');
  const level = passwordStrength(password);

  if (!password) {
    meterEl.style.display = 'none';
    if (labelEl) labelEl.textContent = '';
    return;
  }

  meterEl.style.display = 'flex';
  const meta = STRENGTH_LEVELS[level];
  meterEl.style.setProperty('--strength-color', meta.color);
  bars.forEach((bar, idx) => {
    bar.classList.toggle('active', idx < level);
    bar.style.background = idx < level ? meta.color : '';
  });
  if (labelEl) {
    labelEl.textContent = meta.label;
    labelEl.style.color = meta.color;
  }
}

export function renderPasswordRequirements(container, password) {
  if (!container) return;
  const checks = {
    length: (password || '').length >= 8,
    letter: /[a-zA-Z]/.test(password || ''),
    number: /\d/.test(password || ''),
  };
  container.querySelectorAll('[data-req]').forEach((el) => {
    const key = el.dataset.req;
    el.classList.toggle('met', checks[key]);
    el.querySelector('.req-icon').textContent = checks[key] ? '✓' : '◦';
  });
}

function setupCapsLockWarning(input, warningEl) {
  if (!input || !warningEl) return;
  const update = (e) => {
    const on = e.getModifierState && e.getModifierState('CapsLock');
    warningEl.style.display = on ? 'block' : 'none';
  };
  input.addEventListener('keydown', update);
  input.addEventListener('keyup', update);
  input.addEventListener('blur', () => { warningEl.style.display = 'none'; });
}

// ==========================================================================
// Auth view mode management
// ==========================================================================

export function setAuthMode(mode) {
  state.set('authMode', mode);

  const titleEl = document.getElementById('auth-title');
  const subtitleEl = document.getElementById('auth-subtitle');
  const nameGroup = document.getElementById('auth-name-group');
  const emailGroup = document.getElementById('auth-email-group');
  const passwordGroup = document.getElementById('auth-password-group');
  const confirmGroup = document.getElementById('auth-confirm-password-group');
  const strengthMeter = document.getElementById('password-strength-meter');
  const requirements = document.getElementById('password-requirements');
  const optionsRow = document.getElementById('auth-options-row');
  const submitBtn = document.getElementById('auth-submit-btn');
  const switchPrompt = document.getElementById('auth-switch-question');
  const switchBtn = document.getElementById('auth-switch-btn');
  const alertEl = document.getElementById('auth-alert');

  if (alertEl) {
    alertEl.className = 'auth-alert';
    alertEl.textContent = '';
  }
  clearAuthFieldErrors();

  if (mode === 'reset') {
    // Password recovery completion (MOCK-03): the one-time token arrived via
    // #reset=<token>; the user only chooses and confirms a new password.
    if (titleEl) titleEl.textContent = 'Choose a New Password';
    if (subtitleEl) subtitleEl.textContent = 'Enter and confirm your new password to finish the recovery';
    if (nameGroup) nameGroup.style.display = 'none';
    if (emailGroup) emailGroup.style.display = 'none';
    if (passwordGroup) passwordGroup.style.display = 'block';
    if (confirmGroup) confirmGroup.style.display = 'block';
    if (strengthMeter) strengthMeter.style.display = passwordStrength(document.getElementById('auth-password-input')?.value || '') ? 'flex' : 'none';
    if (requirements) requirements.style.display = 'flex';
    if (optionsRow) optionsRow.style.display = 'none';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Update Password';
    if (switchPrompt) switchPrompt.textContent = 'Remembered your password?';
    if (switchBtn) switchBtn.textContent = 'Sign in';
  } else if (mode === 'forgot') {
    if (titleEl) titleEl.textContent = 'Reset Password';
    if (subtitleEl) subtitleEl.textContent = 'Enter your email address to receive password recovery instructions';
    if (nameGroup) nameGroup.style.display = 'none';
    if (emailGroup) emailGroup.style.display = 'block';
    if (passwordGroup) passwordGroup.style.display = 'none';
    if (confirmGroup) confirmGroup.style.display = 'none';
    if (strengthMeter) strengthMeter.style.display = 'none';
    if (requirements) requirements.style.display = 'none';
    if (optionsRow) optionsRow.style.display = 'none';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Send Recovery Link';
    if (switchPrompt) switchPrompt.textContent = 'Remembered your password?';
    if (switchBtn) switchBtn.textContent = 'Sign in';
  } else if (mode === 'register') {
    if (titleEl) titleEl.textContent = 'Create Account';
    if (subtitleEl) subtitleEl.textContent = 'Get started with your free Pocket Diary workspace';
    if (nameGroup) nameGroup.style.display = 'flex';
    if (emailGroup) emailGroup.style.display = 'block';
    if (passwordGroup) passwordGroup.style.display = 'block';
    if (confirmGroup) confirmGroup.style.display = 'block';
    if (strengthMeter) strengthMeter.style.display = passwordStrength(document.getElementById('auth-password-input')?.value || '') ? 'flex' : 'none';
    if (requirements) requirements.style.display = 'flex';
    if (optionsRow) optionsRow.style.display = 'none';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Create Account';
    if (switchPrompt) switchPrompt.textContent = 'Already have an account?';
    if (switchBtn) switchBtn.textContent = 'Sign in';
  } else {
    if (titleEl) titleEl.textContent = 'Welcome Back';
    if (subtitleEl) subtitleEl.textContent = 'Sign in to your Pocket Diary account';
    if (nameGroup) nameGroup.style.display = 'none';
    if (emailGroup) emailGroup.style.display = 'block';
    if (passwordGroup) passwordGroup.style.display = 'block';
    if (confirmGroup) confirmGroup.style.display = 'none';
    if (strengthMeter) strengthMeter.style.display = 'none';
    if (requirements) requirements.style.display = 'none';
    if (optionsRow) optionsRow.style.display = 'flex';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Sign In';
    if (switchPrompt) switchPrompt.textContent = "Don't have an account?";
    if (switchBtn) switchBtn.textContent = 'Sign up';
  }
}

export function clearAuthFieldErrors() {
  document.querySelectorAll('.form-error-msg').forEach((el) => {
    el.classList.remove('active');
  });
}

export function showAuthAlert(message, type = 'error') {
  const alertEl = document.getElementById('auth-alert');
  if (!alertEl) return;
  alertEl.className = `auth-alert ${type} active`;
  alertEl.textContent = message;
}

/** Show the workspace-invitation context banner on the auth screen. */
function renderInviteBanner() {
  const banner = document.getElementById('auth-invite-banner');
  if (!banner) return;

  if (!pendingInviteToken || !pendingInviteContext) {
    banner.style.display = 'none';
    return;
  }

  // Security (audit C-2): the banner is built with DOM APIs and textContent
  // only — workspaceName is attacker-controlled (any user can name their
  // workspace `<img src=x onerror=…>`) and must never pass through innerHTML.
  banner.replaceChildren();
  banner.className = pendingInviteContext.usable ? 'auth-invite-banner' : 'auth-invite-banner invalid';

  const icon = document.createElement('span');
  icon.className = 'invite-icon';
  icon.textContent = pendingInviteContext.usable ? '✉️' : '⚠️';

  const text = document.createElement('div');
  if (!pendingInviteContext.usable) {
    const headline = document.createElement('strong');
    headline.textContent = 'This invitation is no longer valid';
    const detail = document.createElement('span');
    detail.textContent = pendingInviteContext.status === 'revoked'
      ? 'It was revoked by the workspace admin.'
      : pendingInviteContext.expired
        ? 'It has expired.'
        : 'It was already used.';
    detail.textContent += ' You can still create your own workspace below.';
    text.append(headline, detail);
  } else {
    const ctx = pendingInviteContext;
    const headline = document.createElement('strong');
    headline.append(
      "You've been invited to join “",
      document.createTextNode(ctx.workspaceName || 'a workspace'),
      '”',
    );
    const detail = document.createElement('span');
    const roleStrong = document.createElement('strong');
    roleStrong.textContent = ctx.role || 'editor';
    const emailStrong = document.createElement('strong');
    emailStrong.textContent = ctx.email || '';
    detail.append(
      'Accepting creates your account and adds you to the workspace as ',
      roleStrong,
      ' for ',
      emailStrong,
      '.',
    );
    text.append(headline, detail);
  }

  banner.append(icon, text);
  banner.style.display = 'flex';
}

/**
 * Load a workspace invitation by token, prefill the register screen and show
 * the invitation banner. Used for both signed-out and signed-in visitors.
 */
export async function loadInviteContext(token) {
  if (!token) return null;
  try {
    const res = await api.lookupInvite(token);
    pendingInviteContext = res.invite || null;
    setPendingInvite(token, pendingInviteContext);
    renderInviteBanner();

    // Signed-out visitor: prefill email and switch to register mode
    if (pendingInviteContext?.usable && !state.get('isAuthenticated')) {
      const emailInput = document.getElementById('auth-email-input');
      if (emailInput) {
        emailInput.value = pendingInviteContext.email;
        emailInput.readOnly = true;
      }
      setAuthMode('register');
      navigateTo('auth', { mode: 'register' });
    }
    return pendingInviteContext;
  } catch {
    pendingInviteContext = { usable: false, status: 'not-found', expired: true, workspaceName: '', email: '', role: '' };
    setPendingInvite(token, pendingInviteContext);
    renderInviteBanner();
    return pendingInviteContext;
  }
}

export async function handleAuthSubmit(e) {
  e.preventDefault();
  clearAuthFieldErrors();

  const mode = state.get('authMode') || 'login';
  const emailInput = document.getElementById('auth-email-input');
  const passwordInput = document.getElementById('auth-password-input');
  const confirmInput = document.getElementById('auth-confirm-password-input');
  const nameInput = document.getElementById('auth-name-input');
  const submitBtn = document.getElementById('auth-submit-btn');

  const email = emailInput?.value.trim() || '';
  const password = passwordInput?.value || '';
  const confirm = confirmInput?.value || '';
  const name = nameInput?.value.trim() || '';

  let hasError = false;

  if (mode !== 'forgot' && mode !== 'reset' && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    document.getElementById('auth-email-error')?.classList.add('active');
    hasError = true;
  }

  // Audit L-9: mirror the server policy exactly (min 8 + letter + number).
  const passwordPolicyError = (pwd) => !pwd
    || pwd.length < 8
    || !/[a-zA-Z]/.test(pwd)
    || !/\d/.test(pwd);
  if (mode !== 'forgot' && passwordPolicyError(password)) {
    document.getElementById('auth-password-error')?.classList.add('active');
    hasError = true;
  }

  if (mode === 'register' || mode === 'reset') {
    if (mode === 'register' && (!name || name.length < 2)) {
      document.getElementById('auth-name-error')?.classList.add('active');
      hasError = true;
    }
    if (password !== confirm) {
      document.getElementById('auth-confirm-password-error')?.classList.add('active');
      hasError = true;
    }
  }

  if (hasError) return;

  if (mode === 'reset' && !pendingResetToken) {
    showAuthAlert('This password reset link is missing or invalid. Request a new recovery link.', 'error');
    setAuthMode('forgot');
    return;
  }

  const originalBtnText = submitBtn.querySelector('.auth-btn-text').textContent;
  submitBtn.disabled = true;
  submitBtn.querySelector('.auth-btn-text').textContent =
    mode === 'forgot' ? 'Sending...' : mode === 'reset' ? 'Updating...' : mode === 'register' ? 'Creating Account...' : 'Signing In...';

  try {
    if (mode === 'forgot') {
      const response = await api.forgotPassword(email);
      let message = response.message || `Password recovery instructions sent to ${email}`;
      if (response.emailConfigured === false) {
        // Honest self-hosted hint: without SMTP the reset email cannot be
        // delivered, so point the user at their instance administrator.
        message += ' (Email delivery is not configured on this server — contact your instance administrator to complete the recovery.)';
      }
      showAuthAlert(message, 'success');
      showToast('Password recovery sent!', 'success');
    } else if (mode === 'reset') {
      const response = await api.resetPassword(pendingResetToken, password);
      pendingResetToken = null;
      showToast(response.message || 'Password updated successfully', 'success');
      resetAuthForm();
      setAuthMode('login');
      showAuthAlert('Password updated successfully. Sign in with your new password.', 'success');
    } else if (mode === 'register') {
      const response = await api.register({
        email,
        password,
        name,
        ...(pendingInviteToken ? { inviteToken: pendingInviteToken } : {}),
      });
      const user = response.user;
      const workspace = response.workspace;

      if (response.inviteWarning) {
        showToast(response.inviteWarning, 'warning', 4000);
      }
      if (response.joinedWorkspace) {
        showToast(`Welcome! You joined “${response.joinedWorkspace.name}”`, 'success', 3500);
      }

      clearPendingInvite();
      const emailField = document.getElementById('auth-email-input');
      if (emailField) emailField.readOnly = false;
      renderInviteBanner();

      state.setUser(user, [workspace], workspace);
      showToast(`Welcome to Pocket Diary, ${user.name}!`, 'success');
      resetAuthForm();
      await fetchWorkspaceData();
      navigateTo('dashboard');
    } else {
      const rememberMe = document.getElementById('remember-me-checkbox')?.checked ?? true;
      const response = await api.login({ email, password, rememberMe });
      const user = response.user;
      const activeWorkspace = response.activeWorkspace;

      let workspaces = [activeWorkspace];
      try {
        const meData = await api.getMe();
        if (meData.workspaces && meData.workspaces.length) {
          workspaces = meData.workspaces;
        }
      } catch {
        // Fallback to activeWorkspace
      }

      state.setUser(user, workspaces, activeWorkspace);
      showToast(`Welcome back, ${user.name}!`, 'success');
      resetAuthForm();
      await fetchWorkspaceData();
      navigateTo('dashboard');

      // A signed-in user following an invite link joins the workspace right away.
      if (pendingInviteToken) {
        const token = pendingInviteToken;
        clearPendingInvite();
        try {
          const res = await api.acceptInvite(token);
          showToast(`You joined “${res.workspace.name}” as ${res.workspace.role}`, 'success', 3500);
          const meData = await api.getMe();
          state.set('workspaces', meData.workspaces || []);
          await fetchWorkspaceData();
        } catch (err) {
          showToast(err.message || 'Invitation could not be accepted', 'warning', 4000);
        }
      }
    }
  } catch (err) {
    console.error('Authentication error:', err);
    const errorMsg = err.message || (mode === 'register' ? 'Registration failed' : 'Invalid email or password');
    showAuthAlert(errorMsg, 'error');
    showToast(errorMsg, 'error');
    // A rejected or already-used reset token returns the user to the recovery screen.
    if (mode === 'reset' && (err.status === 400 || err.status === 404)) {
      pendingResetToken = null;
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector('.auth-btn-text').textContent = originalBtnText;
  }
}

export function resetAuthForm() {
  const form = document.getElementById('auth-form');
  if (form) form.reset();
  const alertEl = document.getElementById('auth-alert');
  if (alertEl) {
    alertEl.className = 'auth-alert';
    alertEl.textContent = '';
  }
  clearAuthFieldErrors();
  renderStrengthMeter(document.getElementById('password-strength-meter'), document.getElementById('password-strength-label'), '');
  renderPasswordRequirements(document.getElementById('password-requirements'), '');
}

/** Wire up the auth screen's interactive validation helpers (idempotent). */
export function setupAuthFormEnhancements() {
  const passwordInput = document.getElementById('auth-password-input');
  const confirmInput = document.getElementById('auth-confirm-password-input');
  const strengthMeter = document.getElementById('password-strength-meter');
  const requirements = document.getElementById('password-requirements');
  const capsWarning = document.getElementById('caps-lock-warning');

  if (passwordInput?.dataset.enhanced !== 'true') {
    passwordInput.dataset.enhanced = 'true';
    passwordInput.addEventListener('input', () => {
      const value = passwordInput.value;
      if (state.get('authMode') === 'register' || state.get('authMode') === 'reset') {
        renderStrengthMeter(strengthMeter, document.getElementById('password-strength-label'), value);
        renderPasswordRequirements(requirements, value);
      }
      // Live match feedback on the confirm field
      if ((state.get('authMode') === 'register' || state.get('authMode') === 'reset') && confirmInput?.value) {
        const match = confirmInput.value === value;
        confirmInput.closest('.form-group')?.classList.toggle('has-match', match);
      }
    });
    setupCapsLockWarning(passwordInput, capsWarning);
  }

  if (confirmInput?.dataset.enhanced !== 'true') {
    confirmInput.dataset.enhanced = 'true';
    setupCapsLockWarning(confirmInput, document.getElementById('caps-lock-warning'));
  }

  // Toggle both password fields together
  const toggleBtn = document.getElementById('password-toggle-btn');
  if (toggleBtn?.dataset.enhanced !== 'true') {
    toggleBtn.dataset.enhanced = 'true';
    toggleBtn.addEventListener('click', () => {
      const fields = [passwordInput, confirmInput].filter(Boolean);
      const anyHidden = fields.some((f) => f.type === 'password');
      fields.forEach((f) => { f.type = anyHidden ? 'text' : 'password'; });
    });
  }
}

export async function handleLogout() {
  try {
    // Best effort: drop this browser's push subscription on sign out.
    try {
      const reg = await navigator.serviceWorker?.getRegistration?.();
      const sub = await reg?.pushManager?.getSubscription?.();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
    } catch { /* push not available */ }

    await api.logout();
    state.clearUser();
    resetStorageWidget();
    showToast('Signed out successfully', 'info');
    closeUserDropdown();
    navigateTo('landing');
  } catch (err) {
    console.error('Logout error:', err);
    state.clearUser();
    resetStorageWidget();
    closeUserDropdown();
    navigateTo('landing');
  }
}

export async function detectSession() {
  try {
    const data = await api.getMe();
    if (data && data.user) {
      state.setUser(data.user, data.workspaces || [], data.workspaces?.[0] || null);
      await fetchWorkspaceData();
      if (state.get('currentView') === 'landing' || state.get('currentView') === 'auth') {
        navigateTo('dashboard');
      }
      return true;
    }
  } catch {
    state.clearUser();
  }
  return false;
}

export function closeUserDropdown() {
  const el = document.getElementById('user-dropdown-menu') || document.getElementById('user-menu-dropdown');
  el?.classList.remove('active');
}

export function toggleUserDropdown() {
  const el = document.getElementById('user-dropdown-menu') || document.getElementById('user-menu-dropdown');
  el?.classList.toggle('active');
}
