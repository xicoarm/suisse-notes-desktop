/**
 * A microphone that stays silent after its re-open, or that was lost and not
 * recovered, was reported only inside the app window; a recording ran 42
 * minutes without its microphone behind a meeting app. The safety net now asks
 * the main process for a system notification: once per episode (after a 10 s
 * confirmation), again every 10 minutes while it lasts, and never after the
 * microphone is healthy again or the recording paused or stopped.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  listeners: {},
  health: { status: 'ok', reasonCode: null, trackLabel: '', silenceSince: null, verifying: false },
  service: { micMuted: false },
  store: { isRecording: true, isPaused: false }
}));
vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }));
vi.mock('../../src/boot/i18n', () => ({
  i18n: { global: { t: (key, params) => (params && Object.keys(params).length ? `${key}|${params.device}|${params.time}` : key) } }
}));
vi.mock('../../src/services/recordingService', () => ({
  addEventListener: (event, callback) => { (h.listeners[event] ||= []).push(callback); },
  setSystemAudioActive: vi.fn(),
  getMicHealthState: () => ({ ...h.health }),
  getState: () => ({ micMuted: h.service.micMuted }),
  MIC_HEALTH_STATUS: { OK: 'ok', DEGRADED: 'degraded', CRITICAL: 'critical' },
  MIC_HEALTH_REASON: {
    ZERO_SIGNAL: 'zero_signal', TRACK_ENDED: 'track_ended', NO_AUDIO_DETECTED: 'no_audio_detected',
    NO_VOICE_DETECTED: 'no_voice_detected', MIC_CAPTURE_FAILED: 'mic_capture_failed', LOW_LEVEL: 'low_level'
  }
}));
vi.mock('../../src/stores/recording', () => ({ useRecordingStore: () => h.store }));
vi.mock('../../src/stores/recordings-history', () => ({ useRecordingsHistoryStore: () => ({}) }));
vi.mock('../../src/utils/platform', () => ({ isElectron: () => true }));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: vi.fn() }));
vi.mock('../../src/composables/useSystemAudio', () => ({ stopSystemAudioRebindMonitor: vi.fn() }));

import { initRecordingSafetyNet, setRecordPageActive } from '../../src/services/recordingSafetyNet';

const CONFIRM = 10 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;
const show = vi.fn(async () => ({ success: true }));
const clear = vi.fn(async () => ({ success: true }));
const router = { push: vi.fn(async () => {}) };
let notificationClicked;

const emit = (event, data) => (h.listeners[event] || []).forEach(callback => callback(data));
// The service sets its state, then emits it: the tests do the same.
function health(status, reasonCode = null, extra = {}) {
  h.health = { ...h.health, verifying: false, ...extra, status, reasonCode: status === 'ok' ? null : reasonCode };
  if (status === 'ok') h.health.silenceSince = null;
  emit('healthChange', { ...h.health });
  if (status === 'critical') emit('criticalWarning', { ...h.health });
}
function recordingState(isRecording, isPaused = false) {
  h.store.isRecording = isRecording; h.store.isPaused = isPaused;
  emit('stateChange', { isRecording, isPaused });
}
const at = (hours, minutes, seconds = 0) => new Date(2026, 10, 13, hours, minutes, seconds).getTime();

describe('system notification while the microphone is not heard', () => {
  beforeAll(() => {
    window.electronAPI = {
      system: {
        onCaptureWarning: vi.fn(), onRecordingRecovered: vi.fn(), onSuspend: vi.fn(), onResume: vi.fn(),
        showMicrophoneAlert: show, clearMicrophoneAlert: clear,
        onShowRecordPage: vi.fn(handler => { notificationClicked = handler; })
      }
    };
    initRecordingSafetyNet({ router });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(9, 42, 24));
    h.service.micMuted = false;
    setRecordPageActive(false);
    recordingState(true);
    health('ok', null, { trackLabel: 'Headset', silenceSince: null });
    show.mockClear(); clear.mockClear(); router.push.mockClear();
  });
  afterEach(() => {
    health('ok'); // end any episode so that no timer leaks into the next test
    vi.useRealTimers();
  });

  it('does nothing for "degraded" alone', () => {
    health('degraded', 'zero_signal', { silenceSince: Date.now() - 15000 });
    vi.advanceTimersByTime(3 * TEN_MINUTES);
    expect(show).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('asks for exactly one notification 10 s after the state became critical, naming the microphone and the start of the silence', () => {
    health('degraded', 'zero_signal', { silenceSince: at(9, 40, 19) });
    // The re-open keeps the state while it checks, then reports the fresh stream as silent too.
    health('degraded', 'zero_signal', { verifying: true });
    health('critical', 'zero_signal', { silenceSince: at(9, 42, 19), afterSwitch: true });
    vi.advanceTimersByTime(CONFIRM - 1);
    expect(show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith({
      title: 'micAlertTitle', body: 'micAlertSilentBody|Headset|09:40', onRecordPage: false
    });
    // Further events of the same state: system audio toggled, device details refreshed.
    emit('healthChange', { ...h.health });
    emit('criticalWarning', { ...h.health });
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('counts the swing critical, degraded, critical and a further re-open as one episode', () => {
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    health('degraded', 'zero_signal');
    health('critical', 'zero_signal');
    health('critical', 'zero_signal', { verifying: true });
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });

  it('repeats every 10 minutes while it lasts, one notification per interval', () => {
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TEN_MINUTES - 1);
    expect(show).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(show).toHaveBeenCalledTimes(2);
    health('degraded', 'zero_signal'); // the swing does not reset the rhythm
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2 * TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(5);
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'micAlertSilentBody|Headset|09:42' }));
  });

  it('stops when the microphone has signal again, and a later silence is a new episode', () => {
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    health('ok');
    expect(clear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3 * TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(1);

    vi.setSystemTime(at(11, 5));
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ body: 'micAlertSilentBody|Headset|11:05' }));
  });

  it('says nothing about a lost microphone that the automatic recovery brings back within seconds', () => {
    health('degraded', 'track_ended');  // track ended
    health('critical', 'track_ended');  // next health reading, 100 ms later
    vi.advanceTimersByTime(1000);
    health('critical', 'track_ended', { verifying: true }); // replacement opened, being checked
    vi.advanceTimersByTime(600);
    health('ok', null, { verifying: false }); // signal verified
    vi.advanceTimersByTime(3 * TEN_MINUTES);
    expect(show).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled(); // nothing was shown, nothing to clear
  });

  it('waits while a microphone is being checked, then tells', () => {
    health('critical', 'track_ended');
    vi.advanceTimersByTime(1000);
    health('critical', 'track_ended', { verifying: true });
    vi.advanceTimersByTime(CONFIRM);
    expect(show).not.toHaveBeenCalled();
    // The candidate stayed silent: the recording now runs on a microphone that is not heard.
    health('degraded', 'zero_signal', { afterSwitch: true, silenceSince: Date.now() });
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ body: 'micAlertSilentBody|Headset|09:42' }));
  });

  it('stops when the recording pauses and after a resume tells again only if the microphone is still not heard', () => {
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    recordingState(false, true);
    expect(clear).toHaveBeenCalledTimes(1);
    health('critical', 'zero_signal', { afterSwitch: true }); // an event while paused starts nothing
    vi.advanceTimersByTime(3 * TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(1);

    // Resumed while the microphone still delivers nothing.
    recordingState(true);
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(3);

    // Resumed with a working microphone: the old state clears within seconds, no notification.
    recordingState(false, true);
    recordingState(true);
    vi.advanceTimersByTime(3000);
    health('ok');
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(3);
  });

  it('stops when the recording ends', () => {
    health('critical', 'track_ended');
    vi.advanceTimersByTime(CONFIRM);
    recordingState(false);
    expect(clear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3 * TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('stops a repeat by itself when the recording is no longer running, even if no event said so', () => {
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    h.store.isRecording = false;
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(show).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('says that a lost microphone is not available, and falls back to a generic name', () => {
    health('degraded', 'track_ended', { trackLabel: '' });
    vi.advanceTimersByTime(3000);
    health('critical', 'track_ended', { trackLabel: '' });
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ body: 'micAlertLostBody|micGenericDevice|09:42' }));
  });

  it('stays quiet while the microphone is muted in the app, which is deliberate', () => {
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    h.service.micMuted = true;
    emit('micMuteChange', true);
    expect(clear).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * TEN_MINUTES);
    emit('healthChange', { ...h.health });
    expect(show).toHaveBeenCalledTimes(1);
    // Unmuted, and the microphone still delivers nothing.
    h.service.micMuted = false;
    emit('micMuteChange', false);
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('ignores the other critical states: a quiet room is not a dead microphone', () => {
    health('critical', 'no_audio_detected');
    health('critical', 'no_voice_detected');
    health('critical', 'mic_capture_failed');
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(show).not.toHaveBeenCalled();
    // ...and the alert ends when a silent microphone delivers something again, even if too little.
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    health('degraded', 'low_level');
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('tells main whether the Record page is open, so main can hold it for a person who is looking at it', () => {
    setRecordPageActive(true);
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ onRecordPage: true }));
    setRecordPageActive(false);
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ onRecordPage: false }));
  });

  it('keeps going when main cannot be reached', () => {
    show.mockRejectedValueOnce(new Error('ipc closed'));
    clear.mockImplementationOnce(() => { throw new Error('ipc closed'); });
    health('critical', 'zero_signal');
    expect(() => vi.advanceTimersByTime(CONFIRM)).not.toThrow();
    expect(() => health('ok')).not.toThrow();
    health('critical', 'zero_signal');
    vi.advanceTimersByTime(CONFIRM);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('opens the Record page when the notification is clicked', () => {
    notificationClicked();
    expect(router.push).toHaveBeenCalledWith('/record');
  });
});

describe('texts of the system notification', () => {
  it('exist in all four languages, name microphone and time, allow for a deliberate mute and never call the recording lost', async () => {
    const { i18n, SUPPORTED_LOCALES } = await vi.importActual('../../src/boot/i18n');
    for (const locale of SUPPORTED_LOCALES) {
      const text = i18n.global.messages.value[locale];
      expect(text.micAlertTitle.length).toBeGreaterThan(10);
      for (const key of ['micAlertSilentBody', 'micAlertLostBody']) {
        expect(text[key]).toContain('{device}');
        expect(text[key]).toContain('{time}');
        expect(text[key]).toContain('Suisse Meets');
        expect(text[key].length).toBeLessThan(200);
      }
      expect(text.micAlertSilentBody).toMatch(/\(.+\?\)/); // "(muted?)"
      const all = `${text.micAlertTitle} ${text.micAlertSilentBody} ${text.micAlertLostBody}`;
      expect(all).not.toMatch(/ß|lost|verloren|perdu|pers[oa]\b/i);
    }
  });
});
