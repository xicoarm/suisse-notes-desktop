import { ref } from 'vue';
import { isElectron } from '../utils/platform';
import { addSystemAudioStream } from '../services/recordingService';

export function useSystemAudio() {
  const systemAudioEnabled = ref(false);
  const permissionStatus = ref('unknown'); // 'unknown' | 'granted' | 'denied' | 'unsupported'
  const systemAudioStream = ref(null);
  const error = ref(null);
  const isLoading = ref(false);
  const isSupported = ref(false);

  // Load initial state and check platform support
  const loadState = async () => {
    try {
      if (!isElectron()) {
        permissionStatus.value = 'unsupported';
        return;
      }

      const support = await window.electronAPI.systemAudio.isSupported();
      isSupported.value = support.supported;

      if (!support.supported) {
        permissionStatus.value = 'unsupported';
        return;
      }

      systemAudioEnabled.value = await window.electronAPI.systemAudio.getEnabled();

      if (support.platform === 'darwin') {
        // AudioTee uses "System Audio Recording" permission — can't pre-check, assume granted
        permissionStatus.value = 'granted';
      } else {
        // Windows: desktopCapturer — permission always granted
        permissionStatus.value = 'granted';
      }
    } catch (e) {
      console.error('Error loading system audio state:', e);
    }
  };

  // Set enabled state and persist to config
  const setEnabled = async (enabled) => {
    try {
      await window.electronAPI.systemAudio.setEnabled(enabled);
      systemAudioEnabled.value = enabled;
      return true;
    } catch (e) {
      error.value = e.message;
      return false;
    }
  };

  // Start system audio capture — platform-specific
  // offsetMs: recording-timeline offset at which capture begins (for mid-recording
  //           toggles on macOS, AudioTee pads the file with silence to align with
  //           the mic track at merge time). 0 when starting at recording start.
  const startCapture = async (recordId, offsetMs = 0) => {
    if (!systemAudioEnabled.value || !isSupported.value || !isElectron()) return null;

    isLoading.value = true;
    error.value = null;

    try {
      const support = await window.electronAPI.systemAudio.isSupported();

      if (support.platform === 'win32') {
        // Windows: use desktopCapturer via renderer-side getUserMedia
        return await startDesktopCapture();
      }

      // macOS: use AudioTee via main process
      const result = await window.electronAPI.systemAudio.start(recordId, offsetMs);
      if (!result.success) {
        error.value = result.error;
        if (result.error?.includes('permission') || result.error?.includes('denied')) {
          permissionStatus.value = 'denied';
        }
        return null;
      }
      console.log('System audio capture started via AudioTee');
      return true;
    } catch (e) {
      console.error('Error starting system audio capture:', e);
      error.value = e.message;
      return null;
    } finally {
      isLoading.value = false;
    }
  };

  // Report a system-audio diagnostic to the main process so it lands in
  // main.log. The Windows capture path runs entirely in the renderer, so its
  // failures were previously invisible — indistinguishable from "feature broken."
  const diag = (level, message) => {
    try { window.electronAPI?.systemAudio?.diag?.(level, message); } catch { /* best effort */ }
  };

  // Windows: raw loopback acquisition via desktopCapturer + getUserMedia.
  //
  // Loopback (system) audio on Windows only comes from a SCREEN source — a window
  // source produces a video-only capture with no audio track. We therefore refuse
  // to fall back to a non-screen source (the old `|| sources[0]` fallback would
  // silently attach a soundless capture). The 1x1 video constraint also throws
  // OverconstrainedError on some GPU/driver stacks and takes the whole request
  // down with it, so we retry audio-only if the combined request fails.
  //
  // Throws on failure. Shared by initial capture and the rebind monitor below.
  const acquireLoopbackStream = async () => {
    const sources = await window.electronAPI.systemAudio.getSources();
    if (!sources || sources.length === 0) {
      diag('error', 'no screen sources returned by desktopCapturer — cannot capture loopback audio');
      throw new Error('No screen source available for system audio');
    }

    // Only a screen source carries loopback audio on Windows.
    const screenSource = sources.find(s =>
      s.id.startsWith('screen:') ||
      s.name === 'Entire Screen' ||
      /screen/i.test(s.name)
    );
    if (!screenSource) {
      diag('error', `no screen-type source among ${sources.length} source(s): ${sources.map(s => s.id).join(', ')}`);
      throw new Error('No screen source available for system audio');
    }

    const audioMandatory = {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: screenSource.id
    };

    let stream = null;
    // Primary: audio + tiny video (Chromium historically required a video
    // track alongside desktop audio). Fallback: audio-only, in case the video
    // constraint is what's being rejected.
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: audioMandatory },
        video: {
          mandatory: {
            ...audioMandatory,
            maxWidth: 1,
            maxHeight: 1,
            maxFrameRate: 1
          }
        }
      });
    } catch (combinedErr) {
      diag('warn', `combined audio+video loopback request failed (${combinedErr.name}: ${combinedErr.message}); retrying audio-only`);
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: audioMandatory }
      });
    }

    // Stop video tracks immediately — we only need audio
    stream.getVideoTracks().forEach(track => track.stop());

    if (stream.getAudioTracks().length === 0) {
      diag('error', `capture succeeded but produced no audio track (source ${screenSource.id}) — check the default playback device supports loopback`);
      throw new Error('No audio tracks in system audio stream');
    }

    diag('info', `loopback capture started (source ${screenSource.id}, ${stream.getAudioTracks().length} track(s))`);
    return new MediaStream(stream.getAudioTracks());
  };

  // --- Bluetooth profile-flip rebind monitor (Windows) ----------------------
  //
  // WASAPI loopback binds to the default output device ONCE at capture start.
  // When a Bluetooth headset flips between A2DP (music) and HFP (mic active) —
  // which happens whenever ANY app opens its microphone: Teams/Zoom joining a
  // call, or our own mic capture — the bound endpoint suspends and the capture
  // silently delivers pure silence. No error, no track event. Every profile
  // flip changes the machine's audio device set, so `devicechange` is the
  // reliable signal: re-acquire the loopback (it binds to the CURRENT default
  // output) and hot-swap the fresh track into the live recording mix.
  let rebindTimer = null;
  let rebindInProgress = false;
  let monitorInstalled = false;

  const _onDeviceChange = () => scheduleLoopbackRebind('devicechange');

  const installRebindMonitor = () => {
    if (monitorInstalled) return;
    monitorInstalled = true;
    navigator.mediaDevices.addEventListener('devicechange', _onDeviceChange);
  };

  const removeRebindMonitor = () => {
    if (!monitorInstalled) return;
    monitorInstalled = false;
    navigator.mediaDevices.removeEventListener('devicechange', _onDeviceChange);
    if (rebindTimer) {
      clearTimeout(rebindTimer);
      rebindTimer = null;
    }
  };

  const watchTrackEnded = (stream) => {
    stream.getAudioTracks().forEach(track => {
      track.addEventListener('ended', () => {
        diag('warn', 'loopback track ended (output device removed?) — scheduling rebind');
        scheduleLoopbackRebind('track-ended');
      }, { once: true });
    });
  };

  // Debounce: a BT profile flip fires devicechange in bursts while endpoints
  // appear/disappear. Rebind once, after the device set settles.
  const scheduleLoopbackRebind = (reason) => {
    if (!systemAudioStream.value) return; // capture not active
    diag('info', `audio device set changed (${reason}) — rebinding loopback capture in 1.5s`);
    if (rebindTimer) clearTimeout(rebindTimer);
    rebindTimer = setTimeout(() => {
      rebindTimer = null;
      rebindLoopback(reason);
    }, 1500);
  };

  const rebindLoopback = async (reason) => {
    if (rebindInProgress || !systemAudioStream.value) return;
    rebindInProgress = true;
    try {
      // Acquire the new binding BEFORE touching the old stream: if this
      // fails we keep whatever the old endpoint still delivers.
      const newStream = await acquireLoopbackStream();

      if (!systemAudioStream.value) {
        // Capture was stopped while we were acquiring — discard.
        newStream.getTracks().forEach(t => t.stop());
        return;
      }

      const oldStream = systemAudioStream.value;
      // addSystemAudioStream detaches + stops the previous stream, then wires
      // the new one into the live mixing pipeline.
      const attached = addSystemAudioStream(newStream);
      systemAudioStream.value = newStream;
      watchTrackEnded(newStream);

      if (attached) {
        diag('info', `loopback rebound after ${reason} — system audio re-attached to current default output`);
      } else {
        // No active mixing pipeline (not recording right now): just carry the
        // fresh binding forward and release the stale one ourselves.
        try { oldStream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
        diag('info', `loopback rebound after ${reason} (no active recording mix to attach to)`);
      }
    } catch (e) {
      diag('error', `loopback rebind failed (${e.name || 'Error'}: ${e.message}) — keeping previous capture`);
    } finally {
      rebindInProgress = false;
    }
  };

  const startDesktopCapture = async () => {
    try {
      const stream = await acquireLoopbackStream();
      systemAudioStream.value = stream;
      installRebindMonitor();
      watchTrackEnded(stream);
      console.log('System audio captured via desktopCapturer');
      return systemAudioStream.value;
    } catch (e) {
      console.error('Error capturing system audio via desktopCapturer:', e);
      diag('error', `desktopCapturer capture failed (${e.name || 'Error'}: ${e.message})`);
      if (e.name === 'NotAllowedError') {
        permissionStatus.value = 'denied';
      }
      error.value = e.message;
      return null;
    }
  };

  // Stop system audio capture (called when recording stops)
  const stopCapture = async () => {
    // Stop the rebind monitor first so an in-flight devicechange can't
    // resurrect the capture we are tearing down.
    removeRebindMonitor();
    // Stop desktopCapturer stream (Windows)
    if (systemAudioStream.value) {
      systemAudioStream.value.getTracks().forEach(track => track.stop());
      systemAudioStream.value = null;
    }
    // Stop AudioTee (macOS)
    if (isElectron()) {
      try {
        await window.electronAPI.systemAudio.stop();
      } catch (e) {
        console.warn('Error stopping system audio capture:', e);
      }
    }
  };

  // Legacy API compat — captureSystemAudio now delegates to startCapture
  const captureSystemAudio = async (recordId, offsetMs = 0) => {
    return startCapture(recordId, offsetMs);
  };

  return {
    systemAudioEnabled,
    permissionStatus,
    systemAudioStream,
    error,
    isLoading,
    isSupported,
    loadState,
    setEnabled,
    startCapture,
    stopCapture,
    captureSystemAudio
  };
}
