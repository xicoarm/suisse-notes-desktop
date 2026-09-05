/** Strict, real-time coded endurance. A shortened smoke run is never a 5h pass. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { AppDriver, sleep } = require('./lib/app-driver');
const { startMockBackend } = require('./lib/mock-backend');
const { buildCodedScenario, WORK_DIR } = require('./lib/audio');
const { verifyCodedAudio } = require('./lib/coded-audio');
const { inspectNativeSources } = require('../../src-electron/native-source-persistence');
const { concatenateFiles } = require('../../src-electron/durable-files');
const { estimateEncodedBytes } = require('../../src-electron/native-source-finalization');

const DEFAULT_SECONDS = 5 * 3600 + 5 * 60;
const ROTATION_SECONDS = 4 * 3600 + 55 * 60;
const SAMPLE_SECONDS = 30;
const HEADROOM_BYTES = 1024 ** 3;
const CRITICAL_FREE_BYTES = 512 * 1024 ** 2;
const METADATA_RESERVE_BYTES = 64 * 1024 ** 2;
const ENCODED_SOURCE_BYTES_PER_SECOND = 256000 / 8;
// One sample interval plus the existing maximum stop-request wait. This only
// reserves disk; it does not extend recording duration or oracle tolerances.
const STOP_TAIL_SECONDS = SAMPLE_SECONDS + 60;
const SOURCE_BOUNDARY_TOLERANCE_S = 1.5;
const SOURCE_CLOCK_TOLERANCE_S = 1.5;
const MAX_SOURCE_ACQUISITION_S = 10;

function diskBudget(seconds, nativeSources = false, { fastPlan = false } = {}) {
  if (fastPlan && !nativeSources) throw new Error('Fast endurance budget requires native sources');
  return { referenceBytes: (seconds + 25) * 48000 * 2 + 44,
    encodedCopiesBytes: Math.ceil(seconds * 256000 / 8) * 3, headroomBytes: HEADROOM_BYTES,
    ...(nativeSources ? { nativeExtraCopiesBytes: Math.ceil(seconds * 256000 / 8) * 2,
      ...(fastPlan ? { nativeStopTailBytes: STOP_TAIL_SECONDS * ENCODED_SOURCE_BYTES_PER_SECOND * 5 }
        : { nativeLosslessFallbackBytes: seconds * 48000 * 2 * 3 * 2 }),
      nativeMetadataReserveBytes: METADATA_RESERVE_BYTES } : {}) };
}

function nativeEnduranceReserve({ elapsedSeconds, nativeBytes, mixedBytes, nativeAcknowledgedBytes, mixedAcknowledgedBytes }) {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 ||
      [nativeBytes, mixedBytes, nativeAcknowledgedBytes, mixedAcknowledgedBytes].some(bytes => !Number.isSafeInteger(bytes) || bytes < 0) ||
      nativeAcknowledgedBytes > nativeBytes || mixedAcknowledgedBytes > mixedBytes) throw new Error('Invalid native endurance storage evidence');
  const tailRate = bytes => Math.max(ENCODED_SOURCE_BYTES_PER_SECOND, bytes / Math.max(1, elapsedSeconds));
  // M+N acknowledged originals already consume available disk. Reserve only
  // unconfirmed originals, two additional N joins, and one final output F.
  // Final publication is rename-only; mock upload and oracle PCM are streamed.
  const allocations = {
    pendingOriginalBytes: nativeBytes - nativeAcknowledgedBytes + mixedBytes - mixedAcknowledgedBytes,
    nativeJoinBytes: nativeBytes * 2,
    finalBytes: estimateEncodedBytes(elapsedSeconds + STOP_TAIL_SECONDS),
    // Future native tail exists in originals and both joins; mixed tail once.
    stopTailBytes: Math.ceil(STOP_TAIL_SECONDS * (tailRate(nativeBytes) * 3 + tailRate(mixedBytes))),
    metadataReserveBytes: METADATA_RESERVE_BYTES, headroomBytes: CRITICAL_FREE_BYTES,
  };
  const requiredBytes = Object.values(allocations).reduce((total, bytes) => total + bytes, 0);
  if (!Number.isSafeInteger(requiredBytes)) throw new Error('Native endurance reserve exceeds its safe bound');
  return { ...allocations, retainedOriginalBytes: nativeAcknowledgedBytes + mixedAcknowledgedBytes, requiredBytes, stopTailSeconds: STOP_TAIL_SECONDS };
}

function assertNativeEnduranceSpace(available, reserve) {
  if (!Number.isSafeInteger(available) || available < 0 || !Number.isSafeInteger(reserve?.requiredBytes) || reserve.requiredBytes < 0) {
    throw new Error('Invalid native endurance free-space evidence');
  }
  if (available < reserve.requiredBytes) throw Object.assign(new Error('Insufficient native endurance remaining space; sources retained without finalization'),
    { code: 'ENOSPC', availableBytes: available, requiredBytes: reserve.requiredBytes });
}

// This assertion is deliberately stricter than production's <=5s start and
// <=one epoch per kind. A successful s13 is exactly one early native mic and
// no PCM, so its ONE-lane finalizer cannot enter the two-lane FLAC fallback.
// Inspect only bounded metadata and directory entries, never every old chunk.
function assertNativeEnduranceFastPlan(recordingDir, source) {
  const fail = message => { throw new Error('Native endurance fast plan: ' + message + '; sources retained without finalization'); };
  for (const name of ['system_audio.raw', 'pcm-capture-attempts']) {
    try { fs.lstatSync(path.join(recordingDir, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    fail('unexpected system PCM or capture intent');
  }
  if (!source || !/^[0-9a-f-]{36}$/.test(source.sourceId) || source.kind !== 'microphone' ||
      !Number.isFinite(source.startOffsetMs) || source.startOffsetMs < 0 || source.startOffsetMs > 25) fail('expected one early microphone source');
  const nativeDir = path.join(recordingDir, 'native-sources');
  const entries = fs.readdirSync(nativeDir, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== source.sourceId || !entries[0].isDirectory()) fail('source inventory changed');
  const readMarker = name => {
    const file = path.join(nativeDir, source.sourceId, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) fail('invalid source metadata');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const manifest = readMarker('manifest.json'), started = readMarker('started.json');
  if (manifest.version !== 1 || manifest.sourceId !== source.sourceId || manifest.kind !== 'microphone' ||
      started.version !== 1 || started.sourceId !== source.sourceId || started.startOffsetMs !== source.startOffsetMs) fail('source placement changed');
  return { sourceId: source.sourceId, kind: 'microphone', startOffsetMs: source.startOffsetMs, fastPathRequired: true, systemPcmIncluded: false };
}

// Bounded aggregate evidence: no Blob list or repeated O(meeting length)
// renderer snapshots. Like s15, next conversion proves the previous serial
// native save acknowledged; current/latest save remains conservatively pending.
function installNativeEnduranceObserver() {
  if (window.__nativeEnduranceEvidence) throw new Error('Native endurance observer already installed');
  const Context = window.AudioContext, originalWebkit = window.webkitAudioContext;
  const originalStart = MediaRecorder.prototype.start, originalArrayBuffer = Blob.prototype.arrayBuffer;
  const destinations = new Set(), records = [], blobs = new WeakMap(), errors = [];
  const WrappedContext = new Proxy(Context, { construct(target, args, newTarget) {
    const context = Reflect.construct(target, args, newTarget), createDestination = context.createMediaStreamDestination;
    context.createMediaStreamDestination = function (...args) {
      const node = Reflect.apply(createDestination, this, args);
      node.stream.getAudioTracks().forEach(track => destinations.add(track.id));
      return node;
    };
    return context;
  } });
  window.AudioContext = WrappedContext;
  if (originalWebkit === Context) window.webkitAudioContext = WrappedContext;
  MediaRecorder.prototype.start = function (...args) {
    const tracks = this.stream.getAudioTracks().map(track => track.id);
    const acquired = new Set((window.__enduranceConstraints?.acquisitions || []).flatMap(item => item.trackIds));
    const entry = { ref: this, id: records.length + 1, role: tracks.length === 1 && destinations.has(tracks[0]) ? 'live-mix'
      : tracks.length === 1 && acquired.has(tracks[0]) ? 'native-microphone' : 'unknown', trackIds: tracks,
    requestedTimesliceMs: args[0], startCalledAt: performance.now(), startedAt: null, stoppedAt: null,
    events: 0, emptyEvents: 0, bytes: 0, lastDataAt: null, conversionIndex: -1, acknowledgedCount: 0,
    acknowledgedBytes: 0, acknowledgedAt: null, oldestUnconfirmedAt: null };
    records.push(entry);
    const handler = this.ondataavailable;
    if (typeof handler !== 'function') throw new Error('Expected application data handler before endurance recorder start');
    this.ondataavailable = function (event) {
      const at = performance.now(), size = event.data.size;
      if (size) blobs.set(event.data, { entry, index: entry.events - entry.emptyEvents, byteOffset: entry.bytes, at });
      else entry.emptyEvents++;
      entry.events++; entry.bytes += size; entry.lastDataAt = at;
      return Reflect.apply(handler, this, [event]);
    };
    this.addEventListener('start', event => { entry.startedAt = event.timeStamp; });
    this.addEventListener('stop', event => { entry.stoppedAt = event.timeStamp; });
    return Reflect.apply(originalStart, this, args);
  };
  Blob.prototype.arrayBuffer = function (...args) {
    const item = blobs.get(this);
    if (item) {
      const { entry, index } = item;
      if ((index > entry.conversionIndex + 1 || index < entry.conversionIndex) && errors.length < 10) errors.push('Non-serial endurance source conversion');
      if (index === entry.conversionIndex + 1) {
        entry.conversionIndex = index; entry.acknowledgedCount = index; entry.acknowledgedBytes = item.byteOffset;
        entry.oldestUnconfirmedAt = item.at;
        if (index > 0) entry.acknowledgedAt = performance.now();
      }
    }
    return Reflect.apply(originalArrayBuffer, this, args);
  };
  window.__nativeEnduranceEvidence = { snapshot: () => ({ at: performance.now(), errors: [...errors],
    acknowledgementBasis: 'Lower bound from next serial Blob conversion; not the exact latest save acknowledgement.',
    records: records.map(({ ref, ...entry }) => ({ ...entry, trackIds: [...entry.trackIds], state: ref.state })) }) };
}

function enduranceRecorderRoles(evidence, acquisitions, stopped = false) {
  const native = evidence?.records?.filter(record => record.role === 'native-microphone') || [];
  const mixed = evidence?.records?.filter(record => record.role === 'live-mix') || [];
  if (evidence?.errors?.length || evidence?.records?.length !== 2 || native.length !== 1 || mixed.length !== 1 ||
      acquisitions?.length !== 1 || acquisitions[0].trackIds?.length !== 1 || native[0].trackIds[0] !== acquisitions[0].trackIds[0]) {
    throw new Error('Native endurance requires exactly one microphone epoch, one acquired track and one live mix');
  }
  if (evidence.records.some(record => record.requestedTimesliceMs !== 1000 || !Number.isFinite(record.startCalledAt) ||
      record.state !== (stopped ? 'inactive' : 'recording') || (stopped && (!Number.isFinite(record.startedAt) || !Number.isFinite(record.stoppedAt))))) {
    throw new Error('Unexpected native endurance recorder lifecycle or timeslice');
  }
  return { native: native[0], mixed: mixed[0] };
}

// Hash each new committed chunk once while recording, appending a compact ledger
// instead of re-reading the whole archive every thirty seconds. Rehash all bytes
// after stop to establish custody through rotation, finalization and upload.
function createNativeEnduranceLedger(recordingDir, manifestPath) {
  const root = path.resolve(WORK_DIR), resolved = path.resolve(recordingDir);
  if (!resolved.startsWith(root + path.sep) || !path.resolve(manifestPath).startsWith(root + path.sep)) throw new Error('Native endurance evidence must stay in the synthetic workspace');
  const fd = fs.openSync(manifestPath, 'wx'), chunks = [], prefixBytes = [0];
  let descriptor = null, metadata = null, closed = false, lastMtimeMs = null, lastProgressAt = null;
  const fingerprint = async filename => ({ relativePath: path.relative(recordingDir, filename).replaceAll('\\', '/'),
    bytes: fs.statSync(filename).size, sha256: await sha256(filename) });
  const inventory = () => fs.readdirSync(path.join(recordingDir, 'native-sources')).filter(name => !name.endsWith('.tmp'));
  return {
    async sample(recorder, rendererAt, observedAt) {
      if (!descriptor) {
        const sources = inspectNativeSources(recordingDir);
        if (sources.length !== 1 || sources[0].kind !== 'microphone' || !sources[0].started || !sources[0].interrupted ||
            sources[0].startOffsetMs < 0 || sources[0].startOffsetMs > 25) throw new Error('Native endurance has no unambiguous initial microphone source');
        descriptor = sources[0];
        metadata = await Promise.all([descriptor.manifestPath, descriptor.startedPath].map(fingerprint));
        fs.writeSync(fd, JSON.stringify({ type: 'source', sourceId: descriptor.sourceId, kind: descriptor.kind,
          startOffsetMs: descriptor.startOffsetMs, metadata }) + '\n');
        lastProgressAt = observedAt;
      }
      if (JSON.stringify(inventory()) !== JSON.stringify([descriptor.sourceId])) throw new Error('Native source inventory changed during endurance');
      assertNativeEnduranceFastPlan(recordingDir, descriptor);
      let added = 0;
      for (;;) {
        const index = chunks.length, filename = path.join(descriptor.directory, 'chunks', `chunk_${index}.webm`);
        let stat;
        try { stat = fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error('Invalid native endurance chunk');
        const chunk = { type: 'chunk', sourceId: descriptor.sourceId, index, ...(await fingerprint(filename)) };
        chunks.push(chunk); prefixBytes.push(prefixBytes.at(-1) + chunk.bytes);
        lastMtimeMs = stat.mtimeMs; added++;
        fs.writeSync(fd, JSON.stringify(chunk) + '\n');
      }
      if (added) lastProgressAt = observedAt;
      fs.fsyncSync(fd);
      if (!Number.isSafeInteger(recorder.acknowledgedCount) || recorder.acknowledgedCount < 0 || recorder.acknowledgedCount > chunks.length ||
          prefixBytes[recorder.acknowledgedCount] !== recorder.acknowledgedBytes) throw new Error('Native acknowledged prefix is missing or differs from its durable source');
      return { sourceId: descriptor.sourceId, kind: descriptor.kind, startOffsetMs: descriptor.startOffsetMs,
        committedCount: chunks.length, committedBytes: prefixBytes.at(-1), added, lastDurableMtimeMs: lastMtimeMs,
        durableAgeS: lastMtimeMs === null ? null : Math.max(0, (Date.now() - lastMtimeMs) / 1000),
        observedNoProgressS: Math.max(0, (observedAt - lastProgressAt) / 1000),
        nativeEvents: recorder.events, nonemptyEvents: recorder.events - recorder.emptyEvents, nativeBytes: recorder.bytes,
        eventAgeS: recorder.lastDataAt === null ? null : Math.max(0, (rendererAt - recorder.lastDataAt) / 1000),
        acknowledgedCount: recorder.acknowledgedCount, acknowledgedBytes: recorder.acknowledgedBytes,
        acknowledgedObservationAgeS: recorder.acknowledgedAt === null ? null : Math.max(0, (rendererAt - recorder.acknowledgedAt) / 1000),
        unconfirmedBytes: recorder.bytes - recorder.acknowledgedBytes,
        unconfirmedCount: recorder.events - recorder.emptyEvents - recorder.acknowledgedCount,
        oldestUnconfirmedAgeS: recorder.oldestUnconfirmedAt === null ? null : Math.max(0, (rendererAt - recorder.oldestUnconfirmedAt) / 1000) };
    },
    async verify(recorder) {
      const sources = inspectNativeSources(recordingDir);
      if (!descriptor || sources.length !== 1 || sources[0].sourceId !== descriptor.sourceId || !sources[0].complete) throw new Error('Native endurance source did not close completely');
      const source = sources[0], problems = [];
      const currentMetadata = await Promise.all([source.manifestPath, source.startedPath].map(fingerprint));
      if (JSON.stringify(currentMetadata) !== JSON.stringify(metadata)) problems.push('Native source start metadata changed during endurance');
      const retainedPath = manifestPath.replace(/\.jsonl$/, '-retained.jsonl');
      const retainedFd = fs.openSync(retainedPath, 'wx');
      let totalBytes = 0;
      try {
        for (let index = 0; index < source.chunkPaths.length; index++) {
          const current = { type: 'chunk', sourceId: source.sourceId, index, ...(await fingerprint(source.chunkPaths[index])) };
          if (chunks[index] && JSON.stringify(current) !== JSON.stringify(chunks[index]) && problems.length < 20) problems.push('Previously observed native source changed: ' + source.sourceId + '/' + index);
          totalBytes += current.bytes;
          fs.writeSync(retainedFd, JSON.stringify(current) + '\n');
        }
        fs.fsyncSync(retainedFd);
      } finally { fs.closeSync(retainedFd); }
      if (source.chunkCount < chunks.length) problems.push('Previously observed native source chunks disappeared');
      if (source.chunkCount !== recorder.events - recorder.emptyEvents || totalBytes !== recorder.bytes) problems.push('Native source final bytes/count differ from recorder events');
      return { sourceId: source.sourceId, kind: source.kind, startOffsetMs: source.startOffsetMs,
        chunkPaths: source.chunkPaths, chunkCount: source.chunkCount, bytes: totalBytes, observedDuringCaptureCount: chunks.length,
        metadata: currentMetadata, terminal: await fingerprint(source.endPath), manifestPath, manifestSha256: await sha256(manifestPath),
        retainedPath, retainedSha256: await sha256(retainedPath), problems };
    },
    assertFastPlan() { return assertNativeEnduranceFastPlan(recordingDir, descriptor); },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } },
  };
}

function assessNativeEndurancePreservation(source, final, startOffsetS = 0) {
  const problems = [];
  if (![source?.firstFrame, source?.lastFrame, final?.firstFrame, final?.lastFrame].every(Number.isInteger) ||
      ![source?.sourceOffsetS, final?.sourceOffsetS].every(Number.isFinite) || source.lastFrame - source.firstFrame < 4) {
    return { problems: ['NATIVE PRESERVATION: missing source/final numbered evidence'] };
  }
  if (!source.pass || !final.pass) problems.push('NATIVE PRESERVATION: source and final must independently pass coded continuity');
  const requiredFirstInteriorId = source.firstFrame + 1, requiredLastInteriorId = source.lastFrame - 1;
  if (final.firstFrame > requiredFirstInteriorId || final.lastFrame < requiredLastInteriorId) problems.push('NATIVE PRESERVATION: final omits durable native interior identities');
  const placementErrorS = Math.abs(source.sourceOffsetS - final.sourceOffsetS - startOffsetS);
  if (placementErrorS > SOURCE_CLOCK_TOLERANCE_S) problems.push('NATIVE PRESERVATION: source/final active-clock placement changed');
  return { requiredFirstInteriorId, requiredLastInteriorId, placementErrorS, clockToleranceS: SOURCE_CLOCK_TOLERANCE_S, problems };
}

function assessNativeEnduranceAssembly(receipt, plan, sourceId) {
  const singleSource = ids => Array.isArray(ids) && ids.length === 1 && ids[0] === sourceId;
  const problems = [];
  if (receipt?.version !== 3 || receipt.sourceMode !== 'native' || receipt.recovered !== false ||
      receipt.systemPcmIncluded !== false || !singleSource(receipt.sourceIds)) problems.push('Native endurance lacks a complete normal-stop v3 source receipt');
  if (plan?.version !== 1 || plan.recovery !== false || plan.codecPolicy !== 'opus-cbr-192k-20ms-reencoded-from-native-sources' ||
      plan.systemPcmIncluded !== false || !singleSource(plan.sourceIds) || plan.onsetIsApproximate !== true) {
    problems.push('Native endurance lacks the explicit native-source re-encoding policy');
  }
  if (plan?.fastPathUsed !== true) problems.push('Native endurance unexpectedly required general finalization');
  return problems;
}

function availableBytes(directory) {
  const stats = fs.statfsSync(directory);
  return stats.bavail * stats.bsize;
}

function resolveEnduranceSeconds(value = process.env.SUISSE_ENDURANCE_SECONDS) {
  const seconds = value === undefined ? DEFAULT_SECONDS : Number(value);
  if (!Number.isInteger(seconds) || seconds < 45 || seconds > 20000) throw new Error('Endurance seconds must be an explicit integer between 45 and 20000');
  return seconds;
}

async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

/** Bounded multipart reader: retains a delimiter/header, never the audio body. */
function createMultipartHasher(contentType) {
  const match = contentType?.match(/boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i);
  const boundary = match?.[1] || match?.[2];
  if (!boundary || boundary.length > 200) throw new Error('Invalid multipart boundary');
  const opening = Buffer.from('--' + boundary + '\r\n');
  const delimiter = Buffer.from('\r\n--' + boundary);
  const hash = crypto.createHash('sha256');
  let pending = Buffer.alloc(0), state = 'opening', isFile = false, files = 0, fileBytes = 0, maxBufferedBytes = 0;
  const consume = bytes => { if (isFile) { hash.update(bytes); fileBytes += bytes.length; } };
  return {
    feed(chunk) {
      pending = Buffer.concat([pending, chunk]);
      maxBufferedBytes = Math.max(maxBufferedBytes, pending.length);
      for (;;) {
        if (state === 'opening') {
          if (pending.length < opening.length) return;
          if (!pending.subarray(0, opening.length).equals(opening)) throw new Error('Invalid multipart opening');
          pending = pending.subarray(opening.length); state = 'headers';
        } else if (state === 'headers') {
          const end = pending.indexOf('\r\n\r\n');
          if (end < 0) { if (pending.length > 16384) throw new Error('Multipart headers too large'); return; }
          if (end > 16384) throw new Error('Multipart headers too large');
          isFile = /content-disposition:[^\r\n]*\bfilename=/i.test(pending.subarray(0, end).toString('utf8'));
          if (isFile && ++files > 1) throw new Error('Expected one audio file');
          pending = pending.subarray(end + 4); state = 'body';
        } else if (state === 'body') {
          const end = pending.indexOf(delimiter);
          if (end < 0) {
            const length = Math.max(0, pending.length - delimiter.length + 1);
            consume(pending.subarray(0, length)); pending = pending.subarray(length); return;
          }
          consume(pending.subarray(0, end)); pending = pending.subarray(end + delimiter.length); state = 'boundary';
        } else if (state === 'boundary') {
          if (pending.length < 2) return;
          if (pending.subarray(0, 2).equals(Buffer.from('--'))) { state = 'done'; pending = Buffer.alloc(0); return; }
          if (!pending.subarray(0, 2).equals(Buffer.from('\r\n'))) throw new Error('Invalid multipart separator');
          pending = pending.subarray(2); state = 'headers';
        } else { pending = Buffer.alloc(0); return; }
      }
    },
    finish() {
      if (state !== 'done' || files !== 1 || !fileBytes) throw new Error('Incomplete multipart audio upload');
      return { sha256: hash.digest('hex'), fileSize: fileBytes, maxBufferedBytes };
    },
  };
}

async function startStreamingMockBackend(opts) {
  const mock = await startMockBackend(opts);
  const handlers = mock.server.listeners('request');
  mock.server.removeAllListeners('request');
  mock.server.on('request', (req, res) => {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/api/desktop/upload') {
      for (const handler of handlers) handler.call(mock.server, req, res);
      return;
    }
    void (async () => {
      let bodyBytes = 0;
      try {
        const parser = createMultipartHasher(req.headers['content-type']);
        for await (const chunk of req) { bodyBytes += chunk.length; parser.feed(chunk); }
        const uploaded = parser.finish();
        const audioFileId = 'e2e-endurance-' + crypto.randomUUID();
        mock.state.uploads.set(audioFileId, { ...uploaded, status: 'PROCESSING' });
        mock.state.requests.push({ t: Date.now(), method: req.method, url: '/api/desktop/upload', bodyBytes });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': req.headers.origin || '*', 'Access-Control-Allow-Credentials': 'true' });
        res.end(JSON.stringify({ success: true, audioFileId, transcriptionId: audioFileId, meetingId: audioFileId }));
      } catch (error) {
        mock.state.requests.push({ t: Date.now(), method: req.method, url: '/api/desktop/upload', bodyBytes, error: error.message });
        if (!res.destroyed) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
      }
    })();
  });
  return mock;
}

class EnduranceDriver extends AppDriver {
  async observeRenderer(page) {
    await super.observeRenderer(page);
    // Keep lifecycle/recorder event logs, but replace repeated recursive
    // five-second sampling with this scenario's lean thirty-second sampler.
    const observer = this.rendererListeners.get(page);
    if (observer?.timer) { clearInterval(observer.timer); observer.timer = null; }
  }

  captureDiskProgress() {
    this.assertTestProfile();
    const filename = path.join(this.userDataDir, 'active-recording.json');
    if (!fs.existsSync(filename)) return { active: false };
    const active = JSON.parse(fs.readFileSync(filename, 'utf8')).activeSession;
    if (!active || !/^[a-f0-9-]{36}$/i.test(active.recordId || '')) return { active: false };
    const archive = path.join(this.recordingsDir, active.recordId, 'source-chunks');
    return { active: true, recordId: active.recordId, chunkCount: active.chunkCount, lastChunkAt: active.lastChunkAt,
      sourceBatches: fs.existsSync(archive) ? fs.readdirSync(archive, { withFileTypes: true }).filter(entry => entry.isDirectory()).length : 0 };
  }
}

async function installConstraintEvidence(app, processingDisabled) {
  await app.evalTimed(disabled => {
    const original = navigator.mediaDevices.getUserMedia;
    const evidence = { processingDisabled: disabled, calls: 0, tracks: [], acquisitions: [] };
    window.__enduranceConstraints = evidence;
    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const requested = disabled && constraints?.audio ? { ...constraints, audio: {
        ...(typeof constraints.audio === 'object' ? constraints.audio : {}),
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      } } : constraints;
      const requestedAt = performance.now();
      const stream = await Reflect.apply(original, this, [requested]);
      const receivedAt = performance.now();
      evidence.calls++;
      evidence.tracks = stream.getAudioTracks().map(track => track.getSettings());
      if (constraints?.audio && !constraints.video && !constraints.audio?.mandatory?.chromeMediaSource) {
        evidence.acquisitions.push({ requestedAt, receivedAt, trackIds: stream.getAudioTracks().map(track => track.id) });
      }
      return stream;
    };
  }, processingDisabled);
}

/** The interior oracle alone cannot detect a long silent prefix or suffix. */
function assessSourceCoverage(audio, recorder, acquisitions) {
  const problems = [];
  const result = { problems, boundaryToleranceS: SOURCE_BOUNDARY_TOLERANCE_S,
    clockToleranceS: SOURCE_CLOCK_TOLERANCE_S, maximumAcquisitionS: MAX_SOURCE_ACQUISITION_S };
  if (!Number.isFinite(audio?.sourceOffsetS) || !Number.isInteger(audio?.firstFrame) || !Number.isInteger(audio?.lastFrame) ||
      !Number.isFinite(audio?.durationS) || !Number.isFinite(recorder?.startedAt) ||
      !Number.isFinite(audio?.firstIdentifiedStartS) || !Number.isFinite(audio?.lastIdentifiedEndS) ||
      audio.firstIdentifiedStartS < 0 || audio.lastIdentifiedEndS < audio.firstIdentifiedStartS || audio.lastIdentifiedEndS > audio.durationS) {
    problems.push('SOURCE COVERAGE: missing numbered audio or native recorder timing');
    return result;
  }
  // Use measured positions at each boundary. A whole-recording median offset
  // can hide a silent opening/ending when the source drifts later in the file.
  // Keep that median separately for the existing acquisition-clock diagnostic.
  result.prefixGapS = audio.firstIdentifiedStartS;
  result.suffixGapS = Math.max(0, audio.durationS - audio.lastIdentifiedEndS);
  if (result.prefixGapS > SOURCE_BOUNDARY_TOLERANCE_S) problems.push(`SOURCE COVERAGE: missing ${result.prefixGapS.toFixed(3)}s prefix`);
  if (result.suffixGapS > SOURCE_BOUNDARY_TOLERANCE_S) problems.push(`SOURCE COVERAGE: missing ${result.suffixGapS.toFixed(3)}s suffix`);
  if (!Array.isArray(acquisitions) || acquisitions.length !== 1) {
    problems.push('SOURCE CLOCK: endurance requires exactly one observed native microphone acquisition');
    return result;
  }
  const { requestedAt, receivedAt } = acquisitions[0];
  if (!Number.isFinite(requestedAt) || !Number.isFinite(receivedAt) || receivedAt < requestedAt) {
    problems.push('SOURCE CLOCK: invalid native microphone acquisition timestamps');
    return result;
  }
  result.acquisitionSeconds = (receivedAt - requestedAt) / 1000;
  if (result.acquisitionSeconds > MAX_SOURCE_ACQUISITION_S) problems.push('SOURCE CLOCK: native acquisition exceeded the bounded ten-second clock interval');
  // Native capture can begin while getUserMedia is settling. Preserve that
  // measured interval instead of assuming the exact first sample coincides
  // with promise resolution; the extra tolerance is explicit and bounded.
  result.sourceOffsetRangeS = [(recorder.startedAt - receivedAt) / 1000, (recorder.startedAt - requestedAt) / 1000];
  result.sourceClockErrorS = Math.max(0, result.sourceOffsetRangeS[0] - audio.sourceOffsetS, audio.sourceOffsetS - result.sourceOffsetRangeS[1]);
  if (result.sourceClockErrorS > SOURCE_CLOCK_TOLERANCE_S) problems.push(`SOURCE CLOCK: decoded numbering is ${result.sourceClockErrorS.toFixed(3)}s outside native acquisition timing`);
  return result;
}

async function verifyRetainedSources(recordingDir, expectedBytes, expectedEvents, manifestPath) {
  const archive = path.join(recordingDir, 'source-chunks');
  const archived = fs.existsSync(archive) ? fs.readdirSync(archive, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort((a, b) => Number(a) - Number(b)) : [];
  const batches = archived.map(batch => ({ batch, folder: path.join(archive, batch) }));
  // Native finalization retains the final live-mix batch in chunks/. Include it
  // separately without pretending it was another natural rotation.
  const activeFolder = path.join(recordingDir, 'chunks');
  const activeBatchRetained = fs.existsSync(activeFolder) && fs.readdirSync(activeFolder).some(name => /^chunk_\d+\.webm$/.test(name));
  if (activeBatchRetained) batches.push({ batch: 'active', folder: activeFolder });
  let count = 0, bytes = 0, lastIndex = -1;
  const problems = [];
  const fd = fs.openSync(manifestPath, 'wx');
  try {
    for (const { batch, folder } of batches) {
      const files = fs.readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() && /^chunk_\d+\.webm$/.test(entry.name))
        .map(entry => entry.name).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
      for (const file of files) {
        const index = Number(file.match(/\d+/)[0]);
        if (index !== lastIndex + 1 && problems.length < 20) problems.push(`Retained chunk index ${index} follows ${lastIndex}`);
        lastIndex = index;
        const size = fs.statSync(path.join(folder, file)).size;
        count++; bytes += size;
        fs.writeSync(fd, JSON.stringify({ batch, index, relativePath: path.relative(recordingDir, path.join(folder, file)).replaceAll('\\', '/'),
          bytes: size, sha256: await sha256(path.join(folder, file)) }) + '\n');
      }
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (bytes !== expectedBytes) problems.push(`Original sources contain ${bytes} bytes, recorder emitted ${expectedBytes}`);
  if (count !== expectedEvents) problems.push(`Original sources contain ${count} chunks, recorder emitted ${expectedEvents} nonempty events`);
  return { count, bytes, batches: batches.length, archivedBatches: archived.length, activeBatchRetained,
    firstBatch: batches[0]?.batch, lastBatch: batches.at(-1)?.batch, manifestPath, manifestSha256: await sha256(manifestPath), problems };
}

async function runCodedEndurance(opts = {}) {
  const seconds = resolveEnduranceSeconds(opts.seconds);
  const appDir = opts.appDir || process.env.SUISSE_E2E_APP_DIR;
  if (!appDir) throw new Error('Endurance requires a prebuilt app via SUISSE_E2E_APP_DIR; dev/HMR builds are not qualified');
  if (process.env.VITE_SUISSE_MAX_DURATION_SECONDS) throw new Error('Remove the accelerated rotation override before endurance qualification');
  const processingDisabled = opts.processingDisabled ?? process.env.SUISSE_ENDURANCE_PROCESSING_DISABLED === '1';
  const name = 's13-coded-endurance-' + seconds + 's-' + Date.now();
  const evidenceDir = path.join(WORK_DIR, 'qualification', name);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const summaryPath = path.join(evidenceDir, 'summary.json');
  const progressPath = path.join(evidenceDir, 'progress.jsonl');
  const progressFd = fs.openSync(progressPath, 'wx');
  const result = { name, pass: false, completed: false, fiveHourQualificationPassed: false, requestedSeconds: seconds,
    runKind: seconds < DEFAULT_SECONDS ? 'shortened-smoke' : 'full-duration', processingDisabled,
    productionBackendQualified: false, problems: [], problemCount: 0, notes: [
      'Local mock upload success above five hours does not prove production acceptance; the deployed backend has a five-hour limit.',
      'Shortened smoke runs do not qualify five hours; natural rotation is asserted only after crossing 4h55.',
      'Synthetic native microphone capture; physical Bluetooth/USB and macOS system audio are outside this scenario.',
      'Progress metrics are thirty-second snapshots; sampled event/persistence ages do not rule out shorter intervening stalls.',
      'Both decoded boundaries and the native acquisition clock must agree within explicit 1.5-second tolerances; acquisitions longer than ten seconds cannot qualify the source clock.',
    ], metrics: { samples: 0, maxPersistGapS: 0, maxNativeEventGapS: 0, maxRendererHeapMB: null, maxHarnessRssMB: 0,
      minFreeBytes: null, firstRotationElapsedS: null, maxBatchesDuringCapture: 0, phaseCounts: {} }, recentSamples: [], evidenceDir, summaryPath, progressPath };
  let mock = null, app = null, started = null, lastChunkCount = -1, lastPersistObservedAt = null, nativeLedger = null, nativeMode = false;
  const problem = message => { result.problemCount++; if (result.problems.length < 30) result.problems.push(message); };
  const checkpoint = event => {
    if (event) { fs.writeSync(progressFd, JSON.stringify({ recordedAt: new Date().toISOString(), ...event }) + '\n'); fs.fsyncSync(progressFd); }
    fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2));
  };
  try {
    const expectsNative = fs.existsSync(path.join(appDir, 'native-source-persistence.js'));
    const budget = diskBudget(seconds, expectsNative, { fastPlan: expectsNative });
    result.diskPreflight = { ...budget, availableBytes: availableBytes(evidenceDir), requiredBytes: Object.values(budget).reduce((total, size) => total + size, 0) };
    if (result.diskPreflight.availableBytes < result.diskPreflight.requiredBytes) throw new Error('Insufficient free disk space for the synthetic reference, retained encoded copies, and 1 GiB headroom');
    checkpoint({ event: 'preparing-reference', requestedSeconds: seconds });
    const reference = buildCodedScenario(name, [{ type: 'speech', seconds: seconds + 25 }]);
    result.reference = reference.metaPath;
    mock = await startStreamingMockBackend({ port: opts.mockPort || 3000 });
    app = new EnduranceDriver({ name, appDir, apiUrl: mock.url, fakeAudioWav: reference.wavPath,
      env: { SUISSE_TEST_NETWORK_ISOLATION: '1' } });
    await app.launch(); await app.login();
    if (await app.evalTimed(() => window.electronAPI.config.getApiUrl()) !== mock.url) throw new Error('Endurance must use the isolated local backend');
    result.bundle = { gitSha: opts.bundleSha || process.env.SUISSE_E2E_BUNDLE_SHA || null,
      appDirectory: appDir, electronMainSha256: await sha256(path.join(appDir, 'electron-main.js')) };
    nativeMode = await app.evalTimed(() => typeof window.electronAPI.recording.beginSource === 'function');
    result.captureMode = nativeMode ? 'native-sources-v1' : 'legacy-live-mix';
    if (nativeMode) {
      const nativeBudget = diskBudget(seconds, true, { fastPlan: true });
      result.nativeDiskPreflight = { ...nativeBudget, availableBytes: availableBytes(evidenceDir),
        // The reference was already generated; count only remaining allocations.
        requiredRemainingBytes: Object.entries(nativeBudget).filter(([key]) => key !== 'referenceBytes').reduce((total, [, bytes]) => total + bytes, 0) };
      if (result.nativeDiskPreflight.availableBytes < result.nativeDiskPreflight.requiredRemainingBytes) throw new Error('Insufficient native endurance fast-plan scratch/retention space and 1 GiB headroom');
      result.nativeDiskPreflight.plan = 'single-native-microphone-no-pcm';
      result.notes.push('Native mode requires one microphone epoch plus one live mix. Native metadata/chunk custody and lower-bound ACK progress are recorded independently of legacy rotations.');
      result.sourceWriterProvenance = await Promise.all(['src/services/recordingChunkWriter.js', 'src/services/nativeSourceRecorder.js'].map(async filename => ({
        path: filename, sha256: await sha256(path.resolve(__dirname, '../..', filename)),
      })));
    }
    await installConstraintEvidence(app, processingDisabled);
    if (nativeMode) await app.page.evaluate(installNativeEnduranceObserver);
    await app.startRecording();
    result.recordId = await app.getRecordId();
    result.constraintEvidence = await app.evalTimed(() => window.__enduranceConstraints);
    if (nativeMode) nativeLedger = createNativeEnduranceLedger(path.join(app.recordingsDir, result.recordId), path.join(evidenceDir, 'native-observed-manifest.jsonl'));
    if (processingDisabled && (!result.constraintEvidence.tracks.length || result.constraintEvidence.tracks.some(settings =>
      ['echoCancellation', 'noiseSuppression', 'autoGainControl'].some(flag => settings[flag] !== false)))) {
      throw new Error('Processing-disabled control not confirmed by track settings');
    }
    started = performance.now(); lastPersistObservedAt = started;
    checkpoint({ event: 'recording-started', recordId: result.recordId });
    for (;;) {
      const sampledAt = performance.now();
      const renderer = await app.evalTimed(() => {
        const pinia = window.__pinia || document.querySelector('#q-app')?.__vue_app__?.config?.globalProperties?.$pinia;
        const state = pinia?.state?.value?.recording;
        const capture = window.__suisseCaptureDiagnostics?.snapshot();
        return { phase: state?.phase, duration: state?.duration, chunkIndex: state?.chunkIndex, chunkSaveErrors: state?.chunkSaveErrors,
          capture, nativeCapture: window.__nativeEnduranceEvidence?.snapshot() || null,
          heapMB: performance.memory?.usedJSHeapSize ? performance.memory.usedJSHeapSize / 1048576 : null,
          domNodes: document.getElementsByTagName('*').length };
      }, undefined, 10000);
      const disk = app.captureDiskProgress();
      const elapsedS = (sampledAt - started) / 1000;
      const observedNoProgressS = disk.chunkCount !== lastChunkCount ? 0 : (sampledAt - lastPersistObservedAt) / 1000;
      const wallPersistGapS = disk.lastChunkAt ? Math.max(0, (Date.now() - Date.parse(disk.lastChunkAt)) / 1000) : null;
      if (disk.chunkCount !== lastChunkCount) { lastChunkCount = disk.chunkCount; lastPersistObservedAt = sampledAt; }
      const roles = nativeMode ? enduranceRecorderRoles(renderer.nativeCapture, result.constraintEvidence.acquisitions) : null;
      const recorder = roles?.mixed || renderer.capture?.recorders?.at(-1);
      const nativeGapS = recorder?.lastDataAt != null ? Math.max(0, (renderer.capture.at - recorder.lastDataAt) / 1000) : elapsedS;
      const nativeSource = nativeMode ? await nativeLedger.sample(roles.native, renderer.nativeCapture.at, sampledAt) : null;
      const rssMB = process.memoryUsage().rss / 1048576;
      const freeBytes = availableBytes(evidenceDir);
      const nativeReserve = nativeMode ? nativeEnduranceReserve({
        elapsedSeconds: Math.max(elapsedS, (renderer.nativeCapture.at - roles.native.startCalledAt) / 1000),
        nativeBytes: roles.native.bytes, mixedBytes: roles.mixed.bytes,
        nativeAcknowledgedBytes: roles.native.acknowledgedBytes, mixedAcknowledgedBytes: roles.mixed.acknowledgedBytes,
      }) : null;
      const minimumFinalizationFreeBytes = nativeReserve?.requiredBytes ?? CRITICAL_FREE_BYTES + (recorder?.bytes || 0) * 3;
      const sample = { elapsedS, renderer, disk, nativeSource, wallPersistGapS, observedNoProgressS, nativeGapS, harnessRssMB: rssMB, freeBytes, minimumFinalizationFreeBytes, nativeReserve };
      result.metrics.samples++;
      result.metrics.maxPersistGapS = Math.max(result.metrics.maxPersistGapS, wallPersistGapS || 0);
      result.metrics.maxNativeEventGapS = Math.max(result.metrics.maxNativeEventGapS, nativeGapS);
      if (nativeSource) {
        result.metrics.nativeSource ||= { sourceId: nativeSource.sourceId, maxEventAgeS: 0, maxDurableAgeS: 0, maxObservedNoProgressS: 0,
          maxAcknowledgedObservationAgeS: 0, maxUnconfirmedBytes: 0, maxUnconfirmedCount: 0 };
        const metrics = result.metrics.nativeSource;
        metrics.maxEventAgeS = Math.max(metrics.maxEventAgeS, nativeSource.eventAgeS || 0);
        metrics.maxDurableAgeS = Math.max(metrics.maxDurableAgeS, nativeSource.durableAgeS || 0);
        metrics.maxObservedNoProgressS = Math.max(metrics.maxObservedNoProgressS, nativeSource.observedNoProgressS);
        metrics.maxAcknowledgedObservationAgeS = Math.max(metrics.maxAcknowledgedObservationAgeS, nativeSource.acknowledgedObservationAgeS || 0);
        metrics.maxUnconfirmedBytes = Math.max(metrics.maxUnconfirmedBytes, nativeSource.unconfirmedBytes);
        metrics.maxUnconfirmedCount = Math.max(metrics.maxUnconfirmedCount, nativeSource.unconfirmedCount);
        if (elapsedS > 15 && (nativeSource.eventAgeS === null || nativeSource.durableAgeS === null || nativeSource.eventAgeS > 10 || nativeSource.durableAgeS > 10)) {
          problem('Native source event/durable age exceeded ten seconds at an endurance sample');
        }
      }
      result.metrics.maxHarnessRssMB = Math.max(result.metrics.maxHarnessRssMB, rssMB);
      result.metrics.minFreeBytes = Math.min(result.metrics.minFreeBytes ?? freeBytes, freeBytes);
      if (renderer.heapMB !== null) result.metrics.maxRendererHeapMB = Math.max(result.metrics.maxRendererHeapMB || 0, renderer.heapMB);
      result.metrics.phaseCounts[renderer.phase || 'unknown'] = (result.metrics.phaseCounts[renderer.phase || 'unknown'] || 0) + 1;
      result.metrics.maxBatchesDuringCapture = Math.max(result.metrics.maxBatchesDuringCapture, disk.sourceBatches || 0);
      if (disk.sourceBatches && result.metrics.firstRotationElapsedS === null) result.metrics.firstRotationElapsedS = elapsedS;
      result.recentSamples.push(sample); if (result.recentSamples.length > 8) result.recentSamples.shift();
      // Existing child-output diagnostics stay on disk; do not retain hours of
      // duplicate strings in the driver just to print a startup error excerpt.
      if (app.log.length > 200) app.log.splice(0, app.log.length - 200);
      checkpoint({ event: 'progress', ...sample });
      if (renderer.phase !== 'recording') throw new Error('Recording left the active phase before the requested endurance duration: ' + renderer.phase);
      if (nativeMode) assertNativeEnduranceSpace(freeBytes, nativeReserve);
      if (freeBytes < minimumFinalizationFreeBytes) {
        // This is a disposable synthetic profile. Preserve durable sources and
        // stop its process instead of allocating more remux copies on low disk.
        await app.close({ keepProfile: true });
        throw new Error('Synthetic endurance stopped below finalization space plus 512 MiB reserve; sources retained without finalization');
      }
      if (performance.now() - started >= seconds * 1000) break;
      await sleep(Math.min(SAMPLE_SECONDS * 1000, Math.max(1, seconds * 1000 - (performance.now() - started))));
    }
    result.monotonicCaptureSeconds = (performance.now() - started) / 1000;
    if (nativeMode) {
      // Recheck immediately before requesting stop, which itself starts media
      // finalization. A failed guard closes the synthetic process in finally;
      // it must not invoke the normal stop/finalize UI on a different plan.
      const snapshot = await app.evalTimed(() => ({ capture: window.__nativeEnduranceEvidence.snapshot(),
        acquisitions: window.__enduranceConstraints.acquisitions }));
      const roles = enduranceRecorderRoles(snapshot.capture, snapshot.acquisitions);
      const reserve = nativeEnduranceReserve({ elapsedSeconds: Math.max(result.monotonicCaptureSeconds,
        (snapshot.capture.at - roles.native.startCalledAt) / 1000), nativeBytes: roles.native.bytes, mixedBytes: roles.mixed.bytes,
        nativeAcknowledgedBytes: roles.native.acknowledgedBytes, mixedAcknowledgedBytes: roles.mixed.acknowledgedBytes });
      result.nativePreStop = { plan: nativeLedger.assertFastPlan(), reserve, availableBytes: availableBytes(evidenceDir) };
      checkpoint({ event: 'native-pre-stop-guard', ...result.nativePreStop });
      assertNativeEnduranceSpace(result.nativePreStop.availableBytes, reserve);
    }
    checkpoint({ event: 'stopping' });
    await app.stopRecording(60000);
    await app.waitForPhase(['uploaded', 'error'], 30 * 60000);
    result.phase = await app.getPhase();
    if (result.phase !== 'uploaded') problem('Endurance recording did not complete its local mock upload');
    const capture = await app.evalTimed(() => window.__suisseCaptureDiagnostics?.snapshot());
    result.capture = capture;
    const nativeCapture = nativeMode ? await app.evalTimed(() => window.__nativeEnduranceEvidence.snapshot()) : null;
    const roles = nativeMode ? enduranceRecorderRoles(nativeCapture, result.constraintEvidence.acquisitions, true) : null;
    if (nativeMode) result.nativeCapture = nativeCapture;
    const recorder = roles?.native || capture?.recorders?.at(-1);
    if (recorder?.startedAt == null || recorder?.stoppedAt == null) throw new Error('Missing native recorder timing evidence');
    result.expectedDurationS = (recorder.stoppedAt - recorder.startedAt) / 1000;
    if (result.expectedDurationS < seconds - 1.5) problem('Native recording ended before the requested duration');
    if (!nativeMode && capture.recorders.length !== 1) problem('Endurance unexpectedly created multiple MediaRecorders');
    const output = app.findOutputFile();
    if (!output) throw new Error('No final recording; retained profile contains the available source evidence');
    result.output = output;
    checkpoint({ event: 'verifying-audio', output });
    const audio = await verifyCodedAudio(output, reference, { expectedDurationS: result.expectedDurationS, durationToleranceS: 1.5 });
    result.audio = { ...audio, problems: audio.problems.slice(0, 30), problemCount: audio.problems.length };
    for (const issue of audio.problems) problem(issue);
    result.constraintEvidence = await app.evalTimed(() => window.__enduranceConstraints);
    result.sourceCoverage = assessSourceCoverage(audio, recorder, result.constraintEvidence?.acquisitions);
    for (const issue of result.sourceCoverage.problems) problem(issue);
    result.localSha256 = await sha256(output);
    const recordingDir = path.dirname(output);
    const receipt = JSON.parse(fs.readFileSync(path.join(recordingDir, 'upload-receipt.json'), 'utf8'));
    const remote = mock.state.uploads.get(receipt.audioFileId);
    result.upload = { localBytes: fs.statSync(output).size, remoteBytes: remote?.fileSize, remoteSha256: remote?.sha256,
      maxParserBufferedBytes: remote?.maxBufferedBytes, attempts: mock.state.requests.filter(request => request.url === '/api/desktop/upload').length };
    if (remote?.sha256 !== result.localSha256 || remote?.fileSize !== result.upload.localBytes) problem('Streamed multipart audio does not match the final recording');
    if (receipt.canDelete !== false || !fs.existsSync(output)) problem('Endurance local backup was not retained');
    const mixedRecorder = roles?.mixed || recorder;
    result.sources = await verifyRetainedSources(recordingDir, mixedRecorder.bytes, mixedRecorder.events - mixedRecorder.emptyEvents, path.join(evidenceDir, 'source-manifest.jsonl'));
    for (const issue of result.sources.problems) problem(issue);
    if (nativeMode) {
      const { chunkPaths, ...sourceEvidence } = await nativeLedger.verify(roles.native);
      result.nativeSource = sourceEvidence;
      for (const issue of sourceEvidence.problems) problem(issue);
      const finalReceipt = JSON.parse(fs.readFileSync(path.join(recordingDir, 'finalized.json'), 'utf8'));
      const plans = fs.readdirSync(recordingDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('native-finalization-'))
        .map(entry => path.join(recordingDir, entry.name, 'plan.json')).filter(filename => fs.existsSync(filename));
      if (plans.length !== 1) throw new Error('Endurance expected one completed native assembly plan');
      const plan = JSON.parse(fs.readFileSync(plans[0], 'utf8'));
      result.nativeAssembly = { receipt: finalReceipt, planPath: plans[0], planSha256: await sha256(plans[0]),
        codecPolicy: plan.codecPolicy, fastPathUsed: plan.fastPathUsed, sourceIds: plan.sourceIds,
        onsetIsApproximate: plan.onsetIsApproximate, exactDecodedPcmEqualityRequired: false };
      for (const issue of assessNativeEnduranceAssembly(finalReceipt, plan, sourceEvidence.sourceId)) problem(issue);
      if (fs.existsSync(path.join(recordingDir, 'finalization-pending.json')) || finalReceipt.sha256 !== result.localSha256) problem('Native endurance output transaction is not complete');
      const nativeOriginal = path.join(evidenceDir, 'native-original.webm');
      await concatenateFiles(chunkPaths, nativeOriginal);
      result.nativeOriginal = { path: nativeOriginal, sha256: await sha256(nativeOriginal), sourceId: sourceEvidence.sourceId };
      checkpoint({ event: 'verifying-native-source', sourceId: sourceEvidence.sourceId });
      const sourceAudio = await verifyCodedAudio(nativeOriginal, reference, { expectedDurationS: result.expectedDurationS, durationToleranceS: 1.5 });
      result.nativeSourceAudio = { ...sourceAudio, problems: sourceAudio.problems.slice(0, 30), problemCount: sourceAudio.problems.length };
      for (const issue of sourceAudio.problems) problem('Native original: ' + issue);
      result.nativeSourceCoverage = assessSourceCoverage(sourceAudio, roles.native, result.constraintEvidence.acquisitions);
      for (const issue of result.nativeSourceCoverage.problems) problem('Native original: ' + issue);
      result.nativePreservation = assessNativeEndurancePreservation(sourceAudio, audio, sourceEvidence.startOffsetMs / 1000);
      for (const issue of result.nativePreservation.problems) problem(issue);
      result.notes.push('Source and final are independently checked against the same continuous numbered reference; their interior ID ranges and active-clock placement must agree. Concurrent source durations are never added.');
    }
    if (seconds > ROTATION_SECONDS) {
      if (result.metrics.maxBatchesDuringCapture < 1 || result.sources.batches < 2) problem('Natural 4h55 source rotation did not occur before finalization');
      if (result.metrics.firstRotationElapsedS !== null && (result.metrics.firstRotationElapsedS < ROTATION_SECONDS - SAMPLE_SECONDS || result.metrics.firstRotationElapsedS > ROTATION_SECONDS + 90)) {
        problem('Observed source rotation did not match the default 4h55 threshold');
      }
    } else if (result.metrics.maxBatchesDuringCapture > 0) problem('An unexpected accelerated source rotation occurred in a shortened run');
    result.captureWarnings = JSON.parse(fs.readFileSync(path.join(recordingDir, 'metadata.json'), 'utf8')).captureWarnings || [];
    result.completed = true;
    result.pass = result.problemCount === 0;
    result.fiveHourQualificationPassed = result.pass && seconds >= DEFAULT_SECONDS && result.expectedDurationS >= DEFAULT_SECONDS - 1.5;
  } catch (error) { problem(error.stack || error.message); }
  finally {
    result.diagnostics = app?.diagnosticsDir || null; result.profile = app?.userDataDir || null;
    const cleanupFailure = error => { problem('Evidence/cleanup: ' + error.message); result.pass = false; result.fiveHourQualificationPassed = false; };
    try { checkpoint({ event: 'finished', pass: result.pass, completed: result.completed, fiveHourQualificationPassed: result.fiveHourQualificationPassed }); }
    catch (error) { cleanupFailure(error); }
    try {
      if (app) await app.close({ keepProfile: true }).catch(cleanupFailure);
      if (mock) await mock.close().catch(cleanupFailure);
      if (nativeLedger) { try { nativeLedger.close(); } catch (error) { cleanupFailure(error); } }
      checkpoint();
    } finally { fs.closeSync(progressFd); }
  }
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${name}: ${result.runKind}; true 5h05 qualification=${result.fiveHourQualificationPassed}`);
  return result;
}

module.exports = { runCodedEndurance, resolveEnduranceSeconds, createMultipartHasher, startStreamingMockBackend, diskBudget,
  assessSourceCoverage, DEFAULT_SECONDS, ROTATION_SECONDS, installNativeEnduranceObserver, enduranceRecorderRoles,
  createNativeEnduranceLedger, assessNativeEndurancePreservation, assessNativeEnduranceAssembly, verifyRetainedSources,
  assertNativeEnduranceFastPlan, nativeEnduranceReserve, assertNativeEnduranceSpace };
