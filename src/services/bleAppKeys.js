/**
 * Bluetooth pairing keys of this app installation.
 *
 * The recorder binds exactly one "app UUID" (protocol §1) and afterwards only
 * talks to an app that presents it. That value is a bearer secret.
 *
 * Until 3.9.42 a fresh install used a UUID DERIVED from the user id with a
 * constant that is public in this repository — anyone who knew a user id
 * could compute it. New pairings now use a random per-install secret from
 * the platform CSPRNG, kept in the platform keystore (secure storage), never
 * in plain preferences.
 *
 * Backward compatibility (no silent re-binding):
 * - `legacy`: the install UUID earlier versions stored in plain Preferences
 *   (random, scoped-migrated or user-derived). It is moved once into secure
 *   storage and the plaintext copy is removed. A paired-device record written
 *   before this version (no `keyKind`) keeps using it, so already-paired
 *   recorders keep working without any user action.
 * - `legacyScoped`: the per-user UUID of the 2025 migration period; offered
 *   only to the same, pinned recorder.
 * - `derived`: computable from the user id, therefore not secret. It is only
 *   offered during a pairing the user started, so a recorder bound by an
 *   earlier install of the same user can still be re-paired after a
 *   reinstall, and the record remembers `keyKind: 'derived'`.
 * A record moves to the random key only when the user forgets the recorder
 * and pairs it again (the recorder must release the old binding first).
 */

import { v5 as uuidv5 } from 'uuid';
import * as secure from './secureStorage';
import { randomUuid } from '../utils/deviceFileSafety';

const PREF_APP_UUID = 'ble_app_uuid';
const SECURE_INSTALL_KEY = 'ble.appKey.install';
const SECURE_LEGACY_KEY = 'ble.appKey.legacy';
// Keystore keys must match ^[A-Za-z0-9_.-]{1,128}$ (both native plugins
// reject anything else with INVALID_KEY), so the user id is mapped to a
// name-based UUID (synchronous SHA-1, only a storage key - not a secret).
export function secureScopedKey(userId) {
  return `ble.appKey.legacyScoped.${uuidv5(`ble-scoped-key|${userId}`, APP_UUID_NAMESPACE)}`;
}

const APP_UUID_NAMESPACE = '0c1f7a2e-9b6d-4e3a-8c5f-2d7e4b1a9c63';

/** The pre-3.9.43 user-derived app UUID (public: depends only on the user id). */
export function userAppUuid(userId) {
  if (!userId) return null;
  return uuidv5(`suisse-meets-ble-app|${userId}`, APP_UUID_NAMESPACE);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid = (v) => typeof v === 'string' && UUID_RE.test(v);

function secureApi() {
  if (typeof secure.readSecureItem !== 'function' || typeof secure.setSecureItem !== 'function') {
    const err = new Error('Secure storage is not available');
    err.code = 'BLE_SECRET_STORE_UNAVAILABLE';
    throw err;
  }
  return secure;
}

/**
 * Read a pairing key. A read FAILURE is not a missing key (T6): it throws,
 * so nothing is generated or overwritten and the next attempt reads again.
 */
async function readSecure(api, key) {
  const res = await api.readSecureItem(key);
  if (!res || !res.ok) {
    const err = new Error('Could not read the pairing key; try again');
    err.code = 'BLE_SECRET_STORE_UNAVAILABLE';
    throw err;
  }
  return res.value;
}

async function storeSecure(api, key, value) {
  const res = await api.setSecureItem(key, value);
  return !!(res && res.success);
}

/**
 * Load (and on first use migrate/create) the pairing keys.
 * @param {{ userId?: string|number|null, isNative: boolean }} opts
 * @returns {Promise<{ install: string, legacy: string|null, legacyScoped: string|null }>}
 */
export async function loadAppKeys({ userId = null, isNative }) {
  if (!isNative) {
    // Browser / desktop dev build: no recorder support; keep a random value.
    let v = typeof localStorage !== 'undefined' ? localStorage.getItem(PREF_APP_UUID) : null;
    if (!valid(v)) {
      v = randomUuid();
      try { localStorage.setItem(PREF_APP_UUID, v); } catch { /* ignore */ }
    }
    return { install: v, legacy: null, legacyScoped: null };
  }

  const api = secureApi();
  // T6: pairing keys are only migrated, never lost - every read must succeed
  // before anything is written (a failed read throws here).
  let install = await readSecure(api, SECURE_INSTALL_KEY);
  let legacy = await readSecure(api, SECURE_LEGACY_KEY);
  const scopedKey = userId ? secureScopedKey(userId) : null;
  let legacyScoped = scopedKey ? await readSecure(api, scopedKey) : null;

  // One-time migration of the plaintext values from Preferences.
  const { Preferences } = await import('@capacitor/preferences');
  const plainKeys = [PREF_APP_UUID];
  if (userId) plainKeys.push(`${PREF_APP_UUID}:u${userId}`);
  const plain = {};
  for (const key of plainKeys) {
    const { value } = await Preferences.get({ key });
    if (value) plain[key] = value;
  }
  const plainInstall = plain[PREF_APP_UUID];
  const plainScoped = userId ? plain[`${PREF_APP_UUID}:u${userId}`] : null;
  let migrated = true;
  if (!legacy && valid(plainInstall)) {
    if (await storeSecure(api, SECURE_LEGACY_KEY, plainInstall)) legacy = plainInstall;
    else migrated = false;
  }
  if (!legacy && !plainInstall && valid(plainScoped)) {
    // The migration-period code adopted the scoped UUID as install UUID on
    // the next start; an install that never got there used the scoped one.
    if (await storeSecure(api, SECURE_LEGACY_KEY, plainScoped)) legacy = plainScoped;
    else migrated = false;
  }
  if (userId && !legacyScoped && valid(plainScoped) && plainScoped !== legacy) {
    if (await storeSecure(api, scopedKey, plainScoped)) legacyScoped = plainScoped;
    else migrated = false;
  }
  if (migrated) {
    for (const key of Object.keys(plain)) {
      try { await Preferences.remove({ key }); } catch { /* retried next start */ }
    }
  }

  if (!valid(install)) {
    install = randomUuid();
    if (!(await storeSecure(api, SECURE_INSTALL_KEY, install))) {
      const err = new Error('Could not store the pairing key securely');
      err.code = 'BLE_SECRET_STORE_FAILED';
      throw err;
    }
  }
  return { install, legacy: valid(legacy) ? legacy : null, legacyScoped: valid(legacyScoped) ? legacyScoped : null };
}

/**
 * Which key a paired-device record uses. Records written before this
 * version have no keyKind and were bound with the legacy install UUID.
 * @returns {string|null}
 */
export function keyForRecord(record, keys, userId) {
  const kind = record?.keyKind || (keys.legacy ? 'legacy' : 'install');
  switch (kind) {
    case 'install': return keys.install;
    case 'legacy': return keys.legacy || keys.install;
    case 'legacyScoped': return keys.legacyScoped;
    case 'derived': return userAppUuid(userId);
    default: return null;
  }
}
