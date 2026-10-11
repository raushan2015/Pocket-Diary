/**
 * Authentication & Session Controller
 * Handles user login, registration, password recovery, session detection, and logout.
 */

import { api } from './api.js';
import { state } from './state.js';
import { showToast } from './utils.js';
import { navigateTo } from './navigation.js';
import { fetchWorkspaceData } from './workspace-data.js';

export function setAuthMode(mode) {
  state.set('authMode', mode);

  const titleEl = document.getElementById('auth-title');
  const subtitleEl = document.getElementById('auth-subtitle');
  const nameGroup = document.getElementById('auth-name-group');
  const passwordGroup = document.getElementById('auth-password-input')?.closest('.form-group');
  const optionsRow = document.getElementById('auth-options-row');
  const submitBtn = document.getElementById('auth-submit-btn');
  const switchPrompt = document.getElementById('auth-switch-question');
  const switchBtn = document.getElementById('auth-switch-btn');
  const alertEl = document.getElementById('auth-alert');
  const divider = document.querySelector('.auth-divider');
  const socialRow = document.querySelector('.auth-social-row');

  if (alertEl) {
    alertEl.className = 'auth-alert';
    alertEl.textContent = '';
  }
  clearAuthFieldErrors();

  if (mode === 'forgot') {
    if (titleEl) titleEl.textContent = 'Reset Password';
    if (subtitleEl) subtitleEl.textContent = 'Enter your email address to receive password recovery instructions';
    if (nameGroup) nameGroup.style.display = 'none';
    if (passwordGroup) passwordGroup.style.display = 'none';
    if (optionsRow) optionsRow.style.display = 'none';
    if (divider) divider.style.display = 'none';
    if (socialRow) socialRow.style.display = 'none';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Send Recovery Link';
    if (switchPrompt) switchPrompt.textContent = 'Remembered your password?';
    if (switchBtn) switchBtn.textContent = 'Sign in';
  } else if (mode === 'register') {
    if (titleEl) titleEl.textContent = 'Create Account';
    if (subtitleEl) subtitleEl.textContent = 'Get started with your free Notes workspace';
    if (nameGroup) nameGroup.style.display = 'flex';
    if (passwordGroup) passwordGroup.style.display = 'block';
    if (optionsRow) optionsRow.style.display = 'none';
    if (divider) divider.style.display = 'flex';
    if (socialRow) socialRow.style.display = 'grid';
    if (submitBtn) submitBtn.querySelector('.auth-btn-text').textContent = 'Create Account';
    if (switchPrompt) switchPrompt.textContent = 'Already have an account?';
    if (switchBtn) switchBtn.textContent = 'Sign in';
  } else {
    if (titleEl) titleEl.textContent = 'Welcome Back';
    if (subtitleEl) subtitleEl.textContent = 'Sign in to your Notes account';
    if (nameGroup) nameGroup.style.display = 'none';
    if (passwordGroup) passwordGroup.style.display = 'block';
    if (optionsRow) optionsRow.style.display = 'flex';
    if (divider) divider.style.display = 'flex';
    if (socialRow) socialRow.style.display = 'grid';
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

export async function handleAuthSubmit(e) {
  e.preventDefault();
  clearAuthFieldErrors();

  const mode = state.get('authMode') || 'login';
  const emailInput = document.getElementById('auth-email-input');
  const passwordInput = document.getElementById('auth-password-input');
  const nameInput = document.getElementById('auth-name-input');
  const submitBtn = document.getElementById('auth-submit-btn');

  const email = emailInput?.value.trim() || '';
  const password = passwordInput?.value || '';
  const name = nameInput?.value.trim() || '';

  let hasError = false;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('auth-email-error')?.classList.add('active');
    hasError = true;
  }

  if (mode !== 'forgot' && (!password || password.length < 6)) {
    document.getElementById('auth-password-error')?.classList.add('active');
    hasError = true;
  }

  if (mode === 'register' && (!name || name.length < 2)) {
    document.getElementById('auth-name-error')?.classList.add('active');
    hasError = true;
  }

  if (hasError) return;

  const originalBtnText = submitBtn.querySelector('.auth-btn-text').textContent;
  submitBtn.disabled = true;
  submitBtn.querySelector('.auth-btn-text').textContent =
    mode === 'forgot' ? 'Sending...' : mode === 'register' ? 'Creating Account...' : 'Signing In...';

  try {
    if (mode === 'forgot') {
      const response = await api.forgotPassword(email);
      showAuthAlert(response.message || `Password recovery instructions sent to ${email}`, 'success');
      showToast('Password recovery sent!', 'success');
    } else if (mode === 'register') {
      const response = await api.register({ email, password, name });
      const user = response.user;
      const workspace = response.workspace;

      state.setUser(user, [workspace], workspace);
      showToast(`Welcome to Notes, ${user.name}!`, 'success');
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
    }
  } catch (err) {
    console.error('Authentication error:', err);
    const errorMsg = err.message || (mode === 'register' ? 'Registration failed' : 'Invalid email or password');
    showAuthAlert(errorMsg, 'error');
    showToast(errorMsg, 'error');
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
}

export async function handleLogout() {
  try {
    await api.logout();
    state.clearUser();
    showToast('Signed out successfully', 'info');
    closeUserDropdown();
    navigateTo('landing');
  } catch (err) {
    console.error('Logout error:', err);
    state.clearUser();
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
