// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';

describe('child-process-gone handling and telemetry', () => {
  function createProcessGoneHandler({ isRecordingInProgress = false, activeRecording = null } = {}) {
    const sentryCalls = [];
    const logCalls = { info: [], warn: [], error: [] };
    const rendererMessages = [];

    const Sentry = {
      withScope: (fn) => {
        const scope = {
          tags: {},
          extra: {},
          level: null,
          setLevel: (l) => { scope.level = l; },
          setTag: (k, v) => { scope.tags[k] = v; },
          setExtra: (k, v) => { scope.extra[k] = v; },
        };
        fn(scope);
      },
      captureMessage: (msg, level) => {
        sentryCalls.push({ msg, level });
      },
    };

    const log = {
      info: (...args) => logCalls.info.push(args),
      warn: (...args) => logCalls.warn.push(args),
      error: (...args) => logCalls.error.push(args),
    };

    const mainWindow = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, data) => rendererMessages.push({ channel, data }),
      },
    };

    const handler = (details) => {
      // Normal process termination is expected lifecycle
      if (details.reason === 'clean-exit') {
        log.info('Child process exited cleanly:', details.type || 'unknown');
        return;
      }

      // OS process termination
      if (details.reason === 'killed') {
        log.warn('Child process killed:', details);
        return;
      }

      log.warn('Child process gone:', details);

      const isRecording = Boolean(isRecordingInProgress || activeRecording?.recordId);

      // Detect Audio Service crash
      if (details.serviceName === 'audio.mojom.AudioService' && details.reason === 'crashed') {
        log.warn('Audio Service crashed — notifying renderer to recover system audio');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('system:audio-service-crashed', {
            reason: details.reason,
            exitCode: details.exitCode,
          });
        }
      }

      // Chromium GPU process restarts automatically
      if (details.type === 'GPU') {
        Sentry.withScope(scope => {
          scope.setLevel('warning');
          scope.setTag('source', 'child-process');
          scope.setTag('process_type', 'GPU');
          if (details.exitCode !== undefined) scope.setTag('exit_code', String(details.exitCode));
          scope.setTag('recording_active', String(isRecording));
          scope.setExtra('details', details);
          Sentry.captureMessage(`GPU process crashed (${details.reason || 'crashed'})`, 'warning');
        });
        return;
      }

      // Crash during recording
      if (isRecording) {
        Sentry.withScope(scope => {
          scope.setLevel('error');
          scope.setTag('source', 'child-process');
          scope.setTag('process_type', details.type || 'unknown');
          if (details.serviceName) scope.setTag('service_name', details.serviceName);
          if (details.exitCode !== undefined) scope.setTag('exit_code', String(details.exitCode));
          scope.setTag('recording_active', 'true');
          scope.setExtra('details', details);
          Sentry.captureMessage(`Child process crashed during recording: ${details.serviceName || details.type || 'unknown'} (${details.reason})`, 'error');
        });
        return;
      }

      // Idle background utility
      Sentry.withScope(scope => {
        scope.setLevel('warning');
        scope.setTag('source', 'child-process');
        scope.setTag('process_type', details.type || 'unknown');
        if (details.serviceName) scope.setTag('service_name', details.serviceName);
        if (details.exitCode !== undefined) scope.setTag('exit_code', String(details.exitCode));
        scope.setTag('recording_active', 'false');
        scope.setExtra('details', details);
        Sentry.captureMessage(`Child process gone: ${details.serviceName || details.type || 'unknown'} (${details.reason})`, 'warning');
      });
    };

    return { handler, sentryCalls, logCalls, rendererMessages };
  }

  it('ignores clean-exit without alarming Sentry', () => {
    const { handler, sentryCalls, logCalls } = createProcessGoneHandler();
    handler({ type: 'Utility', reason: 'clean-exit', exitCode: 0 });
    expect(sentryCalls).toHaveLength(0);
    expect(logCalls.info).toHaveLength(1);
  });

  it('downgrades GPU process crash to warning and tags process_type', () => {
    const { handler, sentryCalls } = createProcessGoneHandler({ isRecordingInProgress: false });
    handler({ type: 'GPU', reason: 'crashed', exitCode: 1 });
    expect(sentryCalls).toHaveLength(1);
    expect(sentryCalls[0]).toEqual({
      msg: 'GPU process crashed (crashed)',
      level: 'warning',
    });
  });

  it('notifies renderer and reports error when child process crashes during an active recording', () => {
    const { handler, sentryCalls, rendererMessages } = createProcessGoneHandler({
      isRecordingInProgress: true,
      activeRecording: { recordId: 'rec-123' },
    });
    handler({
      type: 'Utility',
      serviceName: 'audio.mojom.AudioService',
      reason: 'crashed',
      exitCode: 139,
    });
    expect(rendererMessages).toHaveLength(1);
    expect(rendererMessages[0].channel).toBe('system:audio-service-crashed');
    expect(sentryCalls).toHaveLength(1);
    expect(sentryCalls[0].level).toBe('error');
    expect(sentryCalls[0].msg).toContain('during recording');
  });

  it('reports idle utility process crashes as warning, not error', () => {
    const { handler, sentryCalls } = createProcessGoneHandler({ isRecordingInProgress: false });
    handler({
      type: 'Utility',
      serviceName: 'network.mojom.NetworkService',
      reason: 'crashed',
      exitCode: 1,
    });
    expect(sentryCalls).toHaveLength(1);
    expect(sentryCalls[0].level).toBe('warning');
    expect(sentryCalls[0].msg).toContain('network.mojom.NetworkService');
  });
});
