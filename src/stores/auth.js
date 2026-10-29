import { defineStore } from 'pinia';
import { isElectron, isCapacitor, getPlatform } from '../utils/platform';
import {
  sessionTicket, isCurrentTicket, applySession as applyMobileSession, signOut as signOutMobile, loadSession as loadMobileSession
} from '../services/sessionAuthority';
import { apiRequest, authenticatedRequest, API_ENDPOINTS, parseJsonSafe } from '../services/api';
import { addBreadcrumb, captureException, captureMessage, setUser } from '../boot/sentry';
import { i18n } from '../boot/i18n';
import { describeLoginFailure, describeRegisterFailure, classifySsoError } from '../utils/authErrors';
import {
  twoFactorChallengeFrom, startTwoFactorStep, resendSecondsLeft, normalizeOtp, normalizeBackupCode,
  describeTwoFactorFailure, describeResendFailure, RESEND_COOLDOWN_MS
} from '../utils/twoFactor';

const tr = (key, params) => { try { return params ? i18n.global.t(key, params) : i18n.global.t(key); } catch { return key; } };

/** fetch() rejects with TypeError offline, TimeoutError on our deadline. */
function isNetworkFailure(error) {
  return !!error && (error.name === 'TypeError' || error.name === 'TimeoutError' || error.code === 'ETIMEDOUT' ||
    /failed to fetch|load failed|network|timed out/i.test(error.message || ''));
}

/** Kind of a thrown network failure, for the translated message. */
function networkKind(error) {
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || /timed out/i.test(error?.message || '')) return 'timeout';
  return 'offline';
}

/**
 * Load the minutes balance for a session that did not bring one (SSO,
 * registration, a login answer without `minutes`). Without it the Record page
 * judged a brand-new account by the empty default and said "no credits".
 * Never blocks sign-in; the minutes store dedupes concurrent fetches.
 */
async function refreshMinutesInBackground(token) {
  if (!token) return;
  try {
    const { useMinutesStore } = await import('./minutes');
    useMinutesStore().fetchMinutes(token, true).catch(() => {});
  } catch { /* the minutes load again on the next refresh tick */ }
}

/**
 * P1 Fix: Resume pending mobile uploads after successful authentication.
 * Uploads may have failed with 401 while the user was logged out or token was expired.
 */
async function resumeMobileUploadQueue(authStore) {
  if (!isCapacitor()) return;
  try {
    const { processMobileUploadQueue, getMobileUploadQueue } = await import('../services/upload');
    const { getApiUrlSync } = await import('../services/api');
    const queue = getMobileUploadQueue();
    if (queue.length > 0) {
      console.log(`Auth: Resuming ${queue.length} pending mobile upload(s) after authentication`);
      processMobileUploadQueue(authStore, getApiUrlSync).catch(e =>
        console.warn('Auth: Failed to resume mobile upload queue:', e)
      );
    }
  } catch (e) {
    console.warn('Auth: Could not resume mobile uploads:', e);
  }
}

/**
 * Platform-aware auth helpers.
 * On Electron, login/register go through IPC (main process makes the HTTP call).
 * On Capacitor/web, we call the backend directly via fetch.
 */
async function platformLogin(username, password) {
  const platform = getPlatform();
  addBreadcrumb({ category: 'auth', message: `Login attempt on ${platform}`, level: 'info' });

  if (isElectron()) {
    return window.electronAPI.auth.login(username, password);
  }
  // Mobile / web: direct fetch. `twoFactor: "supported"`: this app asks for
  // the second factor (utils/twoFactor.js); older backends ignore the field.
  let response;
  try {
    response = await apiRequest(API_ENDPOINTS.login, {
      method: 'POST',
      body: JSON.stringify({ email: username, password, twoFactor: 'supported' }),
      // Safe to resend: a gateway answer means the backend was restarting.
      retryGateway: true
    });
  } catch (error) {
    if (isNetworkFailure(error)) {
      addBreadcrumb({ category: 'auth', message: `Login: network failure (${error.message})`, level: 'warning' });
      return { success: false, network: networkKind(error), networkError: true };
    }
    throw error;
  }
  const data = await parseJsonSafe(response);
  const challenge = response.ok && !data.nonJson && !data.token ? twoFactorChallengeFrom(data) : null;
  if (challenge) {
    addBreadcrumb({ category: 'auth', message: `Login: second factor required (${challenge.twoFactorMethod})`, level: 'info' });
    return { success: false, ...challenge };
  }
  if (!response.ok || data.nonJson || !data.token) {
    addBreadcrumb({ category: 'auth', message: `Login failed: HTTP ${response.status} code=${data.code || '-'}`, level: 'warning' });
    // Structured for describeLoginFailure; the server's sentence is never shown.
    return failureFromAnswer(response, data);
  }
  addBreadcrumb({ category: 'auth', message: 'Login successful', level: 'info' });
  return { success: true, token: data.token, user: data.user, minutes: data.minutes };
}

async function platformRegister(email, password, name) {
  if (isElectron()) {
    return window.electronAPI.auth.register(email, password, name);
  }
  let response;
  try {
    response = await apiRequest(API_ENDPOINTS.register, {
      method: 'POST',
      body: JSON.stringify({ email, password, name })
    });
  } catch (error) {
    if (isNetworkFailure(error)) return { success: false, network: networkKind(error), networkError: true };
    throw error;
  }
  const data = await parseJsonSafe(response);
  if (!response.ok || data.nonJson || !data.token) {
    return failureFromAnswer(response, data);
  }
  return { success: true, token: data.token, user: data.user };
}

/**
 * Second factor: POST /api/auth/desktop/verify-2fa. Success has the shape of
 * a password sign-in success. Desktop goes through the main process.
 */
async function platformVerifyTwoFactor(tempToken, code, isBackupCode) {
  if (isElectron()) {
    return window.electronAPI.auth.verifyTwoFactor(tempToken, code, isBackupCode);
  }
  let response;
  try {
    response = await apiRequest(API_ENDPOINTS.verifyTwoFactor, {
      method: 'POST',
      body: JSON.stringify({ tempToken, code, isBackupCode }),
      // A gateway answer never reached the backend: resending cannot count twice.
      retryGateway: true
    });
  } catch (error) {
    if (isNetworkFailure(error)) return { success: false, network: networkKind(error), networkError: true };
    throw error;
  }
  const data = await parseJsonSafe(response);
  if (!response.ok || data.nonJson || !data.token) return failureFromAnswer(response, data);
  return { success: true, token: data.token, user: data.user, minutes: data.minutes };
}

/** E-mail second factor: POST /api/auth/resend-2fa-email. */
async function platformResendTwoFactorEmail(tempToken) {
  if (isElectron()) {
    return window.electronAPI.auth.resendTwoFactorEmail(tempToken);
  }
  let response;
  try {
    response = await apiRequest(API_ENDPOINTS.resendTwoFactorEmail, {
      method: 'POST',
      body: JSON.stringify({ tempToken })
    });
  } catch (error) {
    if (isNetworkFailure(error)) return { success: false, network: networkKind(error), networkError: true };
    throw error;
  }
  const data = await parseJsonSafe(response);
  if (response.ok && !data.nonJson && data.success === true) return { success: true };
  return failureFromAnswer(response, data);
}

/**
 * Failed (or unusable) auth answer -> the structured failure the error
 * mapping reads. A 2xx without a token counts as an unexpected answer.
 */
function failureFromAnswer(response, data) {
  const usable = response.ok && !data.nonJson;
  return {
    success: false,
    status: usable ? 0 : response.status,
    code: typeof data.code === 'string' ? data.code : undefined,
    provider: typeof data.provider === 'string' ? data.provider : undefined,
    nonJson: !!data.nonJson || usable,
    // Only matched against the legacy backend's known sentences, never shown.
    serverError: typeof data.error === 'string' ? data.error.slice(0, 200) : undefined
  };
}

/**
 * E2: the ticket of a sign-in that starts now. Mobile (and the web build used
 * in tests): the session authority in services/sessionAuthority.js. Desktop:
 * main takes it itself in the IPC handler and applies the result there
 * (src-electron/session-authority.js).
 */
function signInTicket(extra) {
  return isElectron() ? null : sessionTicket(extra);
}

/** E5 steps 1-3 on every platform; never throws. */
async function platformSignOut() {
  try {
    if (isElectron()) return (await window.electronAPI.auth.signOut()) || { success: false };
    return await signOutMobile();
  } catch (error) {
    console.error('Sign-out failed:', error?.message || error);
  }
  return { success: false, error: 'sign_out_incomplete' };
}

/** The stored session at start, or signed out (E6). */
async function platformRestoreSession() {
  if (isElectron()) return (await window.electronAPI.auth.restoreSession()) || { signedOut: true };
  return loadMobileSession();
}

/** Rollout stop signal: an open SSO flow got a callback without state. No data. */
function countMissingState() {
  captureMessage('sso_missing_state', 'warning', { fingerprint: ['sso_missing_state'] });
}

// Token refresh interval: 30 minutes. The backend /api/auth/refresh route is
// designed for this cadence (issues a fresh 7-day JWT each call) — the old 6h
// interval let long-idle sessions drift toward expiry with no visible signal.
const TOKEN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
// Mirror of the backend's post-expiry grace window on /api/auth/refresh:
// an expired token can still be exchanged for a fresh one within 24h.
const REFRESH_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
// Proactively refresh when less than this much lifetime remains.
const TOKEN_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function decodeJwtExpMs(token) {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

function decodeJwtUserId(token) {
  try {
    const payload = token.split('.')[1];
    const std = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(std + '='.repeat((4 - (std.length % 4)) % 4)));
    return typeof json.userId === 'string' && json.userId ? json.userId : null;
  } catch {
    return null;
  }
}

const SSO_USER_FIELDS = ['id', 'email', 'name', 'role', 'organizationId', 'organizationName', 'image', 'language', 'locale'];

/**
 * The user object of an SSO result comes from a URL. Keep only plain fields
 * and require the id to be the token's own userId: a result whose user does
 * not belong to its token is refused.
 */
export function sanitizeSsoUser(user, token) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const tokenUserId = decodeJwtUserId(token);
  if (!tokenUserId || String(user.id ?? '') !== tokenUserId) return null;
  const clean = {};
  for (const key of SSO_USER_FIELDS) {
    const value = user[key];
    if (typeof value === 'string') clean[key] = value.slice(0, 320);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  clean.id = tokenUserId;
  return clean;
}

/** Mobile PKCE exchange: one-time code + verifier -> { token, user }. */
async function exchangeSsoCode(authCode, verifier, state) {
  const response = await apiRequest('/api/auth/sso/exchange', {
    method: 'POST',
    body: JSON.stringify({ authCode, codeVerifier: verifier, state })
  });
  const data = await parseJsonSafe(response);
  if (!response.ok || !data || !data.token || !data.user) return null;
  return { token: data.token, user: data.user };
}

/**
 * Classify a stored JWT against the backend's lifetime rules:
 * 'active' — valid with comfortable lifetime left
 * 'stale'  — valid but close to expiry (refresh soon)
 * 'grace'  — expired, but within the backend's 24h refresh grace window
 * 'dead'   — expired beyond grace; only a fresh login can revive the session
 * Undecodable tokens classify as 'stale' (the server is the authority — a
 * refresh attempt settles it) rather than locking the user out client-side.
 */
export function getTokenState(token) {
  if (!token) return 'dead';
  const expMs = decodeJwtExpMs(token);
  if (expMs === null) return 'stale';
  const now = Date.now();
  if (expMs > now + TOKEN_STALE_THRESHOLD_MS) return 'active';
  if (expMs > now) return 'stale';
  if (now - expMs < REFRESH_GRACE_PERIOD_MS) return 'grace';
  return 'dead';
}

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    token: null,
    isAuthenticated: false,
    sessionChecked: false,  // Track if initial session check is complete
    loading: false,
    error: null,
    // SSO flow in flight: null | 'microsoft' | 'google'. Lives here (not in
    // the login page) because the result is handled app-wide - it may arrive
    // while another page is shown, or minutes later after a 2FA step.
    ssoProvider: null,
    // Last SSO outcome; `seq` increments per result so a screen can react.
    ssoOutcome: { seq: 0, success: false, cancelled: false, reason: null },
    // Password sign-in waiting for the second factor:
    // null | { method: 'AUTHENTICATOR'|'EMAIL', tempToken, resendAvailableAt }.
    // In memory only (the temp token is short-lived and never stored).
    twoFactor: null,
    twoFactorResending: false,
    _refreshPromise: null,  // Mutex for token refresh (prevents concurrent stampede)
    // Epoch of the session authority this state mirrors (desktop: main's).
    // A result of an older epoch never changes this state.
    _epoch: -1,
    _tokenRefreshInterval: null,
  }),

  actions: {
    /**
     * Password sign-in. For an account with 2FA (new backend) the answer is a
     * challenge: no session yet, `twoFactor` holds the step and the result
     * says { requiresTwoFactor: true } - the screen then asks for the code
     * (verifyTwoFactor). Old backends answer exactly as before.
     */
    async login(username, password) {
      this.loading = true;
      this.error = null;
      this.twoFactor = null;
      const ticket = signInTicket();

      try {
        const result = await platformLogin(username, password);

        if (result.ignored) {
          return { success: false, ignored: true, reason: result.reason || 'session_changed' };
        } else if (result.success) {
          if (!(await this._completePasswordLogin(result, ticket))) {
            return { success: false, ignored: true, reason: 'session_changed' };
          }
          return { success: true };
        } else if (result.requiresTwoFactor && result.tempToken) {
          this.twoFactor = startTwoFactorStep(result);
          addBreadcrumb({ category: 'auth', message: `Second factor required (${this.twoFactor.method})`, level: 'info' });
          return { success: false, requiresTwoFactor: true, method: this.twoFactor.method };
        } else {
          const failure = describeLoginFailure(result);
          this.error = tr(failure.key);
          return { success: false, error: this.error, reason: failure.reason };
        }
      } catch (error) {
        if (isNetworkFailure(error)) {
          captureMessage(`auth: login network failure — ${error.message}`, 'warning');
          const failure = describeLoginFailure({ network: networkKind(error) });
          this.error = tr(failure.key);
          return { success: false, error: this.error, reason: failure.reason };
        }
        captureException(error, { tags: { action: 'login' } });
        this.error = tr('loginFailedGeneric');
        return { success: false, error: this.error, reason: 'exception' };
      } finally {
        this.loading = false;
      }
    },

    /**
     * Apply a sign-in result through the session authority (E2/E3) and
     * mirror it here. Desktop: main applied it already (the IPC answer
     * carries its epoch). Mobile: applySession with the ticket taken when the
     * sign-in started.
     * @returns {Promise<boolean>} false: dropped (the session changed meanwhile)
     */
    async _applySignIn(result, ticket, kind) {
      if (isElectron()) {
        if (!Number.isSafeInteger(result?.epoch) || result.epoch < this._epoch) return false;
        this._epoch = result.epoch;
      } else {
        const applied = await applyMobileSession(ticket, { token: result.token, user: result.user }, { kind });
        if (!applied.applied || !isCurrentTicket({ epoch: applied.epoch })) return false;
        this._epoch = applied.epoch;
      }
      // Synchronous from here: the state matches the authority's session.
      this.user = result.user;
      this.token = result.token;
      this.isAuthenticated = true;
      this.error = null;
      this.twoFactor = null;
      // A Microsoft/Google sign-in still waiting in the browser is over (the
      // authority dropped its flow).
      this.ssoProvider = null;
      return true;
    },

    /**
     * Session from a password sign-in success (directly or after the second factor).
     * @returns {Promise<boolean>} false when the result was dropped
     */
    async _completePasswordLogin(result, ticket) {
      if (!(await this._applySignIn(result, ticket, 'login'))) {
        addBreadcrumb({ category: 'auth', message: 'Sign-in result dropped: session changed', level: 'warning' });
        return false;
      }

      // Set Sentry user context
      setUser(result.user);

      // Seed minutes store from login response
      if (result.minutes) {
        const { useMinutesStore } = await import('./minutes');
        const minutesStore = useMinutesStore();
        minutesStore.setFromServer(result.minutes);
      } else {
        refreshMinutesInBackground(result.token);
      }

      // Start periodic token refresh
      this.startTokenRefresh();

      // Reload device store for this user (user-scoped BLE pairings)
      try {
        const { useDeviceStore } = await import('./device');
        const deviceStore = useDeviceStore();
        await deviceStore.reloadForUser();
      } catch (e) {
        console.warn('Device store reload after login failed:', e);
      }

      // P1 Fix: Resume any pending uploads that failed while logged out
      resumeMobileUploadQueue(this);
      return true;
    },

    /**
     * Second factor: the code from the authenticator app / e-mail, or a
     * backup code. Success continues exactly like a password sign-in.
     * A failure that ends the step (expired, too many attempts) goes back to
     * the password form with the text in `error`.
     * @returns {Promise<{ success: boolean, reason?: string, next?: 'stay'|'password', error?: string }>}
     */
    async verifyTwoFactor(code, { backup = false } = {}) {
      const step = this.twoFactor;
      if (!step) {
        this.error = tr('twoFactorSessionExpired');
        return { success: false, reason: '2fa_no_step', next: 'password', error: this.error };
      }
      const normalized = backup ? normalizeBackupCode(code) : normalizeOtp(code);
      if (!normalized) {
        // The screen validates first; this is the safety net.
        const failure = describeTwoFactorFailure({ code: backup ? 'invalid_backup_code' : 'invalid_format' }, { backup });
        this.error = tr(failure.key);
        return { success: false, reason: failure.reason, next: 'stay', error: this.error };
      }

      this.loading = true;
      this.error = null;
      const ticket = signInTicket();
      try {
        const result = await platformVerifyTwoFactor(step.tempToken, normalized, backup);
        // "Back to sign-in" (or a new password attempt) while the answer was
        // on its way: this step is over - neither sign in nor show its error.
        if (this.twoFactor !== step) {
          addBreadcrumb({ category: 'auth', message: 'Second-factor answer ignored: step was left', level: 'info' });
          return { success: false, ignored: true, reason: '2fa_step_left', next: 'password' };
        }
        if (result?.ignored) {
          return { success: false, ignored: true, reason: result.reason || 'session_changed', next: 'password' };
        }
        if (result?.success && result.token) {
          if (!(await this._completePasswordLogin(result, ticket))) {
            return { success: false, ignored: true, reason: 'session_changed', next: 'password' };
          }
          addBreadcrumb({ category: 'auth', message: 'Second factor accepted', level: 'info' });
          return { success: true };
        }
        const failure = describeTwoFactorFailure(result || {}, { backup });
        this.error = tr(failure.key);
        if (failure.next === 'password') this.twoFactor = null;
        return { success: false, reason: failure.reason, next: failure.next, error: this.error };
      } catch (error) {
        if (this.twoFactor !== step) {
          return { success: false, ignored: true, reason: '2fa_step_left', next: 'password' };
        }
        if (isNetworkFailure(error)) {
          const failure = describeTwoFactorFailure({ network: networkKind(error) }, { backup });
          this.error = tr(failure.key);
          return { success: false, reason: failure.reason, next: 'stay', error: this.error };
        }
        captureException(error, { tags: { action: 'verifyTwoFactor' } });
        this.error = tr('twoFactorFailedGeneric');
        return { success: false, reason: '2fa_exception', next: 'stay', error: this.error };
      } finally {
        this.loading = false;
      }
    },

    /** E-mail second factor: send a new code (60 s cooldown). */
    async resendTwoFactorEmail(now = Date.now()) {
      const step = this.twoFactor;
      if (!step || step.method !== 'EMAIL') return { success: false, reason: '2fa_resend_no_step' };
      if (resendSecondsLeft(step, now) > 0 || this.twoFactorResending) {
        return { success: false, reason: '2fa_resend_cooldown', cooldown: true };
      }
      this.twoFactorResending = true;
      this.error = null;
      try {
        const result = await platformResendTwoFactorEmail(step.tempToken);
        if (result?.success) {
          if (this.twoFactor === step) this.twoFactor = { ...step, resendAvailableAt: Date.now() + RESEND_COOLDOWN_MS };
          return { success: true };
        }
        const failure = describeResendFailure(result || {});
        this.error = tr(failure.key);
        if (failure.next === 'password') this.twoFactor = null;
        return { success: false, reason: failure.reason, next: failure.next };
      } catch (error) {
        const failure = describeResendFailure(isNetworkFailure(error) ? { network: networkKind(error) } : {});
        if (!isNetworkFailure(error)) captureException(error, { tags: { action: 'resendTwoFactorEmail' } });
        this.error = tr(failure.key);
        return { success: false, reason: failure.reason, next: 'stay' };
      } finally {
        this.twoFactorResending = false;
      }
    },

    /** "Back to sign-in": drop the code step. */
    cancelTwoFactor() {
      this.twoFactor = null;
      this.error = null;
    },

    /**
     * Hydrate session state from a JWT + user object obtained out-of-band
     * (e.g. via the SSO custom-protocol callback). Mirrors the post-success
     * branch of login() so downstream stores see identical state.
     */
    async loginWithSSO({ token, user: rawUser }, ticket) {
      const user = token ? sanitizeSsoUser(rawUser, token) : null;
      if (!token || !user) {
        this.error = tr('ssoFailed');
        return { success: false, error: this.error };
      }
      try {
        if (!(await this._applySignIn({ token, user }, ticket, 'sso'))) {
          return { success: false, ignored: true, reason: 'session_changed' };
        }
        this._afterSSOSession(user, token);
        await this._reloadDevicesAfterSSO();
        resumeMobileUploadQueue(this);
        addBreadcrumb({ category: 'auth', message: 'SSO login successful', level: 'info' });
        return { success: true };
      } catch (error) {
        captureException(error, { tags: { action: 'loginWithSSO' } });
        this.error = tr('ssoFailed');
        return { success: false, error: this.error };
      }
    },

    _afterSSOSession(user, token) {
      setUser(user);
      this.startTokenRefresh();
      refreshMinutesInBackground(token);
    },

    async _reloadDevicesAfterSSO() {
      try {
        const { useDeviceStore } = await import('./device');
        await useDeviceStore().reloadForUser();
      } catch (e) {
        console.warn('Device store reload after SSO login failed:', e);
      }
    },

    /**
     * Desktop: main applied the SSO session (or holds an error result of the
     * current epoch). Mirror main's session - only the one of this result's
     * epoch, never a later or earlier one.
     */
    async _adoptDesktopSSO(payload) {
      let session = null;
      try { session = await window.electronAPI.auth.currentSession(); } catch { session = null; }
      if (!session || session.signedOut || session.epoch !== payload.epoch || !session.token || !session.user) return false;
      if (this.isAuthenticated || session.epoch < this._epoch) return false;
      this._epoch = session.epoch;
      this.user = session.user;
      this.token = session.token;
      this.isAuthenticated = true;
      this.error = null;
      this.twoFactor = null;
      this._afterSSOSession(session.user, session.token);
      await this._reloadDevicesAfterSSO();
      return true;
    },

    /** An SSO flow was started in the browser (shows the spinner on the login page). */
    beginSSO(provider) {
      this.error = null;
      this.ssoProvider = provider === 'google' ? 'google' : 'microsoft';
      addBreadcrumb({ category: 'sso', message: `SSO started provider=${this.ssoProvider}`, level: 'info' });
    },

    /** The user gave up waiting for the browser (the result is still accepted if it arrives). */
    abandonSSO() {
      this.ssoProvider = null;
    },

    /**
     * Handle one SSO callback result ({ token, user } | { error, code }),
     * wherever the app currently is. Called by the app-wide SSO handler
     * (boot/sso.js), never by a page: a result that arrived while the login
     * page was not mounted (cold start, Register page open, a late 2FA
     * completion after the wait timed out) used to be dropped.
     * @returns {Promise<{ success: boolean, cancelled?: boolean, reason?: string }>}
     */
    async completeSSO(payload) {
      // An ignored result has no side effect at all (no store change, see
      // boot/sso.js): nothing below the two checks runs for it.
      // Never switch or touch a signed-in session (see boot/sso.js).
      if (this.isAuthenticated) {
        addBreadcrumb({ category: 'sso', message: 'SSO result ignored: already signed in', level: 'warning' });
        return { success: false, ignored: true, reason: 'already_signed_in' };
      }
      // SECURITY: only a result of a sign-in this app started is applied,
      // and only through the session authority with the ticket (epoch) of
      // that sign-in: a crafted suissenotes://auth/callback link (web page,
      // message, QR code, another app) is dropped without a trace in the UI;
      // a sign-in in progress keeps waiting for its real result. A sign-in or
      // sign-out that happened meanwhile wins: the result is dropped with no
      // side effect (E3).
      const dropped = (reason) => {
        addBreadcrumb({ category: 'sso', message: `SSO result ignored: ${reason}`, level: 'warning' });
        return { success: false, ignored: true, reason };
      };

      let ticket = null;
      if (isElectron()) {
        // Main bound the result to its flow and applied it (sso-flow.js);
        // the renderer never applies a token from a payload.
        if (!payload || payload.bound !== true) return dropped('unbound_result');
        if (payload.applied !== true && !payload.error && !payload.code) return dropped('not_applied');
      } else if (isCapacitor()) {
        const { consumeSsoFlow, endSsoFlowLocally } = await import('../services/ssoFlow');
        if (payload && payload.local === true && !payload.token && !payload.authCode) {
          // The in-app browser this app opened ended without a callback URL:
          // not a result (it can never sign in), it only ends the flow.
          if (!endSsoFlowLocally()) return dropped('no_pending_flow');
        } else {
          const binding = consumeSsoFlow(payload);
          if (!binding.ok) {
            if (binding.reason === 'missing_state') countMissingState();
            return dropped(binding.reason);
          }
          ticket = { epoch: binding.epoch };
          if (payload && !payload.error && !payload.code && payload.authCode) {
            let exchanged = null;
            try {
              exchanged = await exchangeSsoCode(payload.authCode, binding.verifier, payload.state);
            } catch (error) {
              if (!isNetworkFailure(error)) captureException(error, { tags: { action: 'ssoExchange' } });
            }
            payload = exchanged || { error: 'invalid_callback' };
          }
          if (this.isAuthenticated || !isCurrentTicket(ticket)) return dropped('session_changed');
        }
      } else {
        return dropped('unsupported_platform');
      }

      const provider = this.ssoProvider || 'unknown';
      const seq = this.ssoOutcome.seq + 1;

      if (isElectron() && payload.applied === true) {
        if (!(await this._adoptDesktopSSO(payload))) return dropped('session_changed');
        this.ssoProvider = null;
        resumeMobileUploadQueue(this);
        addBreadcrumb({ category: 'auth', message: 'SSO login successful', level: 'info' });
        this.ssoOutcome = { seq, success: true, cancelled: false, reason: null };
        return { success: true, reason: null };
      }

      if (!payload || payload.error || payload.code || !payload.token) {
        this.ssoProvider = null;
        const outcome = classifySsoError(payload && (payload.error || payload.code)
          ? payload
          : { error: 'invalid_callback' });
        addBreadcrumb({ category: 'sso', message: `SSO result: ${outcome.cancelled ? 'cancelled' : 'failed'} reason=${outcome.reason}`, level: 'info' });
        if (outcome.cancelled) {
          this.error = null;
        } else {
          this.error = tr(outcome.key);
          // Only codes and the provider: no user data, no raw IdP text.
          captureMessage(`auth: SSO sign-in failed (${outcome.reason})`, 'warning', {
            fingerprint: ['sso-sign-in-failed', outcome.reason],
            tags: { sso_reason: outcome.reason, sso_provider: provider }
          });
        }
        this.ssoOutcome = { seq, success: false, cancelled: outcome.cancelled, reason: outcome.reason };
        return { success: false, cancelled: outcome.cancelled, reason: outcome.reason };
      }

      const result = await this.loginWithSSO(payload, ticket);
      if (result.ignored) return dropped(result.reason);
      this.ssoProvider = null;
      if (!result.success) {
        captureMessage('auth: SSO sign-in could not be stored (session_failed)', 'warning', {
          fingerprint: ['sso-sign-in-failed', 'session_failed'],
          tags: { sso_reason: 'session_failed', sso_provider: provider }
        });
      }
      this.ssoOutcome = { seq, success: result.success, cancelled: false, reason: result.success ? null : 'session_failed' };
      return { success: result.success, reason: result.success ? null : 'session_failed' };
    },

    async register(email, password, name) {
      this.loading = true;
      this.error = null;
      const ticket = signInTicket();

      try {
        const result = await platformRegister(email, password, name);

        if (result.ignored) {
          return { success: false, ignored: true, reason: result.reason || 'session_changed' };
        } else if (result.success) {
          if (!(await this._applySignIn(result, ticket, 'login'))) {
            return { success: false, ignored: true, reason: 'session_changed' };
          }

          setUser(result.user);

          // Start periodic token refresh
          this.startTokenRefresh();
          refreshMinutesInBackground(result.token);

          // Reload device store for this new user
          try {
            const { useDeviceStore } = await import('./device');
            const deviceStore = useDeviceStore();
            await deviceStore.reloadForUser();
          } catch (e) {
            console.warn('Device store reload after register failed:', e);
          }

          // P1 Fix: Resume any pending uploads after registration
          resumeMobileUploadQueue(this);

          return { success: true };
        } else {
          const failure = describeRegisterFailure(result);
          this.error = tr(failure.key);
          // A refusal the customer can fix (account exists, invalid input) is
          // not a bug; everything else (server, network, unknown) is reported
          // so a stuck sign-up is visible without a customer complaint. On
          // desktop the main process logs it (log.warn -> Sentry) already.
          if (!isElectron() && !['registerAccountExists', 'registerEmailInvalid', 'registerPasswordTooShort', 'registerMissingFields', 'authTooManyAttempts'].includes(failure.key)) {
            captureMessage(`auth: registration failed (${failure.reason})`, 'warning', {
              fingerprint: ['registration-failed', failure.reason],
              tags: { register_reason: failure.reason }
            });
          }
          return { success: false, error: this.error, reason: failure.reason };
        }
      } catch (error) {
        captureException(error, { tags: { action: 'register' } });
        this.error = tr('registerFailedGeneric');
        return { success: false, error: this.error, reason: 'exception' };
      } finally {
        this.loading = false;
      }
    },

    /**
     * Sign out (E5): 1-3 by the session authority first - tombstone with a
     * new epoch and RAM lock, requests aborted, token, user, SSO flow and
     * buffer deleted - then 4. the BLE clean-up (no token is readable any
     * more; the user object stays until it is done). A sign-out that could
     * not be confirmed is reported to the user; the lock stays and every
     * start deletes again.
     * @returns {Promise<{ success: boolean }>}
     */
    async logout() {
      // RAM lock in this store before anything is awaited.
      this.token = null;
      this.isAuthenticated = false;
      this.twoFactor = null;
      this.ssoProvider = null;
      this._refreshPromise = null;
      this.stopTokenRefresh();

      const signOut = await platformSignOut();
      if (Number.isSafeInteger(signOut?.epoch)) this._epoch = Math.max(this._epoch, signOut.epoch);

      // BLE: disconnect and clear device state while user.id is still set
      // (user-scoped pairing keys).
      try {
        const { useDeviceStore } = await import('./device');
        const deviceStore = useDeviceStore();
        await deviceStore.onLogout();
      } catch (error) {
        console.warn('Error cleaning up device store on logout:', error);
      }

      // Clear history store to prevent data leaks between users
      // Using dynamic import to avoid circular dependency
      const { useRecordingsHistoryStore } = await import('./recordings-history');
      const historyStore = useRecordingsHistoryStore();
      historyStore.reset();

      // Reset minutes store (stops its auto-refresh timer)
      const { useMinutesStore } = await import('./minutes');
      const minutesStore = useMinutesStore();
      minutesStore.reset();

      // Custom vocabulary belongs to this account — the next one loads its own.
      const { useTranscriptionSettingsStore } = await import('./transcription-settings');
      useTranscriptionSettingsStore().reset();

      // Clear Sentry user context
      setUser(null);

      this.user = null;
      this.error = null;
      if (!signOut?.success) {
        // Visible: the login page shows it. Codes only.
        this.error = tr('signOutIncomplete');
        captureMessage('auth: sign-out incomplete', 'warning', { fingerprint: ['sign-out-incomplete'] });
      }
      return { success: !!signOut?.success };
    },

    /**
     * Force logout with event dispatch for MainLayout navigation.
     * @param {string} message - Reason for force logout
     */
    async forceLogout(message) {
      await this.logout();
      window.dispatchEvent(new CustomEvent('auth:forceLogout', {
        detail: { message: message || 'Session expired' }
      }));
    },

    async checkSession() {
      try {
        // The session authority purges legacy copies and honours the
        // tombstone: after a sign-out (even a failed one) nothing is restored.
        const session = await platformRestoreSession();
        if (session?.mismatch) await platformSignOut();
        if (!session || session.signedOut || !session.token || !session.user || Object.keys(session.user).length === 0) {
          this.isAuthenticated = false;
          return;
        }
        const { token, user: userInfo } = session;

        // Never restore a session the server would reject: a blind restore
        // shows a "logged in" UI on a dead token, lets the user record, and
        // only fails at upload time — after the meeting is over.
        const tokenState = getTokenState(token);

        if (tokenState === 'dead') {
          console.warn('Stored token expired beyond refresh grace - requiring re-login');
          await platformSignOut();
          this.isAuthenticated = false;
          return;
        }

        this._epoch = session.epoch;
        this.token = token;
        this.user = userInfo;
        this.isAuthenticated = true;

        if (tokenState === 'grace') {
          // Expired but revivable — settle it NOW, before any UI claims a
          // working session. A definitive rejection means re-login; a
          // network failure keeps the session (offline use stays possible).
          const refresh = await this._doTokenRefresh();
          if (!refresh.success && refresh.authRejected) {
            console.warn('Stored token rejected by refresh - requiring re-login');
            this.user = null;
            this.token = null;
            this.isAuthenticated = false;
            await platformSignOut();
            return;
          }
        } else if (tokenState === 'stale') {
          // Still valid — refresh in the background to restore full lifetime
          this._doTokenRefresh().catch(() => {});
        }

        // Set Sentry user context on session restore
        setUser(userInfo);

        // Reload device store for this user (user-scoped BLE pairings)
        try {
          const { useDeviceStore } = await import('./device');
          const deviceStore = useDeviceStore();
          await deviceStore.reloadForUser();
        } catch (e) {
          console.warn('Device store reload after session restore failed:', e);
        }

        // Start periodic token refresh
        this.startTokenRefresh();
      } catch (error) {
        console.error('Error checking session:', error);
        this.isAuthenticated = false;
      } finally {
        this.sessionChecked = true;
      }
    },

    /**
     * True when the stored token is near or past expiry (but maybe still
     * revivable). upload.js probes for this before processing the mobile
     * queue to refresh proactively after long offline periods.
     */
    isTokenExpiringSoon() {
      const state = getTokenState(this.token);
      return state === 'stale' || state === 'grace';
    },

    /**
     * Gate for starting a recording: the session must be one the upload at
     * the END of the recording will accept. Starts long recordings on a
     * fresh 7-day token; blocks only on a definitive server rejection —
     * a network failure never blocks (offline capture stays local and the
     * persistent upload queue retries after reconnect/login).
     * @returns {{ ok: boolean, reason?: string, degraded?: boolean }}
     */
    async ensureRecordingSession() {
      if (!this.isAuthenticated || !this.token) {
        return { ok: false, reason: 'loggedOut' };
      }
      if (!(this.user?.id || this.user?.userId)) {
        // Without a user id the history entry for the recording cannot be
        // written (userId ownership guard) — the capture would be invisible.
        return { ok: false, reason: 'loggedOut' };
      }

      const state = getTokenState(this.token);
      if (state === 'dead') {
        await this.forceLogout('Your session has expired. Please log in again.');
        return { ok: false, reason: 'sessionExpired' };
      }
      if (state === 'active') {
        return { ok: true };
      }

      // 'stale' or 'grace': renew now so even a many-hour recording ends on
      // a token with days of lifetime left.
      const refresh = await this.handleAuthError();
      if (refresh.success) {
        return { ok: true };
      }
      if (refresh.shouldLogout) {
        return { ok: false, reason: 'sessionExpired' };
      }
      // Transient refresh failure with a token that is at worst in grace:
      // allow the recording (local-first) rather than punishing offline use.
      return { ok: true, degraded: true };
    },

    /**
     * Handle 401/auth errors — refresh token or force logout.
     * Deduplicates concurrent calls via _refreshPromise mutex.
     * Called from minutes store, upload service, RecordPage, HistoryPage, UploadPage.
     * @returns {{ success: boolean, token?: string, shouldLogout?: boolean }}
     */
    async handleAuthError() {
      // If a refresh is already in flight, return the same promise
      if (this._refreshPromise) {
        return this._refreshPromise;
      }

      this._refreshPromise = this._doTokenRefresh()
        .then((result) => {
          this._refreshPromise = null;
          if (result.success) {
            return { success: true, token: result.token };
          }
          if (result.authRejected) {
            // The server definitively rejected the session — force logout
            this.forceLogout('Your session has expired. Please log in again.');
            return { success: false, shouldLogout: true };
          }
          // Transient failure (network/server blip): keep the session — the
          // caller's retry/queue machinery owns the failed request. Logging
          // the user out here used to wipe in-memory history state mid-flow
          // and orphan the recording being uploaded.
          return { success: false, shouldLogout: false, transient: true };
        })
        .catch((err) => {
          this._refreshPromise = null;
          console.error('Token refresh error:', err);
          return { success: false, shouldLogout: false, transient: true };
        });

      return this._refreshPromise;
    },

    /**
     * Internal: perform the actual token refresh via platform-appropriate method.
     * @returns {{ success: boolean, token?: string, user?: object }}
     */
    async _doTokenRefresh() {
      if (!this.token && !this.isAuthenticated) {
        return { success: false, authRejected: true };
      }
      // E3: a refresh applies only in the session it started in, and only
      // for the same user.
      const epochAtStart = this._epoch;
      const userIdAtStart = decodeJwtUserId(this.token);
      const ticket = signInTicket({ userId: userIdAtStart });

      try {
        let result;

        if (isElectron()) {
          // Electron: main refreshes and applies it (session authority).
          result = await window.electronAPI.auth.refreshToken();
          if (result?.ignored) return { success: false };
          if (!result?.success) {
            // Distinguish a definitive rejection (expired beyond grace,
            // disabled account, no stored token) from a transient failure so
            // callers don't force-logout on a network blip.
            const authRejected = result?.status === 401 || result?.status === 403 ||
              /not authenticated/i.test(result?.error || '');
            return { success: false, authRejected };
          }
          if (!this.isAuthenticated || this._epoch !== epochAtStart || result.epoch !== this._epoch) return { success: false };
        } else {
          // Mobile / web: direct fetch
          const response = await authenticatedRequest(API_ENDPOINTS.refreshToken, this.token, {
            method: 'POST'
          });
          if (!response.ok) {
            return { success: false, authRejected: response.status === 401 || response.status === 403 };
          }
          const data = await parseJsonSafe(response);
          if (!data.token) return { success: false }; // non-JSON / unexpected body — transient
          const applied = await applyMobileSession(ticket, { token: data.token, user: data.user }, { kind: 'refresh' });
          if (!applied.applied || !isCurrentTicket(ticket) || !this.isAuthenticated) return { success: false };
          result = { success: true, token: data.token, user: data.user };
        }

        if (result.success && result.token) {
          // Synchronous: the state follows the authority's session.
          this.token = result.token;
          if (result.user && String(result.user.id ?? '') === String(userIdAtStart ?? '')) this.user = result.user;

          addBreadcrumb({ category: 'auth', message: 'Token refreshed successfully', level: 'info' });

          // P1 Fix: Resume uploads that may have failed with expired token
          resumeMobileUploadQueue(this);

          return { success: true, token: result.token };
        }

        return { success: false };
      } catch (error) {
        console.warn('Token refresh failed:', error);
        return { success: false };
      }
    },

    /**
     * Start periodic token refresh (every 6 hours).
     * Silent — does not force logout on failure (next API call will handle that).
     */
    startTokenRefresh() {
      this.stopTokenRefresh();
      this._tokenRefreshInterval = setInterval(() => {
        if (this.isAuthenticated) {
          this._doTokenRefresh().catch((err) => {
            console.warn('Periodic token refresh failed (will retry):', err);
          });
        }
      }, TOKEN_REFRESH_INTERVAL_MS);
    },

    /**
     * Stop periodic token refresh.
     */
    stopTokenRefresh() {
      if (this._tokenRefreshInterval) {
        clearInterval(this._tokenRefreshInterval);
        this._tokenRefreshInterval = null;
      }
    },

    clearError() {
      this.error = null;
    }
  }
});
