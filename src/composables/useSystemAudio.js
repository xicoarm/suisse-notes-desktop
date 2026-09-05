import { ref } from 'vue';
import { isElectron } from '../utils/platform';
import { addSystemAudioStream } from '../services/recordingService';

// The loopback capture is inherently a singleton (one recording, one mix), but
// this composable is instantiated fresh on every RecordPage mount while a
// recording survives navigation. Module-level monitor ownership guarantees at
// most ONE rebind monitor exists app-wide and that stopCapture from ANY
// instance disarms whichever instance installed it. Previously the monitor and
// stream ref lived purely in per-instance closures: navigate away and back
// during a system-audio recording, stop from the new instance → the OLD
// instance's devicechange listener survived forever holding a live stream ref,
// and a later Bluetooth profile flip could re-acquire the loopback and inject
// system audio into a subsequent recording where the user had it DISABLED.
let _activeMonitorRemove = null;

// App-lifetime stop paths have no RecordPage/composable instance to call.
// Release the owning Windows capture and revoke its asynchronous rebinds;
// the caller still owns recording-mix teardown and macOS helper shutdown.
export function stopSystemAudioRebindMonitor() {
  _activeMonitorRemove?.({ releaseCapture: true });
}

export function useSystemAudio() {
  let captureGeneration = 0;
  const systemAudioEnabled = ref(false);
  const permissionStatus = ref('unknown'); // 'unknown' | 'granted' | 'denied' | 'unsupported'
  const systemAudioStream = ref(null);
  const error = ref(null);
  const isLoading = ref(false);
  const isSupported = ref(false);
  // { defaultLabel, commsLabel } while the two Windows default output endpoints
  // disagree — see checkOutputRouting below. null when they match / unknown.
  const outputRoutingMismatch = ref(null);

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

      // Surface the Windows default-vs-communication endpoint split up front, so
      // the user can fix their sound settings BEFORE recording an hour of silence.
      await checkOutputRouting();

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

    const generation = ++captureGeneration;
    isLoading.value = true;
    error.value = null;

    try {
      const support = await window.electronAPI.systemAudio.isSupported();

      if (generation !== captureGeneration) return null;
      if (support.platform === 'win32') {
        // Windows: use desktopCapturer via renderer-side getUserMedia
        return await startDesktopCapture(generation);
      }

      // macOS: use AudioTee via main process
      const result = await window.electronAPI.systemAudio.start(recordId, offsetMs);
      if (generation !== captureGeneration) return null;
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

  // --- Windows output-endpoint routing check --------------------------------
  //
  // Windows keeps TWO independent default output endpoints: the "Default Device"
  // (eConsole/eMultimedia) and the "Default Communication Device". Chromium's
  // WASAPI loopback ALWAYS binds to the default MULTIMEDIA endpoint, while every
  // conferencing app (Teams, Zoom, Meet, Slack) renders call audio to the default
  // COMMUNICATION endpoint. Anyone using a headset for calls and speakers for
  // everything else therefore has the two pointing at different devices — and the
  // loopback then captures the idle endpoint: a live track, no error, no warning,
  // and 100% digital silence for the whole meeting.
  //
  // Measured on a Jabra Evolve2 65 + laptop-speaker setup (2026-08-14): a test tone
  // rendered to the default endpoint was captured at -19.5 dBFS; the SAME tone
  // rendered to the comms endpoint was captured at -99.5 dBFS, i.e. nothing.
  // Endpoint mute is irrelevant (loopback taps the mix before endpoint volume) —
  // only the endpoint IDENTITY matters.
  //
  // Chromium exposes both roles as the "default" and "communications" pseudo
  // devices, so the mismatch is detectable in the renderer and we can tell the
  // user exactly which device to change instead of shipping silence.
  const stripRolePrefix = (label = '') =>
    label.replace(/^\s*(default|communications|standard|kommunikation(en)?)\s*[-–]\s*/i, '').trim();

  const checkOutputRouting = async () => {
    try {
      if (!isElectron() || !navigator.mediaDevices?.enumerateDevices) return null;
      const support = await window.electronAPI.systemAudio.isSupported();
      if (support.platform !== 'win32') return null; // macOS AudioTee taps the process graph

      const outputs = (await navigator.mediaDevices.enumerateDevices())
        .filter(d => d.kind === 'audiooutput');
      const def = outputs.find(d => d.deviceId === 'default');
      const comms = outputs.find(d => d.deviceId === 'communications');
      // Labels are empty until a media permission has been granted this session.
      // Without them we cannot compare, and a guess would be worse than silence.
      if (!def?.label || !comms?.label) return null;

      const defaultLabel = stripRolePrefix(def.label);
      const commsLabel = stripRolePrefix(comms.label);
      if (!defaultLabel || !commsLabel || defaultLabel === commsLabel) {
        outputRoutingMismatch.value = null;
        return null;
      }

      outputRoutingMismatch.value = { defaultLabel, commsLabel };
      return outputRoutingMismatch.value;
    } catch (e) {
      console.warn('Could not check system-audio output routing:', e);
      return null;
    }
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
  let activeRebind = null;
  let monitorInstalled = false;

  const _onDeviceChange = () => scheduleLoopbackRebind('devicechange');

  const installRebindMonitor = () => {
    if (monitorInstalled) return;
    // Singleton guard: disarm any monitor a PREVIOUS composable instance left
    // behind (RecordPage was remounted mid-capture) before installing ours.
    if (_activeMonitorRemove && _activeMonitorRemove !== removeRebindMonitor) {
      try { _activeMonitorRemove(); } catch (e) { /* stale instance */ }
    }
    monitorInstalled = true;
    _activeMonitorRemove = removeRebindMonitor;
    navigator.mediaDevices.addEventListener('devicechange', _onDeviceChange);
  };

  const removeRebindMonitor = ({ releaseCapture = false } = {}) => {
    // Acquisitions cannot be cancelled, but a detached monitor no longer owns
    // their result. A subsequent capture may start its own rebind immediately.
    activeRebind = null;
    if (monitorInstalled) {
      monitorInstalled = false;
      if (_activeMonitorRemove === removeRebindMonitor) _activeMonitorRemove = null;
      navigator.mediaDevices.removeEventListener('devicechange', _onDeviceChange);
    }
    if (rebindTimer) {
      clearTimeout(rebindTimer);
      rebindTimer = null;
    }
    if (releaseCapture) {
      captureGeneration++;
      const stoppedStream = systemAudioStream.value;
      systemAudioStream.value = null;
      stoppedStream?.getTracks().forEach(track => track.stop());
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
    if (activeRebind?.generation === captureGeneration || !systemAudioStream.value) return;
    // Only the instance that currently OWNS the monitor may rebind — a stale
    // instance (superseded by a RecordPage remount) must never re-acquire a
    // loopback and push it into someone else's recording mix.
    if (_activeMonitorRemove !== removeRebindMonitor) return;
    // The same composable can stop and restart while acquisition is pending.
    // Monitor ownership alone does not distinguish those recording sessions.
    const operation = { generation: captureGeneration };
    activeRebind = operation;
    try {
      // Acquire the new binding BEFORE touching the old stream: if this
      // fails we keep whatever the old endpoint still delivers.
      const newStream = await acquireLoopbackStream();

      if (operation !== activeRebind || operation.generation !== captureGeneration ||
          !systemAudioStream.value || _activeMonitorRemove !== removeRebindMonitor) {
        // Capture was stopped or superseded while we were acquiring — discard.
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
      if (operation === activeRebind && operation.generation === captureGeneration) {
        diag('error', `loopback rebind failed (${e.name || 'Error'}: ${e.message}) — keeping previous capture`);
      }
    } finally {
      // A stale completion must not unlock a newer acquisition.
      if (operation === activeRebind) activeRebind = null;
    }
  };

  const startDesktopCapture = async (generation) => {
    try {
      // Record the endpoint split in main.log BEFORE capturing, so a "system
      // audio was silent" report is diagnosable from the log alone.
      const routing = await checkOutputRouting();
      if (routing) {
        diag(
          'warn',
          `output-endpoint mismatch — loopback binds to the DEFAULT device "${routing.defaultLabel}" ` +
          `but the default COMMUNICATION device is "${routing.commsLabel}". ` +
          'Any call audio played to the communication device will NOT be captured.'
        );
      }
      const stream = await acquireLoopbackStream();
      if (generation !== captureGeneration) {
        stream.getTracks().forEach(track => track.stop());
        return null;
      }
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
    captureGeneration++;
    if (_activeMonitorRemove && _activeMonitorRemove !== removeRebindMonitor) _activeMonitorRemove();
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
    outputRoutingMismatch,
    loadState,
    setEnabled,
    startCapture,
    stopCapture,
    captureSystemAudio,
    checkOutputRouting
  };
}
