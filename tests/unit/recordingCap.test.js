// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { recordingCapSeconds } from '../../src/stores/minutes';

const source = fs.readFileSync('src/composables/useRecorder.js', 'utf8').replace(/\r\n/g, '\n');

// The real resume handler of useRecorder, compiled with narrow dependencies
// (the approach of useRecorder.loadMicrophones.test.js).
function resumeWith(minutesState, duration) {
  const first = source.indexOf('  // Resume recording');
  const last = source.indexOf('  // Stop recording', first);
  if (first < 0 || last < first) throw new Error('Missing resume handler');
  const recordingService = { resumeRecording: vi.fn(() => ({ success: true })) };
  const resume = new Function('minutesLimitWarning', 'minutesLimitReached', 'minutesStore', 'recordingStore',
    'recordingService', 'isAutoSplitting', 'recordingCapSeconds',
    source.slice(first, last) + '\nreturn resumeRecording;')(
    { value: 'x' }, { value: true }, minutesState, { duration }, recordingService, { value: false }, recordingCapSeconds);
  resume();
  return recordingService.resumeRecording.mock.calls[0][2];
}

describe('recording auto-stop limit (minutes balance)', () => {
  it('never limits by an unconfirmed balance (sync lost the 3 s race, offline, cached from yesterday)', () => {
    expect(recordingCapSeconds({ remaining: 3, unlimited: false, lastFetchedAt: null })).toBeNull();
    expect(recordingCapSeconds({ remaining: 0, unlimited: false, lastFetchedAt: null })).toBeNull();
  });

  it('limits by a server-confirmed balance, extended by what is already recorded on resume', () => {
    expect(recordingCapSeconds({ remaining: 3, unlimited: false, lastFetchedAt: 1 })).toBe(180);
    expect(recordingCapSeconds({ remaining: 3, unlimited: false, lastFetchedAt: 1 }, 60)).toBe(240);
    expect(recordingCapSeconds({ remaining: 0, unlimited: false, lastFetchedAt: 1 })).toBeNull();
    expect(recordingCapSeconds({ remaining: -1, unlimited: true, lastFetchedAt: 1 })).toBeNull();
  });

  it('resume: no cap from a cached balance, the confirmed one otherwise', () => {
    expect(resumeWith({ remaining: 2, unlimited: false, lastFetchedAt: null }, 600)).toBeNull();
    expect(resumeWith({ remaining: 2, unlimited: false, lastFetchedAt: 1 }, 600)).toBe(720);
  });

  it('start uses the same rule (no remainingSeconds fallback)', () => {
    const start = source.slice(source.indexOf('  const startRecording = async'), source.indexOf('  // Pause recording'));
    expect(start).toMatch(/maxRecordingSeconds \?\? recordingCapSeconds\(minutesStore\)/);
    expect(start).not.toMatch(/minutesStore\.remainingSeconds/);
    expect(source).not.toMatch(/minutesStore\.remainingSeconds/);
  });
});
