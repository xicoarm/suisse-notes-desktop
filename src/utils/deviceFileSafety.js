/**
 * Safety rules for data that comes from a Bluetooth recorder.
 *
 * Everything the recorder reports (file names, sizes, counts) is untrusted:
 * a device in radio range that the app connects to can claim any value.
 *
 * - The recorder's file name is never part of a local path. The local copy is
 *   stored under a generated UUID; the device name is kept as display
 *   metadata and is only sent back to the recorder as the download argument,
 *   and only when it matches the recorder's naming scheme.
 * - Every local path the app writes or deletes on mobile is a relative path
 *   below one of the app's own storage roots (no "..", no absolute path, no
 *   backslash, no control character, no percent-encoding).
 * - Transfers and lists have hard limits so a misbehaving device cannot make
 *   the app collect data without end.
 */

// The recorder names its files R<yyyymmdd>-<hhmmss>.<ext>.
export const DEVICE_FILENAME_RE = /^R\d{8}-\d{6}\.(opus|wav)$/;
export const DEVICE_FILENAME_MAX = 32;

// Size limits. The recorder writes Opus (~6 MB per hour) or WAV (16 kHz /
// 16 bit mono, ~115-130 MB per hour). A transfer is collected in memory and
// then written once (plus a base64 copy for the file plugin), so anything
// near 1 GB could not be processed on a phone anyway; 1 GiB = ~8 h of WAV or
// far more than a day of Opus.
export const MAX_DEVICE_FILE_BYTES = 1024 * 1024 * 1024;
// Upper bound on the entries of one file list (the recorder's FileNum).
export const MAX_DEVICE_FILE_COUNT = 20000;
// A file list must arrive within this time in total.
export const LIST_TIME_BUDGET_MS = 10 * 60 * 1000;
// Minimum throughput a running transfer must keep: the per-file time budget
// is size / MIN_TRANSFER_BYTES_PER_SEC plus a fixed allowance.
export const MIN_TRANSFER_BYTES_PER_SEC = 1024;
export const TRANSFER_BASE_BUDGET_MS = 5 * 60 * 1000;

// Local roots the mobile app stores recordings in (relative to the base
// directory chosen by the storage service).
export const LOCAL_STORAGE_ROOTS = ['recordings', 'suissenotes_recordings'];
export const DEVICE_FILES_ROOT = 'suissenotes_recordings';

/**
 * True when `name` is a recorder file name the app may process.
 * @param {unknown} name
 */
export function isSafeDeviceFilename(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= DEVICE_FILENAME_MAX
    && DEVICE_FILENAME_RE.test(name);
}

/**
 * Display form of any device-reported name: printable ASCII letters, digits,
 * dot, dash and underscore only, at most 64 characters. Never used as a path.
 * @param {unknown} name
 */
export function sanitizeDisplayName(name) {
  const s = typeof name === 'string' ? name : String(name ?? '');
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return cleaned || '_';
}

/**
 * Turn one raw device list entry into a typed entry. Unknown fields are
 * dropped. An entry whose name does not match the recorder's scheme, or whose
 * size is outside (0, MAX_DEVICE_FILE_BYTES], is marked `unsafe` and keeps
 * only a sanitized display name — it is never downloaded.
 * @param {object} raw
 * @returns {{ file: string, size: number, creat_time: number, duration_ms: number, unsafe?: true, unsafeReason?: string }}
 */
export function normalizeDeviceFileEntry(raw) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const entry = {
    file: '',
    size: num(raw?.size),
    creat_time: num(raw?.creat_time),
    duration_ms: num(raw?.duration_ms)
  };
  if (!isSafeDeviceFilename(raw?.file)) {
    entry.file = sanitizeDisplayName(raw?.file);
    entry.unsafe = true;
    entry.unsafeReason = 'UNSAFE_FILENAME';
    return entry;
  }
  entry.file = raw.file;
  if (entry.size > MAX_DEVICE_FILE_BYTES || entry.size < 0) {
    entry.unsafe = true;
    entry.unsafeReason = 'UNSAFE_SIZE';
  }
  return entry;
}

/**
 * Local path for a new copy of a device file: a fresh UUID plus the
 * recorder's extension. Throws for names that are not safe.
 * @param {string} deviceFilename
 * @param {() => string} [makeId]
 */
export function localPathForDeviceFile(deviceFilename, makeId = randomId) {
  if (!isSafeDeviceFilename(deviceFilename)) {
    const err = new Error('Device file name cannot be processed safely');
    err.code = 'UNSAFE_FILENAME';
    throw err;
  }
  const ext = DEVICE_FILENAME_RE.exec(deviceFilename)[1];
  const id = makeId();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Generated local file id is not a UUID');
  }
  return `${DEVICE_FILES_ROOT}/${id.toLowerCase()}.${ext}`;
}

/**
 * True when `path` is a canonical relative path below one of the app's
 * storage roots. Rejects absolute paths, drive letters and URL schemes,
 * "." / ".." segments, empty segments, backslashes, control characters and
 * any percent-encoding (so "%2e%2e" cannot be decoded into ".." later).
 * @param {unknown} path
 * @param {string[]} [roots]
 */
export function isConfinedPath(path, roots = LOCAL_STORAGE_ROOTS) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\%:~]/.test(path)) return false;
  if (path.startsWith('/')) return false;
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false;
  return roots.includes(segments[0]);
}

/**
 * Throwing form of isConfinedPath for write/delete call sites.
 * @param {unknown} path
 */
export function assertConfinedPath(path) {
  if (!isConfinedPath(path)) {
    const err = new Error('Path is outside the app storage area');
    err.code = 'PATH_NOT_CONFINED';
    throw err;
  }
  return path;
}

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Random 128-bit value from the platform CSPRNG in UUID format (version and
 * variant bits set, as the recorder expects a UUID string).
 */
export function randomUuid() {
  return randomId();
}
