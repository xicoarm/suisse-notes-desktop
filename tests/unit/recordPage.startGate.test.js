// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

// The real start-click handler of the Record page, compiled with narrow
// dependencies (the approach of recordingBackpressure.handlers.test.js).
function startHandler({ microphones = [], afterReload = microphones, systemAudio = false, android = false } = {}) {
  const source = fs.readFileSync('src/pages/RecordPage.vue', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('const handleStartClickInternal = async () => {');
  const last = source.indexOf('const onSalesInquirySubmitted', first);
  if (first < 0 || last < first) throw new Error('Missing start handler declaration');
  const availableMicrophones = { value: microphones };
  const deps = {
    recordingStore: {}, minutesStore: { syncWithServer: async () => {}, hasMinutesRemaining: true, remainingMinutes: 100 },
    authStore: { token: 'token' }, isCapacitor: () => false, isAndroid: () => android,
    $q: { notify: vi.fn() }, t: key => key, contactSalesReason: { value: null }, showContactSalesDialog: { value: false },
    navigator: { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) } }, openAndroidAppSettings: vi.fn(),
    availableMicrophones, systemAudioEnabled: { value: systemAudio },
    loadMicrophones: vi.fn(async () => { availableMicrophones.value = afterReload; }),
    historyStore: { defaultStoragePreference: 'keep' }, currentStoragePreference: { value: null },
    doStartRecording: vi.fn(async () => {}), showStorageDialog: { value: false },
  };
  const handler = new Function(...Object.keys(deps), source.slice(first, last) + '\nreturn handleStartClickInternal;')(...Object.values(deps));
  return { handler, deps };
}

const mic = [{ id: 'usb', label: 'USB Mic' }];

describe('record start gate: microphone list', () => {
  it('reads the list once more before refusing, and records when a microphone is there now', async () => {
    const { handler, deps } = startHandler({ microphones: [], afterReload: mic });
    await handler();
    expect(deps.loadMicrophones).toHaveBeenCalledTimes(1);
    expect(deps.doStartRecording).toHaveBeenCalledTimes(1);
    expect(deps.$q.notify).not.toHaveBeenCalled();
  });

  it('refuses with a clear message when there is still no microphone and no system audio', async () => {
    const { handler, deps } = startHandler({ microphones: [] });
    await handler();
    expect(deps.loadMicrophones).toHaveBeenCalledTimes(1);
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
    expect(listed.deps.loadMicrophones).not.toHaveBeenCalled();
    expect(listed.deps.doStartRecording).toHaveBeenCalledTimes(1);
    const android = startHandler({ microphones: [], afterReload: mic, android: true });
    await android.handler();
    expect(android.deps.navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(android.deps.loadMicrophones).toHaveBeenCalledTimes(1); // from the Android flow only
    expect(android.deps.doStartRecording).toHaveBeenCalledTimes(1);
  });
});
