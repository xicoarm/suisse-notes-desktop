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

  it('covers a recording start in progress, while the phase is still idle', () => {
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, startRequested: true, phase: 'idle', routeName: 'record' })).toBe(true);
  });

  it('covers the result and error screens only where they are shown', () => {
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'uploaded', routeName: 'record' })).toBe(true);
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'uploaded', routeName: 'upload' })).toBe(true);
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'error', routeName: 'record' })).toBe(true);
    // The upload page shows its own errors from local state, never this phase.
    expect(isOwnRecordingFlowOnScreen({ isBlocking: false, phase: 'error', routeName: 'upload' })).toBe(false);
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

  it('a recording start in progress holds the prompt until the start is through', () => {
    const prep = useMeetingPrepStore();
    const recording = useRecordingStore();
    recording.startRequested = true;
    prep.requestDeviceSyncPrep(PROMPT);
    expect(prep.deviceSyncPrompt).toBeNull();
    recording.phase = 'recording';
    recording.startRequested = false;
    prep._maybeShowNextPrompt();
    expect(prep.deviceSyncPrompt).toBeNull();
  });

  it('a run paused for a phone recording keeps "apply to all" for exactly the files it did not reach', async () => {
    const prep = useMeetingPrepStore();
    const answer = { contextText: 'Steering committee', templateId: 'tpl-1' };
    prep.beginDeviceSyncRun();
    prep.requestDeviceSyncPrep(PROMPT);
    prep.answerDeviceSyncPrompt(answer, true);
    prep.pauseDeviceSyncRun(['R2.opus', 'R3.opus']);
    expect(prep.deviceSyncRunActive).toBe(false);

    // A later run takes the left files without asking again ...
    prep.beginDeviceSyncRun();
    await expect(prep.requestDeviceSyncPrep({ recordId: 'pro-2', title: 't', fileName: 'R2.opus' })).resolves.toEqual(answer);
    expect(prep.deviceSyncPrompt).toBeNull();
    // ... but a file recorded since asks as usual.
    prep.requestDeviceSyncPrep({ recordId: 'pro-4', title: 't', fileName: 'R4.opus' });
    expect(prep.deviceSyncPrompt?.recordId).toBe('pro-4');
    prep.answerDeviceSyncPrompt(null);
    prep.endDeviceSyncRun();
    await expect(prep.requestDeviceSyncPrep({ recordId: 'pro-3', title: 't', fileName: 'R3.opus' })).resolves.toEqual(answer);
    expect(prep._carriedApplyToAll).toBeNull();
  });

  it('a paused run without "apply to all" carries nothing; forgetting the device drops a carried answer', () => {
    const prep = useMeetingPrepStore();
    prep.beginDeviceSyncRun();
    prep.pauseDeviceSyncRun(['R2.opus']);
    expect(prep._carriedApplyToAll).toBeNull();

    prep.beginDeviceSyncRun();
    prep.requestDeviceSyncPrep(PROMPT);
    prep.answerDeviceSyncPrompt(null, true);  // "skip" for all
    prep.pauseDeviceSyncRun(['R2.opus']);
    expect(prep._carriedApplyToAll).toEqual({ answer: null, files: ['R2.opus'] });
    prep.clearCarriedApplyToAll();
    prep.requestDeviceSyncPrep({ recordId: 'pro-2', title: 't', fileName: 'R2.opus' });
    expect(prep.deviceSyncPrompt?.recordId).toBe('pro-2');
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
