// @vitest-environment node
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveSysLoopbackPath, sysLoopbackArgs, describeHelperEvent, parseDeviceSessions } =
  require('../../src-electron/windows-system-audio');

const repo = path.resolve('C:/work/app');
const devHelper = path.join(repo, 'resources', 'sysloopback', 'win-x64', 'sysloopback.exe');

describe('finding the Windows system-audio helper', () => {
  it('uses the packaged resource and nothing else in a packaged app', () => {
    const resources = path.resolve('C:/Program Files/app/resources');
    const packaged = path.join(resources, 'sysloopback', 'sysloopback.exe');
    expect(resolveSysLoopbackPath({ isPackaged: true, resourcesPath: resources, exists: p => p === packaged })).toBe(packaged);
    expect(resolveSysLoopbackPath({ isPackaged: true, resourcesPath: resources, startDirs: [repo], exists: p => p === devHelper })).toBeNull();
  });

  // quasar dev runs main from .quasar/dev-electron, the test harness from
  // dist/electron/UnPackaged: both must find the repo's helper.
  it('walks up from the development and harness layouts to the repo resources', () => {
    const exists = p => p === devHelper;
    expect(resolveSysLoopbackPath({ isPackaged: false, startDirs: [path.join(repo, '.quasar', 'dev-electron')], exists })).toBe(devHelper);
    expect(resolveSysLoopbackPath({ isPackaged: false, startDirs: [path.join(repo, 'dist', 'electron', 'UnPackaged')], exists })).toBe(devHelper);
    expect(resolveSysLoopbackPath({ isPackaged: false, startDirs: [null, path.resolve('C:/elsewhere')], exists })).toBeNull();
  });

  it('records every output device - not process loopback, which cannot hear calls - as 48 kHz PCM on stdout', () => {
    expect(sysLoopbackArgs(4242)).toEqual(['--stdout', '--all-endpoints', '--sample-rate', '48000']);
    expect(sysLoopbackArgs(4242, 'devices')).toEqual(['--stdout', '--all-endpoints', '--sample-rate', '48000']);
  });

  it('captures per process only when a test build asks for it (hosted CI sound card)', () => {
    expect(sysLoopbackArgs(4242, 'process')).toEqual(['--stdout', '--process-loopback', '--exclude-pid', '4242', '--sample-rate', '48000']);
  });
});

describe('the helper output', () => {
  it('logs the helper events and nothing from AudioTee', () => {
    expect(describeHelperEvent({ message_type: 'stream_start', event: 'started', data: { message: 'process-loopback exclude=1 rate=48000' } }))
      .toBe('started: process-loopback exclude=1 rate=48000');
    expect(describeHelperEvent({ message_type: 'info', event: 'fallback', data: { message: 'line1\nline2' } })).toBe('fallback: line1 line2');
    expect(describeHelperEvent({ message_type: 'metadata', data: { sample_rate: 48000 } })).toBeNull();
    expect(describeHelperEvent(null)).toBeNull();
  });

  it('reads the device sessions and drops the app itself, the system and broken lines', () => {
    const stdout = [
      JSON.stringify({ flow: 'input', device: 'Mikrofon (Jabra Evolve2 65)', defaultFor: ['communications'],
        sessions: [{ pid: 10, app: 'ms-teams', active: true, peak: 0.2 }, { pid: 11, app: 'Suisse Meets', active: true, peak: 0.1 }, { pid: 0, app: 'system', active: false }] }),
      'not json',
      JSON.stringify({ flow: 'output', device: 'Lautsprecher', defaultFor: ['console', 'multimedia'], sessions: [{ pid: 12, app: 'chrome', active: false, peak: 0 }] }),
      JSON.stringify({ flow: 'sideways', device: 'X', sessions: [] }),
      '',
    ].join('\r\n');
    expect(parseDeviceSessions(stdout, { ownApp: 'Suisse Meets' })).toEqual([
      { flow: 'input', device: 'Mikrofon (Jabra Evolve2 65)', defaultFor: ['communications'], sessions: [{ app: 'ms-teams', active: true, peak: 0.2 }] },
      { flow: 'output', device: 'Lautsprecher', defaultFor: ['console', 'multimedia'], sessions: [{ app: 'chrome', active: false, peak: 0 }] },
    ]);
  });
});
