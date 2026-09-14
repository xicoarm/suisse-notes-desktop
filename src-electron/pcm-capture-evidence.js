'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, renameWithRetry, syncFile, syncDirectorySync } = require('./durable-files');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENTS = ['spawned', 'stream-start', 'first-data', 'stop-requested'];
const MAX_TIME_MS = 31 * 24 * 60 * 60 * 1000;
const FORMAT = { sampleRate: 48000, channels: 1, bytesPerSample: 2 };

// All operations for a recording must share its recording/AudioTee lifecycle
// lock. These sidecars record intent and observations; they NEVER pad, truncate
// or rewrite system_audio.raw, and do not establish sample-accurate onset.
function invalid(message) {
  return Object.assign(new Error(`PCM capture evidence: ${message}; original audio is retained`), { code: 'PCM_CAPTURE_EVIDENCE_INVALID' });
}
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !keys.includes(key))) throw invalid(`invalid ${label}`);
}
function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('invalid attempt ID');
  return value;
}
function time(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIME_MS) throw invalid(`invalid ${label}`);
  return value;
}
function byteCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`invalid ${label}`);
  return value;
}
function string(value, maximum, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && !value.length) ||
      [...value].some(character => character.charCodeAt(0) < 32)) throw invalid(`invalid ${label}`);
  return value;
}
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function directory(file, optional = false) {
  const result = stat(file);
  if (!result && optional) return false;
  if (!result || !result.isDirectory() || result.isSymbolicLink()) throw invalid(`missing or unsafe ${path.basename(file)} directory`);
  return true;
}
function layout(recordPath, attemptId) {
  if (typeof recordPath !== 'string' || !path.isAbsolute(recordPath)) throw invalid('recording path must be absolute');
  const record = path.resolve(recordPath);
  directory(record);
  const root = path.join(record, 'pcm-capture-attempts');
  const result = { record, root, pcm: path.join(record, 'system_audio.raw') };
  if (attemptId !== undefined) {
    result.attempt = path.join(root, id(attemptId));
    result.manifest = path.join(result.attempt, 'manifest.json');
    result.failure = path.join(result.attempt, 'failure.json');
    result.end = path.join(result.attempt, 'end.json');
  }
  return result;
}
function pcmState(file) {
  const found = stat(file);
  if (!found) return { exists: false, bytes: 0, sampleAligned: true };
  if (!found.isFile() || found.isSymbolicLink()) throw invalid('unsafe system audio file');
  return { exists: true, bytes: byteCount(found.size, 'PCM size'), sampleAligned: found.size % 2 === 0 };
}
function read(file, optional = false) {
  const found = stat(file);
  if (!found && optional) return undefined;
  if (!found || !found.isFile() || found.isSymbolicLink() || found.size < 2 || found.size > 16384) throw invalid(`missing or malformed ${path.basename(file)}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw invalid(`malformed JSON in ${path.basename(file)}`); }
}
function validateManifest(value) {
  object(value, ['version', 'attemptId', 'required', 'requestOffsetMs', 'requestedAt', 'pcmStartBytes', 'appendStartBytes', 'format', 'timingIsApproximate'], 'manifest');
  if (value.version !== 1 || typeof value.required !== 'boolean' || value.timingIsApproximate !== true ||
      JSON.stringify(value.format) !== JSON.stringify(FORMAT)) throw invalid('invalid manifest schema');
  id(value.attemptId);
  time(value.requestOffsetMs, 'request offset');
  if (typeof value.requestedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.requestedAt) ||
      !Number.isFinite(Date.parse(value.requestedAt))) throw invalid('invalid request wall clock');
  byteCount(value.pcmStartBytes, 'initial PCM size');
  byteCount(value.appendStartBytes, 'intended append offset');
  if (value.appendStartBytes !== Math.max(value.pcmStartBytes, Math.floor(value.requestOffsetMs) * 96)) throw invalid('inconsistent intended append offset');
  return value;
}
function validateEvent(value, attemptId) {
  object(value, ['version', 'attemptId', 'event', 'elapsedMs', 'activeOffsetMs', 'byteLength', 'timingIsApproximate'], 'event');
  if (value.version !== 1 || value.attemptId !== attemptId || !EVENTS.includes(value.event) || value.timingIsApproximate !== true) throw invalid('invalid event schema');
  time(value.elapsedMs, 'elapsed request time');
  time(value.activeOffsetMs, 'observed active offset');
  if (value.event === 'first-data') {
    if (!byteCount(value.byteLength, 'first data byte length')) throw invalid('first data must contain bytes');
  } else if (value.byteLength !== undefined) throw invalid('only first-data events carry byte lengths');
  return value;
}
function validateFailure(value, attemptId) {
  object(value, ['version', 'attemptId', 'stage', 'code', 'message', 'elapsedMs'], 'failure');
  if (value.version !== 1 || value.attemptId !== attemptId) throw invalid('invalid failure schema');
  string(value.stage, 64, 'failure stage'); string(value.code, 64, 'failure code', true); string(value.message, 1024, 'failure message');
  time(value.elapsedMs, 'failure elapsed time');
  return value;
}
function validateEnd(value, manifest) {
  object(value, ['version', 'attemptId', 'success', 'childClosed', 'diskDrained', 'endOffsetMs', 'elapsedMs', 'reason', 'pcmEndBytes', 'audioBytes'], 'end marker');
  if (value.version !== 1 || value.attemptId !== manifest.attemptId || typeof value.success !== 'boolean' ||
      typeof value.childClosed !== 'boolean' || typeof value.diskDrained !== 'boolean') throw invalid('invalid end schema');
  time(value.endOffsetMs, 'end offset'); time(value.elapsedMs, 'end elapsed time'); string(value.reason, 128, 'end reason');
  byteCount(value.pcmEndBytes, 'final PCM size'); byteCount(value.audioBytes, 'captured audio bytes');
  if (value.endOffsetMs < manifest.requestOffsetMs || value.audioBytes !== Math.max(0, value.pcmEndBytes - manifest.appendStartBytes) ||
      (value.success && (!value.childClosed || !value.diskDrained || !value.audioBytes || value.pcmEndBytes % 2 !== 0))) throw invalid('inconsistent successful capture end');
  return value;
}
function readAttempt(recordPath, attemptId) {
  id(attemptId);
  const paths = layout(recordPath, attemptId);
  directory(paths.root); directory(paths.attempt);
  const allowed = new Set(['manifest.json', 'failure.json', 'end.json', ...EVENTS.map(event => `${event}.json`)]);
  for (const name of fs.readdirSync(paths.attempt)) if (!allowed.has(name) && !name.endsWith('.tmp')) throw invalid(`unrecognized attempt file ${name}`);
  const manifest = validateManifest(read(paths.manifest));
  if (manifest.attemptId !== attemptId) throw invalid('attempt manifest does not match directory');
  const events = {};
  for (const event of EVENTS) {
    const value = read(path.join(paths.attempt, `${event}.json`), true);
    if (value !== undefined) {
      events[event] = validateEvent(value, attemptId);
      if (events[event].event !== event) throw invalid('event does not match its filename');
    }
  }
  const failureValue = read(paths.failure, true), endValue = read(paths.end, true);
  const failure = failureValue === undefined ? null : validateFailure(failureValue, attemptId);
  const end = endValue === undefined ? null : validateEnd(endValue, manifest);
  if (end?.success && (failure || !events['first-data'] || end.audioBytes < events['first-data'].byteLength)) {
    throw invalid('successful attempt lacks complete data evidence or has a recorded failure');
  }
  if (end && Object.values(events).some(event => event.elapsedMs > end.elapsedMs)) throw invalid('capture event occurs after its end');
  return { attemptId, manifest, events, failure, end, directory: paths.attempt };
}
async function mkdirDurable(file) {
  if (!directory(file, true)) await fs.promises.mkdir(file);
  syncDirectorySync(path.dirname(file));
}
async function confirm(file) {
  await syncFile(file); syncDirectorySync(path.dirname(file));
}
async function immutable(file, value) {
  const previous = read(file, true);
  if (previous !== undefined) {
    if (JSON.stringify(previous) !== JSON.stringify(value)) throw invalid(`conflicting immutable ${path.basename(file)}`);
    await confirm(file);
    return true;
  }
  await writeFileAtomic(file, JSON.stringify(value));
  return false;
}

async function beginPcmAttempt(recordPath, options) {
  object(options, ['attemptId', 'required', 'requestOffsetMs', 'requestedAt'], 'capture reservation');
  id(options.attemptId);
  const paths = layout(recordPath, options.attemptId);
  await mkdirDurable(paths.root);
  if (stat(paths.attempt)) {
    const previous = readAttempt(recordPath, options.attemptId);
    for (const key of ['attemptId', 'required', 'requestOffsetMs', 'requestedAt']) if (previous.manifest[key] !== options[key]) throw invalid('conflicting capture reservation');
    await confirm(paths.manifest); syncDirectorySync(paths.root);
    return { success: true, attemptId: options.attemptId, duplicate: true, manifest: previous.manifest };
  }
  const pcm = pcmState(paths.pcm);
  const manifest = validateManifest({ version: 1, ...options, pcmStartBytes: pcm.bytes,
    appendStartBytes: Math.max(pcm.bytes, Math.floor(options.requestOffsetMs) * 96), format: { ...FORMAT }, timingIsApproximate: true });
  const staging = path.join(paths.root, `${options.attemptId}.${crypto.randomUUID()}.tmp`);
  await mkdirDurable(staging);
  await writeFileAtomic(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
  syncDirectorySync(staging);
  await renameWithRetry(staging, paths.attempt);
  return { success: true, attemptId: options.attemptId, duplicate: false, manifest };
}

async function markPcmEvent(recordPath, attemptId, options) {
  object(options, ['event', 'elapsedMs', 'activeOffsetMs', 'byteLength'], 'capture event');
  const attempt = readAttempt(recordPath, attemptId);
  const value = validateEvent({ version: 1, attemptId, ...options, timingIsApproximate: true }, attemptId);
  if (value.activeOffsetMs < attempt.manifest.requestOffsetMs) throw invalid('event active offset precedes capture request');
  if (attempt.end && !attempt.events[value.event]) throw invalid('cannot add events to an ended capture');
  const duplicate = await immutable(path.join(attempt.directory, `${value.event}.json`), value);
  return { success: true, attemptId, duplicate };
}

async function recordPcmFailure(recordPath, attemptId, options) {
  object(options, ['stage', 'code', 'message', 'elapsedMs'], 'capture failure');
  const attempt = readAttempt(recordPath, attemptId);
  const value = validateFailure({ version: 1, attemptId, ...options, code: options.code || '' }, attemptId);
  if (attempt.end?.success) throw invalid('cannot add a failure after successful capture completion');
  const duplicate = await immutable(path.join(attempt.directory, 'failure.json'), value);
  return { success: true, attemptId, duplicate };
}

async function endPcmAttempt(recordPath, attemptId, options) {
  object(options, ['success', 'childClosed', 'diskDrained', 'endOffsetMs', 'elapsedMs', 'reason'], 'capture completion');
  const attempt = readAttempt(recordPath, attemptId);
  const pcm = pcmState(layout(recordPath).pcm);
  // Exact retries use the original end byte count, even if a later valid
  // capture has appended to the same PCM file. The earlier extent is immutable.
  const pcmEndBytes = attempt.end ? attempt.end.pcmEndBytes : pcm.bytes;
  const value = validateEnd({ version: 1, attemptId, ...options, pcmEndBytes,
    audioBytes: Math.max(0, pcmEndBytes - attempt.manifest.appendStartBytes) }, attempt.manifest);
  if (value.success && (attempt.failure || !attempt.events['first-data'] || value.audioBytes < attempt.events['first-data'].byteLength ||
      !pcm.exists || !pcm.sampleAligned || pcm.bytes < pcmEndBytes)) {
    throw invalid('required data or successful capture barriers are missing');
  }
  if (Object.values(attempt.events).some(event => event.elapsedMs > value.elapsedMs)) throw invalid('capture end precedes observed events');
  if (value.success) {
    // Do not merely trust an event named diskDrained. Flush the actual final
    // PCM file again before publishing the successful evidence marker.
    await syncFile(layout(recordPath).pcm); syncDirectorySync(recordPath);
  }
  const duplicate = await immutable(path.join(attempt.directory, 'end.json'), value);
  return { success: true, attemptId, duplicate, captureSucceeded: value.success, audioBytes: value.audioBytes };
}

function inspectPcmCaptureEvidence(recordPath, { recovery = false } = {}) {
  const paths = layout(recordPath), pcm = pcmState(paths.pcm), attempts = [], incompleteReservations = [];
  if (directory(paths.root, true)) {
    const entries = fs.readdirSync(paths.root).sort();
    // Creating this root is the first durable sign of required capture intent.
    // A failed reservation must not turn into complete microphone-only audio.
    if (!entries.length) incompleteReservations.push({ name: null, files: [] });
    for (const attemptId of entries) {
      if (attemptId.endsWith('.tmp')) {
        const staging = path.join(paths.root, attemptId);
        directory(staging);
        const files = fs.readdirSync(staging).sort().map(name => {
          const file = path.join(staging, name), found = stat(file);
          if (!found?.isFile() || found.isSymbolicLink() || found.size > 16384) throw invalid('unsafe incomplete reservation evidence');
          return { name, size: found.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
        });
        incompleteReservations.push({ name: attemptId, files });
        continue;
      }
      attempts.push(readAttempt(recordPath, id(attemptId)));
    }
  }
  attempts.sort((a, b) => a.manifest.requestedAt.localeCompare(b.manifest.requestedAt) || a.attemptId.localeCompare(b.attemptId));
  const warnings = [], blockingIssues = [];
  for (const reservation of incompleteReservations) {
    const issue = { kind: 'capture-reservation-interrupted', reservation: reservation.name, required: true };
    warnings.push(issue);
    if (!recovery) blockingIssues.push(issue);
  }
  for (const attempt of attempts) {
    const issues = [];
    if (!attempt.end) issues.push('capture-interrupted');
    if (attempt.failure || attempt.end?.success === false) issues.push('capture-failed');
    if (attempt.end && (!attempt.end.childClosed || !attempt.end.diskDrained)) issues.push('capture-not-drained');
    if (!attempt.events['first-data']) issues.push('capture-has-no-data-evidence');
    if (!pcm.exists || pcm.bytes <= attempt.manifest.appendStartBytes) issues.push('required-pcm-missing');
    if (!pcm.sampleAligned) issues.push('pcm-has-partial-sample');
    if (attempt.end && pcm.bytes < attempt.end.pcmEndBytes) issues.push('pcm-shorter-than-capture-receipt');
    attempt.issues = issues;
    attempt.complete = !!attempt.end?.success && issues.length === 0;
    attempt.interrupted = !attempt.end || !attempt.end.childClosed || !attempt.end.diskDrained;
    for (const kind of issues) {
      const issue = { kind, attemptId: attempt.attemptId, required: attempt.manifest.required };
      warnings.push(issue);
      if (attempt.manifest.required && !recovery) blockingIssues.push(issue);
    }
  }
  return { attempts, incompleteReservations, pcm, warnings, blockingIssues, canFinalize: blockingIssues.length === 0,
    required: incompleteReservations.length > 0 || attempts.some(attempt => attempt.manifest.required), recovery: !!recovery, timingIsApproximate: true,
    complete: incompleteReservations.length === 0 && attempts.every(attempt => attempt.complete) };
}

function pcmEvidenceFingerprint(recordPath) {
  const inspected = inspectPcmCaptureEvidence(recordPath, { recovery: true });
  const values = inspected.attempts.map(attempt => ({ manifest: attempt.manifest, events: attempt.events,
    failure: attempt.failure, end: attempt.end }));
  return crypto.createHash('sha256').update(JSON.stringify({ attempts: values, incompleteReservations: inspected.incompleteReservations })).digest('hex');
}

module.exports = { beginPcmAttempt, markPcmEvent, recordPcmFailure, endPcmAttempt, inspectPcmCaptureEvidence, pcmEvidenceFingerprint };
