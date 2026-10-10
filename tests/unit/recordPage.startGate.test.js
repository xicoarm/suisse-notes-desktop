// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

// The real start-click handler of the Record page, compiled with narrow
// dependencies (the approach of recordingBackpressure.handlers.test.js).
function startHandler({ microphones = [], afterReload = microphones, systemAudio = false, android = false,
  minutes = { syncWithServer: async () => {}, knownOutOfMinutes: false, balanceKnown: true, remainingMinutes: 100 } } = {}) {
  const source = fs.readFileSync('src/pages/RecordPage.vue', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('const handleStartClickInternal = async () => {');
  const last = source.indexOf('const onSalesInquirySubmitted', first);
  if (first < 0 || last < first) throw new Error('Missing start handler declaration');
  const availableMicrophones = { value: microphones };
  const deps = {
    recordingStore: {}, minutesStore: minutes,
    authStore: { token: 'token' }, isCapacitor: () => false, isAndroid: () => android,
    $q: { notify: vi.fn() }, t: key => key, contactSalesReason: { value: null }, showContactSalesDialog: { value: false },
    navigator: { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) } }, openAndroidAppSettings: vi.fn(),
    availableMicrophones, systemAudioEnabled: { value: systemAudio },
    loadMicrophones: vi.fn(async () => { availableMicrophones.value = afterReload; }),
    microphonesLoaded: vi.fn(async () => { availableMicrophones.value = afterReload; }),
    historyStore: { defaultStoragePreference: 'keep' }, currentStoragePreference: { value: null },
    doStartRecording: vi.fn(async () => {}), showStorageDialog: { value: false },
  };
  const handler = new Function(...Object.keys(deps), source.slice(first, last) + '\nreturn handleStartClickInternal;')(...Object.values(deps));
  return { handler, deps };
}

const mic = [{ id: 'usb', label: 'USB Mic' }];

describe('record start gate: microphone list', () => {
  it('waits for the list before refusing, and records when a microphone is there now', async () => {
    const { handler, deps } = startHandler({ microphones: [], afterReload: mic });
    await handler();
    expect(deps.microphonesLoaded).toHaveBeenCalledTimes(1);
    expect(deps.loadMicrophones).not.toHaveBeenCalled(); // never a second probe of its own
    expect(deps.doStartRecording).toHaveBeenCalledTimes(1);
    expect(deps.$q.notify).not.toHaveBeenCalled();
  });

  it('refuses with a clear message when there is still no microphone and no system audio', async () => {
    const { handler, deps } = startHandler({ microphones: [] });
    await handler();
    expect(deps.microphonesLoaded).toHaveBeenCalledTimes(1);
    expect(deps.doStartRecording).not.toHaveBeenCalled();
    expect(deps.$q.notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'noMicrophoneNoSystemAudio' }));
  });

  it('records system audio alone when no microphone exists', async () => {
    const { handler, deps } = startHandler({ microphones: [], systemAudio: true });
    await handler();
    expect(deps.doStartRecording).toHaveBeenCalledTimes(1);
  });

  it('does not re-read a list that has microphones, and leaves Android to its permission flow', async () => {
    const listed = startHandler({ microphones: mic });
    await listed.handler();
    expect(listed.deps.microphonesLoaded).not.toHaveBeenCalled();
    expect(listed.deps.loadMicrophones).not.toHaveBeenCalled();
    expect(listed.deps.doStartRecording).toHaveBeenCalledTimes(1);
    const android = startHandler({ microphones: [], afterReload: mic, android: true });
    await android.handler();
    expect(android.deps.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(android.deps.loadMicrophones).toHaveBeenCalledTimes(1); // from the Android flow only
    expect(android.deps.microphonesLoaded).not.toHaveBeenCalled();
    expect(android.deps.doStartRecording).toHaveBeenCalledTimes(1);
  });
});

describe('record start gate: minutes balance', () => {
  it('records when the balance is unknown (new account, fetch lost the 3 s race) - the server decides', async () => {
    vi.useFakeTimers();
    try {
      const { handler, deps } = startHandler({
        microphones: mic,
        minutes: { syncWithServer: () => new Promise(() => {}), knownOutOfMinutes: false, balanceKnown: false, remainingMinutes: 0 }
      });
      const run = handler();
      await vi.advanceTimersByTimeAsync(3000);
      await run;
      expect(deps.doStartRecording).toHaveBeenCalledTimes(1);
      expect(deps.showContactSalesDialog.value).toBe(false);
      expect(deps.$q.notify).not.toHaveBeenCalled(); // no "0 minutes left" warning either
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses only a balance the server confirmed as used up', async () => {
    const { handler, deps } = startHandler({
      microphones: mic,
      minutes: { syncWithServer: async () => {}, knownOutOfMinutes: true, balanceKnown: true, remainingMinutes: 0 }
    });
    await handler();
    expect(deps.doStartRecording).not.toHaveBeenCalled();
    expect(deps.showContactSalesDialog.value).toBe(true);
  });
});
