/**
 * Customer-step telemetry: where do people get stuck on the way in?
 *
 * WHY: on 08.10.2026 a prospect tried for 15 minutes to register and nothing
 * ever reached the server - the button was silently disabled. Screens where a
 * customer can get stuck now report each step to the backend
 * (POST /api/telemetry/customer-step, JSON, no auth, always 204):
 *   view     - the screen was opened
 *   blocked  - a click was refused by validation (`fields` says which)
 *   sent     - the request went out
 *   rejected - the server or network refused it (`reason`)
 *   done     - success
 *   left     - the screen was left after typing or a failed attempt, without success
 *
 * Privacy: the payload only ever contains programmer-defined words (flow,
 * event, field names and problem kinds, reason codes) and a random id per
 * screen visit. Never user input, never an e-mail, never a token. Every value
 * is checked against the contract's patterns and dropped when it does not
 * match.
 *
 * Best effort: sending never throws, never blocks the UI and never logs to the
 * console (console.warn/error would become Sentry events).
 */

import { getApiUrl } from './api';

export const TELEMETRY_PATH = '/api/telemetry/customer-step';
export const TELEMETRY_FLOWS = Object.freeze(['signup', 'login', 'password-reset', 'onboarding', 'checkout', 'upload']);
export const TELEMETRY_EVENTS = Object.freeze(['view', 'blocked', 'sent', 'rejected', 'left', 'done']);

const SID_RE = /^[a-z0-9]{6,24}$/;
const REASON_RE = /^[A-Za-z0-9_]{1,40}$/;
// "field:kind", both programmer-defined identifiers (e.g. "email:missing").
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}:[a-z][a-z0-9_]{0,30}$/;
const MAX_FIELDS = 10;
const SID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random id for one screen visit, /^[a-z0-9]{6,24}$/. */
export function newStepSid(length = 16, random = Math.random) {
  let sid = '';
  try {
    if (random === Math.random && typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      for (const b of bytes) sid += SID_ALPHABET[b % SID_ALPHABET.length];
      return sid;
    }
  } catch { /* fall back below */ }
  for (let i = 0; i < length; i++) sid += SID_ALPHABET[Math.floor(random() * SID_ALPHABET.length) % SID_ALPHABET.length];
  return sid;
}

/**
 * Validated contract payload, or null when flow/event/sid are invalid.
 * Optional parts that do not match the contract are left out, never sent.
 */
export function buildStepPayload({ flow, event, sid, attempts, fields, reason } = {}) {
  if (!TELEMETRY_FLOWS.includes(flow) || !TELEMETRY_EVENTS.includes(event) || !SID_RE.test(String(sid || ''))) {
    return null;
  }
  const payload = { flow, event, sid };
  if (Number.isInteger(attempts) && attempts >= 0 && attempts <= 1000) payload.attempts = attempts;
  if (Array.isArray(fields)) {
    const clean = [...new Set(fields.filter(f => typeof f === 'string' && FIELD_RE.test(f)))].slice(0, MAX_FIELDS);
    if (clean.length) payload.fields = clean;
  }
  if (typeof reason === 'string' && REASON_RE.test(reason)) payload.reason = reason;
  return payload;
}

/**
 * Fire-and-forget POST of one step to the configured API base URL.
 * @returns {Promise<boolean>} whether the request was handed to the network
 */
export async function sendCustomerStep(payload, { fetchImpl, baseUrl } = {}) {
  if (!payload) return false;
  try {
    const base = baseUrl || await getApiUrl();
    const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!base || !doFetch) return false;
    const request = doFetch(`${base}${TELEMETRY_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // Survives the page/route change that a "left" or "done" step races with.
      keepalive: true,
      credentials: 'omit'
    });
    Promise.resolve(request).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Step tracker for one visit of one screen. Pure state machine around an
 * injectable sender, so it is unit-testable and the screens stay small.
 * @param {string} flow - one of TELEMETRY_FLOWS
 * @param {{ send?: Function, sid?: string }} [options]
 */
export function createStepTracker(flow, { send = sendCustomerStep, sid = newStepSid() } = {}) {
  const state = { attempts: 0, typed: false, troubled: false, finished: false, viewed: false, left: false };
  const emit = (event, extra = {}) => {
    const payload = buildStepPayload({ flow, event, sid, ...extra });
    if (!payload) return null;
    try { Promise.resolve(send(payload)).catch(() => {}); } catch { /* best effort */ }
    return payload;
  };

  return {
    sid,
    get attempts() { return state.attempts; },
    view() {
      if (state.viewed) return null;
      state.viewed = true;
      return emit('view');
    },
    /** The user typed into a field (makes a later departure a "left"). */
    noteInput() { state.typed = true; },
    /** A submit click refused by validation. */
    blocked(fields = []) {
      state.attempts += 1;
      state.troubled = true;
      return emit('blocked', { attempts: state.attempts, fields });
    },
    /** The request went out. `reason` distinguishes variants (e.g. sso_google). */
    sent(reason) {
      state.attempts += 1;
      return emit('sent', { attempts: state.attempts, reason });
    },
    rejected(reason) {
      state.troubled = true;
      return emit('rejected', { attempts: state.attempts, reason });
    },
    done() {
      if (state.finished) return null;
      state.finished = true;
      return emit('done', { attempts: state.attempts });
    },
    /** Screen left: reported only after typing or a refused attempt, and never after success. */
    left() {
      if (state.finished || state.left || !(state.typed || state.troubled)) return null;
      state.left = true;
      return emit('left', { attempts: state.attempts });
    }
  };
}
