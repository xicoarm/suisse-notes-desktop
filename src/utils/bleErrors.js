/**
 * Turn raw BLE / recorder-protocol errors into translated, actionable text.
 *
 * The device speaks a binary protocol whose failure strings ("MemoryBusy",
 * "BLE response timeout", "Device rejected pairing (already paired to
 * another app)", "Connection timeout.") used to be shown to users verbatim,
 * in English, inside otherwise translated toasts. Every known failure class
 * maps to an i18n key here; anything unknown falls back to a generic key
 * that still carries the raw message for support.
 */

const RULES = [
  { key: 'bleErrorPairedElsewhere', re: /rejected pairing|already paired|BLE_PAIRED_ELSEWHERE/i },
  { key: 'bleErrorPermission', re: /permission|not authorized|unauthorized|BLE_PERMISSION/i },
  { key: 'bleErrorBluetoothOff', re: /bluetooth is required|bluetooth (is )?(disabled|off)|BLE_DISABLED|requestEnable/i },
  { key: 'bleErrorBusy', re: /MemoryBusy|device busy/i },
  { key: 'bleErrorFull', re: /MemoryFull/i },
  { key: 'bleErrorMemory', re: /MemoryErr|memory card|file system/i },
  { key: 'bleErrorEmptyFile', re: /EMPTY_FILE|file is empty/i },
  { key: 'bleErrorCrcGaveUp', re: /CRC_GAVE_UP/i },
  { key: 'bleErrorCrc', re: /CRC mismatch/i },
  { key: 'bleErrorNotFound', re: /device not found|not located|no device/i },
  { key: 'bleErrorDisconnected', re: /disconnected|not connected|deviceId required|writing descriptor|link lost/i },
  { key: 'bleErrorTimeout', re: /timeout|timed out/i },
];

/**
 * @param {Error|string|null} error
 * @param {(key: string, params?: object) => string} t - translator
 * @returns {string} translated message (never empty)
 */
export function humanizeBleError(error, t) {
  const raw = (error && typeof error === 'object') ? (error.code || '') + ' ' + (error.message || '') : String(error || '');
  const message = raw.trim();
  const translate = (key, params) => {
    try { return t(key, params); } catch { return key; }
  };
  for (const rule of RULES) {
    if (rule.re.test(message)) return translate(rule.key);
  }
  if (!message) return translate('bleErrorGeneric', { message: '' });
  return translate('bleErrorGeneric', { message: message.slice(0, 120) });
}

/**
 * Key only (for callers that store a machine-readable reason).
 */
export function bleErrorKey(error) {
  const raw = (error && typeof error === 'object') ? (error.code || '') + ' ' + (error.message || '') : String(error || '');
  for (const rule of RULES) {
    if (rule.re.test(raw)) return rule.key;
  }
  return 'bleErrorGeneric';
}
