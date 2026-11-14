'use strict';

const fs = require('fs');
const path = require('path');
const { inspectNativeSources } = require('./native-source-persistence');
const { concatenateFiles, publishFile, writeFileAtomic, syncDirectorySync } = require('./durable-files');
const { inspectEncodedOpus } = require('./encoded-opus-evidence');

const RATE = 48000;
const CHANNELS = 2;
const BIT_RATE = 192000;
const FRAME_DURATION_MS = 20;
const CODEC_POLICY = 'opus-cbr-192k-20ms-reencoded-from-native-sources';

// One zero-valued stereo PCM frame gives fluent-ffmpeg's production progress
// probe a real input. A no-input graph crashes that dependency's metadata hook;
// its lavfi input capability parser also rejects newer FFmpeg device columns.
function silentFrameWav() {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF'); bytes.writeUInt32LE(40, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
const TIMING_TOLERANCE_SAMPLES = 96; // 2 ms: native WebM timestamps have millisecond precision.
const MAX_DURATION_SECONDS = 31 * 24 * 60 * 60;
// The timestamp resampler buffers an entire forward clock gap before it drains
// it. Under -max_alloc 64 MiB that fails from about three minutes of stereo
// audio (ELECTRON-7R). Its sample-order fallback re-inserts gaps of at least
// one second as streamed silence; shorter ones close. Bounded evidence only.
const RESTORE_GAP_MIN_SAMPLES = RATE;
const MAX_RESTORED_GAPS = 64;

function failure(message, code = 'NATIVE_FINALIZATION_INVALID') {
  return Object.assign(new Error(`${message}; original native audio is retained`), { code });
}

// FFmpeg concat lists use shell-like single-quote escaping, also on Windows.
function concatList(files) {
  return files.map(file => "file '" + file.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n');
}

function samples(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DURATION_SECONDS) throw failure('Invalid native audio timeline duration');
  return Math.round(seconds * RATE);
}

// Run before timestamp normalization, after asettb=1/48000. Integer PTS avoids
// ashowinfo's pts_time display losing precision during a five-hour meeting.
// Only counters and a bounded set of examples are retained, never a frame log.
function createTimestampEvidence() {
  let previousEnd = null, restorableOverflow = false;
  const restorable = [];
  const result = { frames: 0, firstPts: null, lastEndPts: null, decodedSamples: 0,
    gapCount: 0, gapSamples: 0, overlapCount: 0, overlapSamples: 0, resamplerFailure: null, examples: [] };
  return {
    consume(line) {
      if (/Failed to compensate for timestamp delta|Cannot allocate memory/.test(String(line))) result.resamplerFailure = String(line).slice(0, 512);
      if (!String(line).includes('ashowinfo')) return;
      const pts = /(?:^|\s)pts:(-?\d+)(?:\s|$)/.exec(line);
      const rate = /(?:^|\s)rate:(\d+)(?:\s|$)/.exec(line);
      const count = /(?:^|\s)nb_samples:(\d+)(?:\s|$)/.exec(line);
      if (!pts || !rate || !count) return;
      const timestamp = Number(pts[1]);
      const sampleRate = Number(rate[1]);
      const frameSamples = Number(count[1]);
      if (!Number.isSafeInteger(timestamp) || sampleRate < 1 || frameSamples < 1) return;
      const duration = frameSamples * RATE / sampleRate;
      if (previousEnd !== null) {
        const difference = timestamp - previousEnd;
        if (Math.abs(difference) > TIMING_TOLERANCE_SAMPLES) {
          const kind = difference > 0 ? 'gap' : 'overlap';
          result[`${kind}Count`]++;
          result[`${kind}Samples`] += Math.abs(difference);
          if (result.examples.length < 100) result.examples.push({ kind, beforePts: previousEnd, afterPts: timestamp, samples: difference });
          // Where this frame lands in a sample-order replay, and where its
          // timestamp places it. Every decoded sample before it precedes it.
          if (difference >= RESTORE_GAP_MIN_SAMPLES) {
            if (restorable.length < MAX_RESTORED_GAPS) restorable.push({ decodedSamples: result.decodedSamples, timelineSample: timestamp - result.firstPts });
            else restorableOverflow = true;
          }
        }
      }
      result.frames++;
      if (result.firstPts === null) result.firstPts = timestamp;
      previousEnd = timestamp + duration;
      result.lastEndPts = previousEnd;
      result.decodedSamples += duration;
    },
    result() { return { ...result, examples: result.examples.map(value => ({ ...value })) }; },
    restorableGaps() { return { gaps: restorable.map(value => ({ ...value })), overflow: restorableOverflow }; },
  };
}

function pcmDescription(recordPath) {
  const file = path.join(recordPath, 'system_audio.raw');
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size % 2 !== 0) throw failure('System PCM is malformed or unsafe');
  return { path: file, bytes: stat.size, samples: stat.size / 2, duration: stat.size / (RATE * 2) };
}

function classifySources(sources, pcm, { recovery = false, requiredKinds = [] } = {}) {
  if (!Array.isArray(requiredKinds) || requiredKinds.some(kind => !['microphone', 'system'].includes(kind))) throw failure('Invalid required source kinds');
  const warnings = [], usable = [];
  for (const source of sources) {
    if (source.gaps.length || source.terminalMismatch) throw failure(`Native source ${source.sourceId} has missing chunks or an inconsistent terminal marker`);
    if (source.interrupted && !recovery) throw failure(`Native source ${source.sourceId} is not durably closed`);
    if (!source.started) {
      warnings.push({ kind: 'native-source-never-started', sourceId: source.sourceId, interrupted: source.interrupted });
      continue;
    }
    if (!source.hasAudio) {
      // Past the checks above, a closed source's end marker durably confirms
      // zero chunks: its recorder never emitted a non-empty blob (e.g. a dead
      // auto-recovery candidate replaced within seconds). Nothing was lost, so
      // it must not block the meeting. Other lanes/epochs still gate below.
      warnings.push({ kind: 'native-source-audio-missing', sourceId: source.sourceId, confirmedEmpty: !source.interrupted });
      continue;
    }
    if (source.interrupted) warnings.push({ kind: 'native-source-interrupted', sourceId: source.sourceId });
    usable.push(source);
  }
  if (pcm && pcm.bytes === 0) {
    if (!recovery) throw failure('System PCM exists but has no saved audio');
    warnings.push({ kind: 'native-system-pcm-empty' });
  }
  const hasPcm = !!pcm && pcm.bytes > 0;
  if (hasPcm && usable.some(source => source.kind === 'system')) throw failure('Both native system audio and AudioTee PCM exist; refusing to include system audio twice');
  for (const kind of requiredKinds) {
    if (!usable.some(source => source.kind === kind) && !(kind === 'system' && hasPcm)) throw failure(`Required ${kind} audio is missing`);
  }
  if (!usable.length && !hasPcm) throw failure('No acknowledged native audio is available to finalize');
  return { usable, warnings, hasPcm };
}

// A stop-call timestamp does not prove the final native sample's time. Preserve
// ordinary stopped/interrupted tails. Only an explicit replacement contract,
// with a successor that actually has saved audio, authorizes a handover cut.
function planLane(epochs, warnings) {
  const ordered = [...epochs].sort((a, b) => a.startSample - b.startSample || a.sourceId.localeCompare(b.sourceId));
  let cursor = 0;
  const segments = [];
  for (let index = 0; index < ordered.length; index++) {
    const epoch = ordered[index], next = ordered[index + 1];
    let count = epoch.mediaSamples;
    if (epoch.reason === 'replacement' && next && epoch.endOffsetMs !== null &&
        Math.abs(samples(epoch.endOffsetMs / 1000) - next.startSample) <= TIMING_TOLERANCE_SAMPLES) {
      const cut = next.startSample - epoch.startSample;
      if (cut < 0) throw failure('Native replacement precedes its predecessor');
      if (count > cut) {
        warnings.push({ kind: 'native-source-handover-cut', sourceId: epoch.sourceId,
          successorSourceId: next.sourceId, trimmedSamples: count - cut, onsetIsApproximate: true });
        count = cut;
      }
    }
    let placement = epoch.startSample;
    if (placement < cursor) {
      const overlap = cursor - placement;
      if (overlap > TIMING_TOLERANCE_SAMPLES) {
        throw failure(`Native ${epoch.kind} source epochs overlap without a confirmed replacement cut`, 'NATIVE_SOURCE_AMBIGUOUS_OVERLAP');
      }
      // Retain every ordinary sample. The small timestamp-rounding adjustment
      // is explicit, rather than silently trimming a preceding source tail.
      warnings.push({ kind: 'native-source-seam-rounding', sourceId: epoch.sourceId, shiftedSamples: overlap });
      placement = cursor;
    }
    if (placement > cursor) segments.push({ kind: 'silence', samples: placement - cursor });
    if (count > 0) segments.push({ kind: 'audio', sourceId: epoch.sourceId, input: epoch.normalizedPath,
      samples: count, originalSamples: epoch.mediaSamples, startSample: placement });
    cursor = placement + count;
  }
  return { segments, samples: cursor };
}

// Hard CBR produces 480 payload bytes per 20-ms packet. Reserve four extra
// packets for encoder delay/flush, 64 bytes per packet for WebM blocks, cues,
// and clusters, and 64 KiB for the fixed header. This is a conservative budget
// for our audio-only muxer, not a universal WebM size bound. Inherited metadata
// and chapters are disabled by opus() below so source tags cannot inflate it.
function estimateEncodedBytes(timelineSeconds = 0) {
  const packetSamples = RATE * FRAME_DURATION_MS / 1000;
  const packets = Math.ceil(samples(timelineSeconds) / packetSamples) + 4;
  const payloadBytes = BIT_RATE * FRAME_DURATION_MS / 8000;
  return packets * (payloadBytes + 64) + 64 * 1024;
}

// Unchanged source concatenations, up to two copies of uncompressed-equivalent
// 24-bit stereo FLAC, bounded-rate Opus/WebM, and a separate scratch reserve.
// Silence FLAC is normally much smaller; the common fast path needs no FLAC.
function estimateScratchBytes({ sourceBytes = 0, timelineSeconds = 0, sourceSeconds = 0, lanes = 2, fastPath = false } = {}) {
  const duration = samples(timelineSeconds) / RATE;
  if (!Number.isFinite(sourceBytes) || sourceBytes < 0 || ![1, 2].includes(lanes)) throw failure('Invalid native scratch estimate');
  const mediaSeconds = samples(sourceSeconds) / RATE;
  return Math.ceil(sourceBytes + (fastPath ? 0 : Math.max(duration * lanes, mediaSeconds) * RATE * CHANNELS * 3 * 2) +
    estimateEncodedBytes(duration) + 64 * 1024 * 1024);
}

function createNativeSourceFinalization({ ffmpeg, run, validate, probe, ffprobePath, checkSpace = async () => {} }) {
  if ([ffmpeg, run, validate, probe, checkSpace].some(value => typeof value !== 'function')) throw new Error('Native finalization dependencies are incomplete');
  if (typeof ffprobePath !== 'string' || !ffprobePath) throw new Error('Native finalization requires a bundled ffprobe path');

  const timeout = seconds => Math.min(45 * 60000, 5 * 60000 + Math.ceil(seconds / 3600) * 10 * 60000);
  async function validDuration(file, container = 'webm') {
    const validation = await validate(file, { container });
    if (!validation?.valid) throw failure(validation?.error || 'Native audio output validation failed');
    const measured = await probe(file);
    const duration = typeof measured === 'number' ? measured : Number(measured?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) throw failure('Native audio decoded to an empty or invalid timeline');
    return duration;
  }
  const lossless = command => command.audioCodec('flac').audioFrequency(RATE).audioChannels(CHANNELS)
    .outputOptions(['-sample_fmt', 's32', '-compression_level', '5', '-threads', '1']);
  // libopus defaults to VBR, which can exceed the nominal bitrate materially.
  // Hard CBR preserves our 192-kbit stereo policy while bounding long-meeting
  // storage/upload size. Keep the default audio application explicit.
  // https://ffmpeg.org/ffmpeg-codecs.html#libopus-1
  const opus = command => command.audioCodec('libopus').audioBitrate(BIT_RATE / 1000).audioFrequency(RATE).audioChannels(CHANNELS)
    .outputOptions(['-threads', '1', '-vbr', 'off', '-frame_duration', String(FRAME_DURATION_MS), '-application', 'audio',
      '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1']);
  const input = file => ffmpeg().input(file).outputOptions(['-nostdin', '-xerror', '-max_alloc', '67108864', '-filter_threads', '1', '-filter_complex_threads', '1']);

  async function build(recordPath, outputPath, options = {}) {
    if (!path.isAbsolute(recordPath) || !path.isAbsolute(outputPath) || path.dirname(path.resolve(outputPath)) !== path.resolve(recordPath) ||
        path.basename(outputPath) === 'audio.webm' || path.extname(outputPath) !== '.webm') {
      throw failure('Native finalization requires a building WebM directly inside its recording directory');
    }
    const sources = inspectNativeSources(recordPath);
    const pcm = pcmDescription(recordPath);
    const { usable, warnings, hasPcm } = classifySources(sources, pcm, options);
    const expectedSamples = samples(Number(options.expectedDurationSec) || 0);
    const scratchDirectory = await fs.promises.mkdtemp(path.join(recordPath, 'native-finalization-'));
    syncDirectorySync(recordPath);
    const normalized = [];
    const sourceEvidence = [];
    const rawPaths = new Map();
    const sourceBytes = usable.reduce((sum, source) => sum + source.chunks.reduce((n, chunk) => n + chunk.size, 0), 0);
    // Keep the one-command path limited to short initial offsets. Long offsets
    // continue through the general planner's streamed silence segments.
    const fastEligible = ['microphone', 'system'].every(kind => usable.filter(source => source.kind === kind).length <= 1) &&
      usable.every(source => source.startOffsetMs <= 5000);
    const knownEndSamples = Math.max(expectedSamples, hasPcm ? pcm.samples : 0, ...usable.map(source =>
      source.endOffsetMs === null ? 0 : samples(source.endOffsetMs / 1000)));
    const estimatedSourceSeconds = usable.reduce((sum, source) => sum + (source.endOffsetMs === null
      ? source.chunks.reduce((n, chunk) => n + chunk.size, 0) / 8000
      : (source.endOffsetMs - source.startOffsetMs) / 1000), 0) + (hasPcm ? pcm.duration : 0);
    const estimatedTimelineSeconds = Math.max(knownEndSamples / RATE, ...usable.filter(source => source.interrupted)
      .map(source => source.startOffsetMs / 1000 + source.chunks.reduce((n, chunk) => n + chunk.size, 0) / 8000));
    const estimatedLanes = Number(usable.some(source => source.kind === 'microphone')) + Number(hasPcm || usable.some(source => source.kind === 'system'));
    const spaceEstimate = fastPath => estimateScratchBytes({ sourceBytes, timelineSeconds: estimatedTimelineSeconds,
      sourceSeconds: estimatedSourceSeconds, lanes: estimatedLanes, fastPath });
    const stereo = 'pan=stereo|c0=FL+FC+0.707*BL+0.707*SL+0.5*LFE|c1=FR+FC+0.707*BR+0.707*SR+0.5*LFE';
    // pan already establishes stereo at unity. The redundant ocl alias was
    // removed from newer FFmpeg; keeping layout negotiation implicit here
    // supports both bundled generations without changing timestamp repair.
    // https://github.com/FFmpeg/FFmpeg/blob/e64a1d2953/libswresample/options.c
    const resample = 'aresample=48000:clev=1:async=1:first_pts=0:min_hard_comp=0.002:max_soft_comp=0';
    const rendered = path.join(scratchDirectory, 'rendered.webm');
    const sourceTimeout = source => timeout(Math.max(options.expectedDurationSec || 0, (source.endOffsetMs || 0) / 1000));
    let silenceInput = null;
    async function renderSilence(segmentPath, count) {
      if (!silenceInput) {
        silenceInput = path.join(scratchDirectory, 'silence-frame.wav');
        await writeFileAtomic(silenceInput, silentFrameWav());
      }
      await run(lossless(input(silenceInput).audioFilters(`apad=whole_len=${count},atrim=end_sample=${count},asetpts=PTS-STARTPTS`))
        .output(segmentPath), timeout(count / RATE), 'Build native timeline segment');
      if (Math.abs(samples(await validDuration(segmentPath, 'flac')) - count) > 1) throw failure('Native timeline segment has an incorrect length');
    }
    // ELECTRON-7R: ONE decode writes every audio piece between restored gaps.
    // Separate outputs drain their split branches together, so no filter has
    // to hold a gap; the concat demuxer then streams silence between pieces.
    async function replayRestoringGaps(source, rawPath, normalizedPath, filters, gaps, evidence) {
      const pieces = [...gaps.map((gap, index) => ({ start: index ? gaps[index - 1].atSample : 0, end: gap.atSample })),
        { start: gaps[gaps.length - 1].atSample, end: null }];
      const graph = [`[0:a]${filters.join(',')},asplit=${pieces.length}${pieces.map((_, index) => `[split${index}]`).join('')}`,
        ...pieces.map((piece, index) => `[split${index}]atrim=start_sample=${piece.start}${piece.end === null ? '' : `:end_sample=${piece.end}`},asetpts=PTS-STARTPTS[piece${index}]`)];
      const piecePaths = pieces.map((_, index) => path.join(scratchDirectory, `${source.sourceId}-piece-${index}.flac`));
      // Only the refused timestamp render is replaced here; source chunks stay untouched.
      await fs.promises.rm(normalizedPath, { force: true });
      let command = input(rawPath).complexFilter(graph).on('stderr', line => evidence.consume(line));
      for (const [index, piecePath] of piecePaths.entries()) command = lossless(command.output(piecePath)).outputOptions(['-map', `[piece${index}]`]);
      await run(command, sourceTimeout(source), 'Replay native source in sample order');
      const decodedSamples = evidence.result().decodedSamples;
      const files = [];
      for (const [index, piecePath] of piecePaths.entries()) {
        const expected = (pieces[index].end === null ? decodedSamples : pieces[index].end) - pieces[index].start;
        if (Math.abs(samples(await validDuration(piecePath, 'flac')) - expected) > 1) throw failure(`Native source ${source.sourceId} sample-order piece has an incorrect length`);
        files.push(piecePath);
        if (index < gaps.length) {
          const silencePath = path.join(scratchDirectory, `${source.sourceId}-gap-${index}.flac`);
          await renderSilence(silencePath, gaps[index].silenceSamples);
          files.push(silencePath);
        }
      }
      const listPath = path.join(scratchDirectory, `${source.sourceId}-restored-concat.txt`);
      await writeFileAtomic(listPath, concatList(files));
      const restoredSeconds = (decodedSamples + gaps.reduce((sum, gap) => sum + gap.silenceSamples, 0)) / RATE;
      await run(lossless(input(listPath).inputOptions(['-f', 'concat', '-safe', '0'])).output(normalizedPath),
        timeout(Math.max(restoredSeconds, options.expectedDurationSec || 0, (source.endOffsetMs || 0) / 1000)), 'Restore native source gaps');
    }
    async function finish(candidate, plan, totalSamples, fastPathUsed) {
      Object.assign(plan, { version: 1, sampleRate: RATE, channels: CHANNELS, totalSamples, recovery: !!options.recovery,
        sourceIds: usable.map(source => source.sourceId), systemPcmIncluded: hasPcm, fastPathUsed,
        onsetIsApproximate: true, mixingPolicy: 'unity-sum-no-limiter', codecPolicy: CODEC_POLICY,
        encoding: { codec: 'opus', sampleRate: RATE, channels: CHANNELS, bitRate: BIT_RATE, bitRateMode: 'cbr', frameDurationMs: FRAME_DURATION_MS },
        scratchEstimateHasUnknownDuration: usable.some(source => source.interrupted) });
      const planPath = path.join(scratchDirectory, 'plan.json');
      plan.validation = { status: 'pending', expectedDecodedSamples: totalSamples, expectedDecodedDuration: totalSamples / RATE,
        estimatedMaximumOutputBytes: estimateEncodedBytes(totalSamples / RATE) };
      // Failure diagnostics must survive even if inspection rejects the file.
      await writeFileAtomic(planPath, JSON.stringify(plan));
      let encoded;
      try {
        plan.validation.observedOutputBytes = (await fs.promises.stat(candidate)).size;
        plan.validation.containerDuration = await validDuration(candidate);
        encoded = await inspectEncodedOpus(candidate, { ffprobePath });
        Object.assign(plan.validation, { observedDecodedSamples: encoded.decodedSamples,
          observedDecodedDuration: encoded.duration, encodedPacketEvidence: encoded });
        if (Math.abs(encoded.decodedSamples - totalSamples) > 1) {
          throw Object.assign(failure('Encoded native recording has an incorrect decoded sample count', 'NATIVE_FINALIZATION_SAMPLE_COUNT'), {
            expectedDecodedSamples: totalSamples, actualDecodedSamples: encoded.decodedSamples,
            expectedDuration: totalSamples / RATE, actualDuration: encoded.duration,
          });
        }
        plan.validation.status = 'passed';
        await writeFileAtomic(planPath, JSON.stringify(plan));
      } catch (error) {
        plan.validation.status = 'failed';
        plan.validation.error = { code: error.code || 'NATIVE_FINALIZATION_VALIDATION_FAILED', message: String(error.message).slice(0, 1024),
          evidence: error.evidence || null };
        await writeFileAtomic(planPath, JSON.stringify(plan)).catch(() => {});
        throw error;
      }
      await publishFile(candidate, outputPath);
      return { success: true, outputPath, duration: encoded.duration, containerDuration: plan.validation.containerDuration,
        warnings: plan.warnings, sourceIds: plan.sourceIds, sourceMode: 'native',
        systemPcmIncluded: hasPcm, scratchDirectory, plan, fastPathUsed, reencoded: true,
        estimatedScratchBytes: estimateScratchBytes({ sourceBytes, timelineSeconds: totalSamples / RATE,
          sourceSeconds: plan.sourceEvidence.reduce((sum, source) => sum + source.decodedDuration, 0) + (hasPcm ? pcm.duration : 0),
          lanes: plan.lanes.length, fastPath: fastPathUsed }) };
    }
    let fastPathFallback = null;
    try {
      // Recovery without a closed epoch has no trustworthy final duration. Its
      // compressed-byte estimate is explicitly approximate; ENOSPC remains a
      // retryable failure and can never authorize discarding original audio.
      await checkSpace(spaceEstimate(fastEligible));
      for (const source of usable) {
        const rawPath = path.join(scratchDirectory, `${source.sourceId}.webm`);
        await concatenateFiles(source.chunkPaths, rawPath);
        rawPaths.set(source.sourceId, rawPath);
      }
      // Most meetings have one epoch per lane. Decode/gap-fill/stereo-map/mix
      // and encode them in ONE bounded-input command, avoiding multi-gigabyte
      // FLAC scratch. General epoch planning remains available when needed.
      if (fastEligible) {
        const lanes = usable.map(source => ({ source, inputPath: rawPaths.get(source.sourceId), kind: source.kind,
          startSample: samples(source.startOffsetMs / 1000), evidence: createTimestampEvidence() }));
        if (hasPcm) lanes.push({ inputPath: pcm.path, kind: 'system', startSample: 0, pcm: true, evidence: createTimestampEvidence() });
        const targetSamples = Math.max(expectedSamples, hasPcm ? pcm.samples : 0, ...usable.map(source =>
          source.endOffsetMs === null ? 0 : samples(source.endOffsetMs / 1000)));
        let command = ffmpeg().outputOptions(['-nostdin', '-xerror', '-max_alloc', '67108864', '-filter_threads', '1', '-filter_complex_threads', '1']);
        const filters = [];
        for (let index = 0; index < lanes.length; index++) {
          const lane = lanes[index];
          command = command.input(lane.inputPath);
          if (lane.pcm) command = command.inputOptions(['-f', 's16le', '-ar', String(RATE), '-ac', '1']);
          const padding = targetSamples ? `,apad=whole_len=${targetSamples}` : '';
          // Resample the source's own clock gaps first. Initial offsets below
          // its compensation threshold need exact leading samples, not PTS
          // shifts that may be ignored and later disguised by end padding.
          const delay = lane.startSample ? `,adelay=${lane.startSample}S|${lane.startSample}S` : '';
          filters.push(`[${index}:a]asettb=1/48000,ashowinfo@native_${index},asetpts=PTS-STARTPTS,${stereo},${resample}${delay}${padding}[lane${index}]`);
        }
        filters.push(lanes.length === 2
          ? '[lane0][lane1]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[out]'
          : '[lane0]anull[out]');
        const candidate = path.join(scratchDirectory, 'fast-rendered.webm');
        command = opus(command.complexFilter(filters, ['out'])).on('stderr', line => {
            for (let index = 0; index < lanes.length; index++) {
              if (!line.includes('ashowinfo') || line.includes(`ashowinfo@native_${index} `)) lanes[index].evidence.consume(line);
            }
          }).output(candidate);
        await run(command, timeout(Math.max(targetSamples / RATE, sourceBytes / 8000)), 'Encode native recording directly');
        const fastWarnings = [...warnings], fastEvidence = [];
        let observedEnd = 0, overlapped = false, resampleFailed = false;
        for (const lane of lanes) {
          const timing = lane.evidence.result();
          if (!timing.frames) throw failure('Native source has no decoded frame evidence');
          // A failed compensation leaves this render on a wrong timeline
          // (ELECTRON-7R). Re-render per source below, which replays the
          // affected source in sample order instead of stranding the meeting.
          if (timing.resamplerFailure) resampleFailed = true;
          // The resampler would drop overlapped samples. Re-render per source
          // below, where overlap switches that source to a sample-count timeline.
          if (timing.overlapCount) overlapped = true;
          const mediaSamples = Math.round(timing.lastEndPts - timing.firstPts);
          lane.endSample = lane.startSample + mediaSamples;
          observedEnd = Math.max(observedEnd, lane.endSample);
          if (timing.gapCount) fastWarnings.push({ kind: 'native-source-timestamp-gaps', sourceId: lane.source?.sourceId || 'audiotee',
            count: timing.gapCount, gapSeconds: timing.gapSamples / RATE });
          if (lane.source) fastEvidence.push({ sourceId: lane.source.sourceId, kind: lane.kind, rawPath: lane.inputPath,
            normalizedPath: null, startOffsetMs: lane.source.startOffsetMs, endOffsetMs: lane.source.endOffsetMs,
            decodedDuration: mediaSamples / RATE, timing, onsetIsApproximate: true, interrupted: lane.source.interrupted });
        }
        // With two lanes, an unexpected tail beyond the common padded end can
        // change old amix's normalization. Preserve it through general planning
        // instead of trimming it or publishing an end-of-stream gain change.
        if (!overlapped && !resampleFailed && (lanes.length === 1 || observedEnd <= targetSamples)) {
          try {
            return await finish(candidate, { sourceEvidence: fastEvidence, lanes: lanes.map(lane => ({ kind: lane.kind,
              startSample: lane.startSample, mediaEndSample: lane.endSample })), warnings: fastWarnings }, Math.max(targetSamples, observedEnd), true);
          } catch (error) {
            // This path predicts its length from source timestamps, which have
            // millisecond precision, while the resampler passes disagreements
            // below its 2 ms threshold through. A source that reaches the
            // planned end can therefore hold a few samples more or fewer than
            // predicted (ELECTRON-73), and refusing stranded a complete
            // meeting. Re-render below from measured source lengths; a
            // difference that survives measuring is still refused there.
            if (error.code !== 'NATIVE_FINALIZATION_SAMPLE_COUNT') throw error;
            // Timestamp rounding explains a miss up to the timing tolerance.
            // A larger one means this render itself lost or added audio.
            fastPathFallback = { reason: 'sample-count', expectedDecodedSamples: error.expectedDecodedSamples,
              observedDecodedSamples: error.actualDecodedSamples,
              withinTimingTolerance: Math.abs(error.expectedDecodedSamples - error.actualDecodedSamples) <= TIMING_TOLERANCE_SAMPLES };
            // The refused render and its plan stay in scratch as evidence.
            // plan.json then only ever describes the measured rebuild, also
            // when that stops before its own validation.
            await fs.promises.rename(path.join(scratchDirectory, 'plan.json'), path.join(scratchDirectory, 'fast-plan.json')).catch(() => {});
          }
        }
        // A missed length prediction is no capture event: every sample is
        // kept. It is recorded in the plan, never as a warning for History.
        if (!fastPathFallback) warnings.push(resampleFailed
          ? { kind: 'native-source-fast-path-resample-fallback' }
          : overlapped
            ? { kind: 'native-source-fast-path-overlap-fallback' }
            : { kind: 'native-source-fast-path-tail-fallback', observedEndSeconds: observedEnd / RATE, plannedEndSeconds: targetSamples / RATE });
        await checkSpace(estimateScratchBytes({ sourceBytes, timelineSeconds: Math.max(observedEnd, fastPathFallback ? targetSamples : 0) / RATE,
          sourceSeconds: fastEvidence.reduce((sum, source) => sum + source.decodedDuration, 0) + (hasPcm ? pcm.duration : 0), lanes: estimatedLanes }));
      }
      for (const source of usable) {
        const rawPath = rawPaths.get(source.sourceId);
        const normalizedPath = path.join(scratchDirectory, `${source.sourceId}.flac`);
        const evidence = createTimestampEvidence();
        // Resampler policy: materialize forward timestamp gaps without gradual
        // clock stretching. Overlap re-renders in sample order after this pass,
        // before any output can replace the requested building file.
        // https://ffmpeg.org/ffmpeg-resampler.html
        const normalize = (filters, onStderr) => run(lossless(input(rawPath).audioFilters(filters))
          .on('stderr', onStderr).output(normalizedPath), sourceTimeout(source), 'Normalize native source');
        await normalize([
          'asettb=1/48000', 'ashowinfo', 'asetpts=PTS-STARTPTS',
          // Copy mono center to BOTH speakers at unity, while preserving
          // separate stereo channels (including anti-phase USB inputs).
          stereo, resample,
        ], line => evidence.consume(line));
        const timing = evidence.result();
        if (!timing.frames) throw failure(`Native source ${source.sourceId} has no decoded frame evidence`);
        // Overlapping timestamps within one MediaRecorder stream (ELECTRON-68)
        // carry distinct encoded audio behind a backward clock step. Refusing
        // stranded the whole meeting, and the timestamp resampler would drop
        // that speech. Keep every decoded sample in order instead; gaps then
        // close too, so this lane's later onsets are approximate (warned).
        // A forward gap too long for the resampler to buffer (ELECTRON-7R)
        // fails its compensation and leaves a wrong timeline. That also
        // stranded a meeting. Replay in sample order as well; without overlap,
        // its long gaps return as streamed silence so lanes stay aligned.
        const overlapped = timing.overlapCount > 0, resampleFailed = !!timing.resamplerFailure;
        const sequential = overlapped || resampleFailed;
        let timeline = 'timestamps', insertedSamples = 0, restoredGaps = [];
        if (sequential) {
          const replay = createTimestampEvidence();
          const replayFilters = ['asettb=1/48000', 'ashowinfo', 'asetpts=N/SR/TB', stereo, 'aresample=48000'];
          const gapPlan = evidence.restorableGaps();
          if (resampleFailed && !overlapped && !gapPlan.overflow) {
            for (const gap of gapPlan.gaps) {
              // Silence that puts the following frame back at its timestamp;
              // shorter closed gaps before it are absorbed here, not lost.
              const silence = gap.timelineSample - (gap.decodedSamples + insertedSamples);
              if (silence > 0) { restoredGaps.push({ atSample: gap.decodedSamples, silenceSamples: silence }); insertedSamples += silence; }
            }
          }
          if (restoredGaps.length) {
            timeline = 'sample-order-restored-gaps';
            await replayRestoringGaps(source, rawPath, normalizedPath, replayFilters, restoredGaps, replay);
            if (JSON.stringify(replay.restorableGaps()) !== JSON.stringify(gapPlan)) throw failure(`Native source ${source.sourceId} sample-order replay decoded a different stream`);
          } else {
            timeline = 'sample-order';
            await normalize(replayFilters, line => replay.consume(line));
          }
          const replayed = replay.result();
          if (replayed.frames !== timing.frames) throw failure(`Native source ${source.sourceId} sample-order replay decoded a different stream`);
          if (replayed.resamplerFailure) throw failure(`Native source ${source.sourceId} sample-order replay failed`, 'NATIVE_SOURCE_TIMESTAMP_RESAMPLE_FAILED');
          if (overlapped) {
            warnings.push({ kind: 'native-source-timestamp-overlap', sourceId: source.sourceId, timeline: 'sample-order',
              count: timing.overlapCount, overlapSeconds: timing.overlapSamples / RATE,
              collapsedGapCount: timing.gapCount, collapsedGapSeconds: timing.gapSamples / RATE, onsetIsApproximate: true });
          }
          if (resampleFailed) {
            warnings.push({ kind: 'native-source-timestamp-resample-fallback', sourceId: source.sourceId, timeline,
              gapCount: timing.gapCount, gapSeconds: timing.gapSamples / RATE, restoredGapCount: restoredGaps.length,
              restoredSilenceSeconds: insertedSamples / RATE, onsetIsApproximate: true });
          }
        } else if (timing.gapCount) {
          warnings.push({ kind: 'native-source-timestamp-gaps', sourceId: source.sourceId,
            count: timing.gapCount, gapSeconds: timing.gapSamples / RATE });
        }
        const duration = await validDuration(normalizedPath, 'flac');
        const mediaSamples = samples(duration);
        const span = sequential ? timing.decodedSamples + insertedSamples : timing.lastEndPts - timing.firstPts;
        if (Math.abs(mediaSamples - span) > TIMING_TOLERANCE_SAMPLES) throw failure(`Native source ${source.sourceId} normalization changed its timestamp span`);
        normalized.push({ ...source, normalizedPath, mediaSamples, startSample: samples(source.startOffsetMs / 1000) });
        sourceEvidence.push({ sourceId: source.sourceId, kind: source.kind, rawPath, normalizedPath,
          startOffsetMs: source.startOffsetMs, endOffsetMs: source.endOffsetMs, decodedDuration: duration,
          timing, timeline, ...(restoredGaps.length ? { restoredGaps } : {}), onsetIsApproximate: true, interrupted: source.interrupted });
      }

      const plans = [];
      for (const kind of ['microphone', 'system']) {
        const epochs = normalized.filter(source => source.kind === kind);
        if (epochs.length) plans.push({ kind, ...planLane(epochs, warnings) });
      }
      if (hasPcm) {
        const normalizedPath = path.join(scratchDirectory, 'system-pcm.flac');
        await run(lossless(input(pcm.path).inputOptions(['-f', 's16le', '-ar', String(RATE), '-ac', '1'])
          .audioFilters('pan=stereo|c0=c0|c1=c0')).output(normalizedPath), timeout(pcm.duration), 'Normalize AudioTee PCM');
        const duration = await validDuration(normalizedPath, 'flac');
        if (Math.abs(samples(duration) - pcm.samples) > 1) throw failure('System PCM normalization changed its sample count');
        plans.push({ kind: 'system', samples: pcm.samples, segments: [{ kind: 'audio', sourceId: 'audiotee',
          input: normalizedPath, samples: pcm.samples, originalSamples: pcm.samples, startSample: 0 }] });
      }
      const intendedEnd = normalized.reduce((maximum, source) => Math.max(maximum,
        source.endOffsetMs === null ? 0 : samples(source.endOffsetMs / 1000)), 0);
      const totalSamples = Math.max(expectedSamples, intendedEnd, ...plans.map(plan => plan.samples));
      if (!totalSamples) throw failure('Native recording timeline is empty');
      const laneFiles = [];
      let sequence = 0;
      for (const plan of plans) {
        if (plan.samples < totalSamples) plan.segments.push({ kind: 'silence', samples: totalSamples - plan.samples });
        const files = [];
        for (const segment of plan.segments) {
          if (segment.kind === 'audio' && segment.samples === segment.originalSamples) { files.push(segment.input); continue; }
          const segmentPath = path.join(scratchDirectory, `segment-${sequence++}.flac`);
          if (segment.kind === 'silence') {
            await renderSilence(segmentPath, segment.samples);
          } else {
            await run(lossless(input(segment.input).audioFilters(`atrim=end_sample=${segment.samples},asetpts=PTS-STARTPTS`))
              .output(segmentPath), timeout(segment.samples / RATE), 'Build native timeline segment');
            if (Math.abs(samples(await validDuration(segmentPath, 'flac')) - segment.samples) > 1) throw failure('Native timeline segment has an incorrect length');
          }
          files.push(segmentPath);
        }
        if (files.length === 1) {
          laneFiles.push({ path: files[0], options: [] });
        } else {
          const listPath = path.join(scratchDirectory, `${plan.kind}-concat.txt`);
          // Concat demuxer opens one segment at a time, even after thousands of
          // device/pause epochs. Never open every epoch in one filter graph.
          await writeFileAtomic(listPath, concatList(files));
          // Feed this demuxer directly to the final encoder. This avoids an
          // additional full-meeting FLAC copy, including on five-hour runs.
          laneFiles.push({ path: listPath, options: ['-f', 'concat', '-safe', '0'] });
        }
      }
      let command = input(laneFiles[0].path).inputOptions(laneFiles[0].options);
      if (laneFiles.length === 2) {
        command = command.input(laneFiles[1].path).inputOptions(laneFiles[1].options).complexFilter([
          '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[out]',
        ], ['out']);
      }
      // Both lanes have equal durations: old amix normalization stays 1/2,
      // volume=2 restores unity summing without a limiter's hidden lookahead.
      // Simultaneous peaks can clip in final encoding, as in the live mixer;
      // original stereo source files remain available without this summing.
      await run(opus(command).output(rendered), timeout(totalSamples / RATE), 'Encode native recording');
      return await finish(rendered, { sourceEvidence, lanes: plans, warnings, ...(fastPathFallback ? { fastPathFallback } : {}) }, totalSamples, false);
    } catch (error) {
      error.scratchDirectory = scratchDirectory;
      // A rebuild that fails too keeps the counts that sent it there.
      if (fastPathFallback) error.fastPathFallback = fastPathFallback;
      throw error;
    }
  }
  return { build };
}

module.exports = { createNativeSourceFinalization, createTimestampEvidence, planLane, classifySources, estimateScratchBytes, estimateEncodedBytes };
