import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The Suisse Meets Pro context prompt must never appear inside the user's own
// recording flow. On 03.10.2026 a Pro file stranded since 26.09. popped up the
// moment a 9-second phone recording finished uploading, titled "Kontext &
// Vorlage für diese Aufnahme" - it read as a prompt for the phone recording.
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: () => {}, captureException: () => {}, captureMessage: () => {} }));
vi.mock('../../src/boot/i18n', () => ({ i18n: { global: { t: (k) => k } } }));
vi.mock('../../src/stores/auth', () => ({ useAuthStore: () => ({ user: { id: 'u1' }, token: 'tok', isAuthenticated: true }) }));

import { useMeetingPrepStore, isOwnRecordingFlowOnScreen } from '../../src/stores/meeting-prep';
import { useRecordingStore } from '../../src/stores/recording';

const PROMPT = { recordId: 'pro-1', title: '2026-09-22 17:13', fileName: 'R20260922-171358.opus' };

describe('isOwnRecordingFlowOnScreen', () => {
  it('covers the running recording or upload on every page', () => {
    for (const routeName of ['record', 'upload', 'history', 'device', 'settings']) {
      expect(isOwnRecordingFlowOnScreen({ isBlocking: true, phase: 'recording', routeName })).toBe(true);
    }
  });

  it('covers the result and error screens only where they are shown', () => {
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'uploaded', routeName: 'record' })).toBe(true);
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'error', routeName: 'upload' })).toBe(true);
    // RecordPage resets 'uploaded' only when it mounts again, so the phase can
    // linger while the user is elsewhere - prompts must show there.
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'uploaded', routeName: 'history' })).toBe(false);
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'uploaded', routeName: 'device' })).toBe(false);
  });

  it('is false when none of the user\'s own work runs', () => {
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'idle', routeName: 'record' })).toBe(false);
  });
});

describe('meeting prep store: Suisse Meets Pro prompt', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('waits while the phone recording runs and while its result is on screen, then shows', async () => {
    const prep = useMeetingPrepStore();
    const recording = useRecordingStore();
    recording.phase = 'recording';
    prep.setPhoneFlowActive(true);
    const answer = prep.requestDeviceSyncPrep(PROMPT);
    expect(prep.deviceSyncPrompt).toBeNull();

    // Upload finished: no longer blocking, but the result card is showing.
    recording.phase = 'uploaded';
    prep._maybeShowNextPrompt();
    expect(prep.deviceSyncPrompt).toBeNull();

    // The user left the result screen.
    prep.setPhoneFlowActive(false);
    expect(prep.deviceSyncPrompt).toEqual(PROMPT);

    prep.answerDeviceSyncPrompt(null);
    await expect(answer).resolves.toBeNull();
    expect(prep.isDeviceSyncPrepPending(PROMPT.recordId)).toBe(false);
  });

  it('a running recording holds the prompt even before the dialog has reported anything', () => {
    const prep = useMeetingPrepStore();
    useRecordingStore().phase = 'uploading';
    prep.requestDeviceSyncPrep(PROMPT);
    expect(prep.deviceSyncPrompt).toBeNull();
  });

  it('shows at once when the user is not in their own recording flow', () => {
    const prep = useMeetingPrepStore();
    prep.requestDeviceSyncPrep(PROMPT);
    expect(prep.deviceSyncPrompt).toEqual(PROMPT);
  });

  it('a second queued prompt also waits for the flow to end', () => {
    const prep = useMeetingPrepStore();
    prep.requestDeviceSyncPrep(PROMPT);
    prep.requestDeviceSyncPrep({ ...PROMPT, recordId: 'pro-2', fileName: 'R20260922-173633.opus' });
    prep.setPhoneFlowActive(true);
    prep.answerDeviceSyncPrompt(null);
    expect(prep.deviceSyncPrompt).toBeNull();
    prep.setPhoneFlowActive(false);
    expect(prep.deviceSyncPrompt?.recordId).toBe('pro-2');
  });
});
