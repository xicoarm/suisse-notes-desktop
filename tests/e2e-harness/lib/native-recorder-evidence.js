'use strict';

const fs = require('fs');
const path = require('path');

// Use native stream identity, never constructor/event order. This diagnostic
// requires a single acquired microphone and does not allow source replacement.
function classifyWitnessRecorders(snapshot, expectedNativeCount = 0) {
  const problems = [];
  const sourceIds = new Set((snapshot.acquisitions || []).flatMap(item => item.sourceTrackIds || []));
  const destinationIds = new Set((snapshot.contexts || []).flatMap(item => item.destinationTrackIds || []));
  const roles = { direct: [], mixed: [], native: [], unknown: [] };
  for (const recorder of snapshot.recorders || []) {
    if (recorder.role === 'direct-witness') roles.direct.push(recorder);
    else if (recorder.role !== 'actual-application' || !recorder.trackIds?.length) roles.unknown.push(recorder);
    else if (recorder.trackIds.every(id => destinationIds.has(id))) roles.mixed.push(recorder);
    else if (recorder.trackIds.every(id => sourceIds.has(id))) roles.native.push(recorder);
    else roles.unknown.push(recorder);
  }
  if (roles.direct.length !== 1) problems.push('Expected exactly one independent direct witness');
  if (roles.mixed.length !== 1) problems.push('Expected exactly one actual live-mix recorder');
  if (roles.native.length !== expectedNativeCount) problems.push(`Expected ${expectedNativeCount} native archive recorders, observed ${roles.native.length}`);
  if (roles.unknown.length) problems.push('Unclassified application recorder observed');
  return { problems, direct: roles.direct[0] || null, mixed: roles.mixed[0] || null, native: roles.native };
}

function legacyChunkFiles(recordingDir) {
  const directories = [path.join(recordingDir, 'chunks')];
  const batches = path.join(recordingDir, 'source-chunks');
  if (fs.existsSync(batches)) {
    for (const entry of fs.readdirSync(batches, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) throw new Error('Unexpected live-mix source batch');
      directories.push(path.join(batches, entry.name));
    }
  }
  const chunks = [];
  for (const directory of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.endsWith('.tmp')) continue;
      const match = /^chunk_(0|[1-9]\d*)\.webm$/.exec(entry.name);
      if (!match || !entry.isFile()) throw new Error('Unexpected live-mix original chunk');
      chunks.push({ index: Number(match[1]), file: path.join(directory, entry.name) });
    }
  }
  chunks.sort((a, b) => a.index - b.index);
  if (!chunks.length || chunks.some((chunk, index) => chunk.index !== index)) throw new Error('Live-mix original chunks have a missing or duplicate index');
  return chunks;
}

// Installed before the app constructs any recorder. Current application source
// and mix handlers are ondataavailable properties assigned before start().
// Wrap those handlers so Blob identity is tagged before its writer converts it.
function installRecordingRoleObserver({ delayRole = null, delayMs = 14000 } = {}) {
  if (window.__recordingRoleEvidence) throw new Error('Recorder role observer already installed');
  const OriginalContext = window.AudioContext;
  const originalWebkit = window.webkitAudioContext;
  const originalStart = MediaRecorder.prototype.start;
  const originalArrayBuffer = Blob.prototype.arrayBuffer;
  const destinations = new Set(), records = [], blobs = new WeakMap();
  const fault = { kind: 'blob-conversion-delay', targetRole: delayRole, requestedMs: delayMs,
    injected: false, recorderId: null, startedAt: null, completedAt: null, samples: [] };
  const WrappedContext = new Proxy(OriginalContext, { construct(target, args, newTarget) {
    const context = Reflect.construct(target, args, newTarget);
    const createDestination = context.createMediaStreamDestination;
    context.createMediaStreamDestination = function (...args) {
      const destination = Reflect.apply(createDestination, this, args);
      destination.stream.getAudioTracks().forEach(track => destinations.add(track.id));
      return destination;
    };
    return context;
  } });
  window.AudioContext = WrappedContext;
  if (originalWebkit === OriginalContext) window.webkitAudioContext = WrappedContext;
  const snapshot = () => ({ at: performance.now(), fault: { ...fault, samples: [...fault.samples] },
    records: records.map(entry => ({ id: entry.id, role: entry.role, trackIds: [...entry.trackIds],
      startCalledAt: entry.startCalledAt, startedAt: entry.startedAt, stoppedAt: entry.stoppedAt,
      timesliceMs: entry.timesliceMs, events: entry.events, bytes: entry.bytes, emptyEvents: entry.emptyEvents,
      convertedBytes: entry.convertedBytes, conversionCalls: entry.conversionCalls, state: entry.ref.state })) });
  MediaRecorder.prototype.start = function (...args) {
    const tracks = this.stream.getAudioTracks().map(track => track.id);
    if (tracks.length !== 1) throw new Error('Synthetic short capture requires one audio track per recorder');
    const role = tracks.every(id => destinations.has(id)) ? 'live-mix' : 'native-input';
    const entry = { ref: this, id: records.length + 1, role, trackIds: tracks, startCalledAt: performance.now(),
      startedAt: null, stoppedAt: null, timesliceMs: args[0], events: 0, bytes: 0, emptyEvents: 0, convertedBytes: 0, conversionCalls: 0 };
    records.push(entry);
    const dataHandler = this.ondataavailable;
    if (typeof dataHandler !== 'function') throw new Error('Expected application data handler before native recorder start');
    this.ondataavailable = function (event) {
      blobs.set(event.data, entry);
      entry.events++; entry.bytes += event.data.size;
      if (!event.data.size) entry.emptyEvents++;
      return Reflect.apply(dataHandler, this, [event]);
    };
    this.addEventListener('start', event => { entry.startedAt = event.timeStamp; });
    this.addEventListener('stop', event => { entry.stoppedAt = event.timeStamp; });
    return Reflect.apply(originalStart, this, args);
  };
  Blob.prototype.arrayBuffer = async function (...args) {
    const owner = blobs.get(this);
    if (owner && delayRole === owner.role && !fault.injected && this.size > 0) {
      fault.injected = true; fault.recorderId = owner.id; fault.startedAt = performance.now();
      await new Promise(resolve => setTimeout(resolve, delayMs));
      fault.completedAt = performance.now();
    }
    const result = await Reflect.apply(originalArrayBuffer, this, args);
    if (owner) { owner.convertedBytes += result.byteLength; owner.conversionCalls++; }
    return result;
  };
  window.__recordingRoleEvidence = { snapshot,
    sampleFault: () => {
      if (fault.injected && fault.completedAt === null && fault.samples.length < 30) {
        const entry = records.find(item => item.id === fault.recorderId);
        fault.samples.push({ at: performance.now(), recorderId: entry.id, events: entry.events,
          bytes: entry.bytes, convertedBytes: entry.convertedBytes, pendingBlobBytes: entry.bytes - entry.convertedBytes });
      }
      return snapshot();
    },
    dispose: () => {
      MediaRecorder.prototype.start = originalStart;
      Blob.prototype.arrayBuffer = originalArrayBuffer;
      window.AudioContext = OriginalContext;
      if (originalWebkit === OriginalContext) window.webkitAudioContext = originalWebkit;
    },
  };
}

module.exports = { classifyWitnessRecorders, legacyChunkFiles, installRecordingRoleObserver };
