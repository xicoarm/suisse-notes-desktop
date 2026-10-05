'use strict';

// Windows system audio through resources/sysloopback (SysLoopback.cs): every
// active output device at once (--all-endpoints). Chromium's loopback only hears
// the default output device, so a meeting playing on a headset (the default
// COMMUNICATION device) was recorded as silence (2026-08-14, 2026-10-03). Process
// loopback (4.7.13) hears every device but not calls: Windows leaves streams
// marked Communications out of it, and Teams plays its calls that way (2026-10-05).
// The helper speaks AudioTee's contract, so main supervises it with the same
// createPcmCapture as on macOS.

const fs = require('fs');
const path = require('path');

const HELPER_EXE = 'sysloopback.exe';

// Packaged: resources/sysloopback/sysloopback.exe (win.extraResources). In
// development and in the test harness the app runs from .quasar/dev-electron
// or dist/electron/UnPackaged, so walk up to the repo's resources folder rather
// than assuming one layout (the AudioTee dev path assumes one and misses both).
function resolveSysLoopbackPath({ isPackaged, resourcesPath, startDirs = [], exists = fs.existsSync }) {
  if (isPackaged) {
    const packaged = path.join(resourcesPath || '', 'sysloopback', HELPER_EXE);
    return exists(packaged) ? packaged : null;
  }
  for (const start of startDirs) {
    if (!start) continue;
    let dir = path.resolve(start);
    for (let depth = 0; depth < 6; depth++) {
      const candidate = path.join(dir, 'resources', 'sysloopback', 'win-x64', HELPER_EXE);
      if (exists(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

// Every active output device, summed on one clock. The app plays nothing while it
// records, so its own sound needs no exclusion (process loopback could exclude it,
// but cannot hear Teams). The pid stays in the signature for the caller.
function sysLoopbackArgs(_appPid) {
  return ['--stdout', '--all-endpoints', '--sample-rate', '48000'];
}

// The helper's own events (started, fallback, rebind, stopped) for main.log.
// AudioTee's stderr lines carry no "event" field and stay out of the log.
function describeHelperEvent(event) {
  if (!event || typeof event.event !== 'string') return null;
  const message = typeof event.data?.message === 'string' ? event.data.message : '';
  return `${event.event}${message ? `: ${message}` : ''}`.replace(/\p{Cc}/gu, ' ').slice(0, 500);
}

// `sysloopback.exe --sessions`: one JSON line per device. Our own sessions
// (the app records the microphone too) and the system sounds are dropped.
function parseDeviceSessions(stdout, { ownApp = '' } = {}) {
  const own = String(ownApp).toLowerCase();
  const devices = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    if (!entry || (entry.flow !== 'input' && entry.flow !== 'output') || typeof entry.device !== 'string') continue;
    devices.push({
      flow: entry.flow,
      device: entry.device,
      defaultFor: Array.isArray(entry.defaultFor) ? entry.defaultFor.filter(role => typeof role === 'string') : [],
      sessions: (Array.isArray(entry.sessions) ? entry.sessions : [])
        .filter(session => session && session.pid > 0 && typeof session.app === 'string' && session.app &&
          session.app.toLowerCase() !== own)
        .map(session => ({ app: session.app, active: session.active === true, peak: Number(session.peak) || 0 })),
    });
  }
  return devices;
}

module.exports = { resolveSysLoopbackPath, sysLoopbackArgs, describeHelperEvent, parseDeviceSessions };
