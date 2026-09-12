import { describe, it, expect } from 'vitest';
import { humanizeBleError, bleErrorKey } from '../../src/utils/bleErrors';

// Every raw protocol / transport failure string the BLE layer can produce
// must map to a translated, actionable key — users saw the English raw
// strings inside otherwise translated toasts.
const t = (key, params) => (params && params.message !== undefined ? `${key}:${params.message}` : key);

describe('humanizeBleError', () => {
  it.each([
    ['Device rejected pairing (already paired to another app)', 'bleErrorPairedElsewhere'],
    [{ code: 'BLE_PAIRED_ELSEWHERE', message: 'x' }, 'bleErrorPairedElsewhere'],
    ['BLE response timeout', 'bleErrorTimeout'],
    ['Connection timeout.', 'bleErrorTimeout'],
    ['BLE disconnected during transfer', 'bleErrorDisconnected'],
    ['Device not connected', 'bleErrorDisconnected'],
    ['Error writing descriptor', 'bleErrorDisconnected'],
    ['MemoryBusy', 'bleErrorBusy'],
    [{ code: 'DEVICE_MEMORYBUSY', message: 'MemoryBusy' }, 'bleErrorBusy'],
    ['MemoryFull', 'bleErrorFull'],
    ['MemoryErr', 'bleErrorMemory'],
    [{ code: 'EMPTY_FILE', message: 'Device file is empty' }, 'bleErrorEmptyFile'],
    [{ code: 'CRC_GAVE_UP', message: 'CRC mismatch: expected 1 got 2' }, 'bleErrorCrcGaveUp'],
    ['CRC mismatch: expected 0x1234, got 0x5678', 'bleErrorCrc'],
    ['Device not found', 'bleErrorNotFound'],
    ['Bluetooth is required for device scanning. Please enable Bluetooth.', 'bleErrorBluetoothOff'],
    ['Bluetooth permission denied', 'bleErrorPermission'],
  ])('%s → %s', (input, key) => {
    expect(humanizeBleError(input, t)).toBe(key);
    expect(bleErrorKey(input)).toBe(key);
  });

  it('unknown errors fall back to the generic key and keep the raw text for support', () => {
    expect(humanizeBleError(new Error('Something odd 42'), t)).toBe('bleErrorGeneric:Something odd 42');
    expect(humanizeBleError(null, t)).toBe('bleErrorGeneric:');
    expect(humanizeBleError('', t)).toBe('bleErrorGeneric:');
  });

  it('never throws when the translator throws', () => {
    const bad = () => { throw new Error('missing'); };
    expect(humanizeBleError('MemoryBusy', bad)).toBe('bleErrorBusy');
  });
});
