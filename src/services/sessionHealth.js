/**
 * Unclean-exit detector — the part of "capture every error" the JavaScript
 * SDK cannot see on its own: a native crash, a WebView termination, an
 * out-of-memory kill or a watchdog kill (hang) while the app was on screen.
 *
 * The app persists "foreground" when it becomes active and "background" when
 * it leaves the screen. If a launch finds the previous session still marked
 * "foreground", that session died on screen and is reported once (see
 * evaluatePreviousSession). Native stack traces for those crashes are in Play
 * Console (Android vitals) and App Store Connect (TestFlight crashes / Xcode
 * Organizer).
 *
 * Storage: Capacitor Preferences (UserDefaults / SharedPreferences — survives
 * a crash of the app process) with localStorage as the fallback.
 */
import { evaluatePreviousSession } from '../utils/sentryCapture';

const KEY = 'suisse_session_health_v1';
const HEARTBEAT_MS = 60_000;

let current = null;
let heartbeat = null;
let saveTimer = null;

async function preferences() {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    return Preferences;
  } catch {
    return null;
  }
}

async function load() {
  const prefs = await preferences();
  try {
    if (prefs) {
      const { value } = await prefs.get({ key: KEY });
      if (value) return JSON.parse(value);
    }
  } catch { /* fall back to localStorage */ }
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function save() {
  if (!current) return;
  const value = JSON.stringify(current);
  try { localStorage.setItem(KEY, value); } catch { /* storage unavailable */ }
  const prefs = await preferences();
  try { if (prefs) await prefs.set({ key: KEY, value }); } catch { /* bridge unavailable */ }
}

/**
 * Read the previous session's verdict, then start tracking this session.
 * @param {object} opts
 * @param {string} opts.appVersion
 * @param {string} opts.platform
 * @param {boolean} [opts.isActive]  app state at launch
 * @param {(report: object) => void} [opts.report]  called once when the previous session died on screen
 */
export async function startSessionHealth({ appVersion, platform, isActive = true, report } = {}) {
  const previous = await load();
  const now = Date.now();
  const verdict = evaluatePreviousSession(previous, now);
  current = {
    v: 1,
    state: isActive ? 'foreground' : 'background',
    appVersion: appVersion || 'unknown',
    platform: platform || 'unknown',
    startedAt: now,
    lastSeenAt: now,
    route: null,
    recording: false,
    bleSync: false
  };
  await save();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    if (current?.state === 'foreground') {
      current.lastSeenAt = Date.now();
      save();
    }
  }, HEARTBEAT_MS);
  if (verdict && typeof report === 'function') {
    try { report(verdict); } catch { /* reporting must never break the boot */ }
  }
  return verdict;
}

/** App became active (true) or left the screen (false). Persisted immediately. */
export function markSessionState(isActive) {
  if (!current) return Promise.resolve();
  current.state = isActive ? 'foreground' : 'background';
  current.lastSeenAt = Date.now();
  return save();
}

/** Remember what the app was doing (route, recording, BLE sync) for the crash report. */
export function noteSessionActivity(patch) {
  if (!current || !patch) return;
  Object.assign(current, patch);
  current.lastSeenAt = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; save(); }, 1000);
}

/** Test hook. */
export function _resetSessionHealthForTests() {
  if (heartbeat) clearInterval(heartbeat);
  if (saveTimer) clearTimeout(saveTimer);
  heartbeat = null;
  saveTimer = null;
  current = null;
}
