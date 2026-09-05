'use strict';

const fs = require('fs');
const path = require('path');
const { inspectNativeSources } = require('./native-source-persistence');
const { concatenateFiles, publishFile, writeFileAtomic, syncDirectorySync } = require('./durable-files');

const RATE = 48000;
const CHANNELS = 2;
const TIMING_TOLERANCE_SAMPLES = 96; // 2 ms: native WebM timestamps have millisecond precision.
const MAX_DURATION_SECONDS = 31 * 24 * 60 * 60;

function failure(message, code = 'NATIVE_FINALIZATION_INVALID') {
  return Object.assign(new Error(`${message}; original native audio is retained`), { code });
}

function samples(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_DURATION_SECONDS) throw failure('Invalid native audio timeline duration');
  return Math.round(seconds * RATE);
}

// Run before timestamp normalization, after asettb=1/48000. Integer PTS avoids
// ashowinfo's pts_time display losing precision during a five-hour meeting.
// Only counters and a bounded set of examples are retained, never a frame log.
function createTimestampEvidence() {
  let previousEnd = null;
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
        }
      }
      result.frames++;
      if (result.firstPts === null) result.firstPts = timestamp;
      previousEnd = timestamp + duration;
      result.lastEndPts = previousEnd;
      result.decodedSamples += duration;
    },
    result() { return { ...result, examples: result.examples.map(value => ({ ...value })) }; },
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
      if (!recovery) throw failure(`Started native source ${source.sourceId} has no saved audio`);
      warnings.push({ kind: 'native-source-audio-missing', sourceId: source.sourceId });
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

// Conservative general-path ceiling: unchanged source concatenations, up to two
// copies of uncompressed-equivalent 24-bit stereo FLAC, final 192-kbit Opus,
// and fixed metadata/container reserve. Silence FLAC is normally much smaller.
function estimateScratchBytes({ sourceBytes = 0, timelineSeconds = 0, sourceSeconds = 0, lanes = 2, fastPath = false } = {}) {
  const duration = samples(timelineSeconds) / RATE;
  if (!Number.isFinite(sourceBytes) || sourceBytes < 0 || ![1, 2].includes(lanes)) throw failure('Invalid native scratch estimate');
  const mediaSeconds = samples(sourceSeconds) / RATE;
  return Math.ceil(sourceBytes + (fastPath ? 0 : Math.max(duration * lanes, mediaSeconds) * RATE * CHANNELS * 3 * 2) +
    duration * 24000 + 64 * 1024 * 1024);
}

function createNativeSourceFinalization({ ffmpeg, run, validate, probe, checkSpace = async () => {} }) {
  if ([ffmpeg, run, validate, probe, checkSpace].some(value => typeof value !== 'function')) throw new Error('Native finalization dependencies are incomplete');

  const timeout = seconds => Math.min(45 * 60000, 5 * 60000 + Math.ceil(seconds / 3600) * 10 * 60000);
  async function validDuration(file) {
    const validation = await validate(file);
    if (!validation?.valid) throw failure(validation?.error || 'Native audio output validation failed');
    const measured = await probe(file);
    const duration = typeof measured === 'number' ? measured : Number(measured?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) throw failure('Native audio decoded to an empty or invalid timeline');
    return duration;
  }
  const lossless = command => command.audioCodec('flac').audioFrequency(RATE).audioChannels(CHANNELS)
    .outputOptions(['-sample_fmt', 's32', '-compression_level', '5', '-threads', '1']);
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
    // Old swresample queues an entire inserted timestamp gap in memory.
    // Large initial offsets belong in streamed silence segments, not its FIFO.
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
    const resample = 'aresample=48000:ocl=stereo:clev=1:async=1:first_pts=0:min_hard_comp=0.002:max_soft_comp=0';
    const rendered = path.join(scratchDirectory, 'rendered.webm');
    async function finish(candidate, plan, totalSamples, fastPathUsed) {
      const duration = await validDuration(candidate);
      const difference = samples(duration) - totalSamples;
      // The final encoder is fixed to 20ms Opus frames. The container can
      // include its small codec delay; it must not end materially early.
      if (difference < -TIMING_TOLERANCE_SAMPLES || difference > RATE * 0.025) throw failure('Encoded native recording has an incorrect timeline length');
      Object.assign(plan, { version: 1, sampleRate: RATE, channels: CHANNELS, totalSamples, recovery: !!options.recovery,
        sourceIds: usable.map(source => source.sourceId), systemPcmIncluded: hasPcm, fastPathUsed,
        onsetIsApproximate: true, mixingPolicy: 'unity-sum-no-limiter', codecPolicy: 'opus-reencoded-from-native-sources',
        scratchEstimateHasUnknownDuration: usable.some(source => source.interrupted) });
      await writeFileAtomic(path.join(scratchDirectory, 'plan.json'), JSON.stringify(plan));
      await publishFile(candidate, outputPath);
      return { success: true, outputPath, duration, warnings: plan.warnings, sourceIds: plan.sourceIds, sourceMode: 'native',
        systemPcmIncluded: hasPcm, scratchDirectory, plan, fastPathUsed, reencoded: true,
        estimatedScratchBytes: estimateScratchBytes({ sourceBytes, timelineSeconds: totalSamples / RATE,
          sourceSeconds: plan.sourceEvidence.reduce((sum, source) => sum + source.decodedDuration, 0) + (hasPcm ? pcm.duration : 0),
          lanes: plan.lanes.length, fastPath: fastPathUsed }) };
    }
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
          filters.push(`[${index}:a]asettb=1/48000,ashowinfo@native_${index},asetpts=PTS-STARTPTS+${lane.startSample},${stereo},${resample}${padding}[lane${index}]`);
        }
        filters.push(lanes.length === 2
          ? '[lane0][lane1]amix=inputs=2:duration=longest:dropout_transition=0,volume=2[out]'
          : '[lane0]anull[out]');
        const candidate = path.join(scratchDirectory, 'fast-rendered.webm');
        command = command.complexFilter(filters, ['out']).audioCodec('libopus').audioBitrate('192k').audioFrequency(RATE).audioChannels(CHANNELS)
          .outputOptions(['-threads', '1', '-frame_duration', '20']).on('stderr', line => {
            for (let index = 0; index < lanes.length; index++) {
              if (!line.includes('ashowinfo') || line.includes(`ashowinfo@native_${index} `)) lanes[index].evidence.consume(line);
            }
          }).output(candidate);
        await run(command, timeout(Math.max(targetSamples / RATE, sourceBytes / 8000)), 'Encode native recording directly');
        const fastWarnings = [...warnings], fastEvidence = [];
        let observedEnd = 0;
        for (const lane of lanes) {
          const timing = lane.evidence.result();
          if (!timing.frames) throw failure('Native source has no decoded frame evidence');
          if (timing.resamplerFailure) throw failure('Native timestamp compensation failed', 'NATIVE_SOURCE_TIMESTAMP_RESAMPLE_FAILED');
          if (timing.overlapCount) throw failure('Native source has overlapping native timestamps', 'NATIVE_SOURCE_TIMESTAMP_OVERLAP');
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
        if (lanes.length === 1 || observedEnd <= targetSamples) {
          return await finish(candidate, { sourceEvidence: fastEvidence, lanes: lanes.map(lane => ({ kind: lane.kind,
            startSample: lane.startSample, mediaEndSample: lane.endSample })), warnings: fastWarnings }, Math.max(targetSamples, observedEnd), true);
        }
        warnings.push({ kind: 'native-source-fast-path-tail-fallback', observedEndSeconds: observedEnd / RATE, plannedEndSeconds: targetSamples / RATE });
        await checkSpace(estimateScratchBytes({ sourceBytes, timelineSeconds: observedEnd / RATE,
          sourceSeconds: fastEvidence.reduce((sum, source) => sum + source.decodedDuration, 0) + (hasPcm ? pcm.duration : 0), lanes: estimatedLanes }));
      }
      for (const source of usable) {
        const rawPath = rawPaths.get(source.sourceId);
        const normalizedPath = path.join(scratchDirectory, `${source.sourceId}.flac`);
        const evidence = createTimestampEvidence();
        // Resampler policy: materialize forward timestamp gaps without gradual
        // clock stretching. Significant overlap is rejected after this pass,
        // before any output can replace the requested building file.
        // https://ffmpeg.org/ffmpeg-resampler.html
        const command = lossless(input(rawPath).audioFilters([
          'asettb=1/48000', 'ashowinfo', 'asetpts=PTS-STARTPTS',
          // Copy mono center to BOTH speakers at unity, while preserving
          // separate stereo channels (including anti-phase USB inputs).
          stereo, resample,
        ])).on('stderr', line => evidence.consume(line)).output(normalizedPath);
        await run(command, timeout(Math.max(options.expectedDurationSec || 0, (source.endOffsetMs || 0) / 1000)), 'Normalize native source');
        const timing = evidence.result();
        if (!timing.frames) throw failure(`Native source ${source.sourceId} has no decoded frame evidence`);
        if (timing.resamplerFailure) throw failure(`Native source ${source.sourceId} timestamp compensation failed`, 'NATIVE_SOURCE_TIMESTAMP_RESAMPLE_FAILED');
        if (timing.overlapCount) throw failure(`Native source ${source.sourceId} has overlapping native timestamps`, 'NATIVE_SOURCE_TIMESTAMP_OVERLAP');
        if (timing.gapCount) warnings.push({ kind: 'native-source-timestamp-gaps', sourceId: source.sourceId,
          count: timing.gapCount, gapSeconds: timing.gapSamples / RATE });
        const duration = await validDuration(normalizedPath);
        const mediaSamples = samples(duration);
        const span = timing.lastEndPts - timing.firstPts;
        if (Math.abs(mediaSamples - span) > TIMING_TOLERANCE_SAMPLES) throw failure(`Native source ${source.sourceId} normalization changed its timestamp span`);
        normalized.push({ ...source, normalizedPath, mediaSamples, startSample: samples(source.startOffsetMs / 1000) });
        sourceEvidence.push({ sourceId: source.sourceId, kind: source.kind, rawPath, normalizedPath,
          startOffsetMs: source.startOffsetMs, endOffsetMs: source.endOffsetMs, decodedDuration: duration,
          timing, onsetIsApproximate: true, interrupted: source.interrupted });
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
        const duration = await validDuration(normalizedPath);
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
          const command = segment.kind === 'silence'
            ? ffmpeg().input('anullsrc=r=48000:cl=stereo').inputFormat('lavfi').audioFilters(`atrim=end_sample=${segment.samples}`)
            : input(segment.input).audioFilters(`atrim=end_sample=${segment.samples},asetpts=PTS-STARTPTS`);
          await run(lossless(command).output(segmentPath), timeout(segment.samples / RATE), 'Build native timeline segment');
          if (Math.abs(samples(await validDuration(segmentPath)) - segment.samples) > 1) throw failure('Native timeline segment has an incorrect length');
          files.push(segmentPath);
        }
        if (files.length === 1) {
          laneFiles.push({ path: files[0], options: [] });
        } else {
          const listPath = path.join(scratchDirectory, `${plan.kind}-concat.txt`);
          // Concat demuxer opens one segment at a time, even after thousands of
          // device/pause epochs. Never open every epoch in one filter graph.
          await writeFileAtomic(listPath, files.map(file => "file '" + file.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n'));
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
      await run(command.audioCodec('libopus').audioBitrate('192k').audioFrequency(RATE).audioChannels(CHANNELS)
        .outputOptions(['-threads', '1', '-frame_duration', '20']).output(rendered), timeout(totalSamples / RATE), 'Encode native recording');
      return await finish(rendered, { sourceEvidence, lanes: plans, warnings }, totalSamples, false);
    } catch (error) {
      error.scratchDirectory = scratchDirectory;
      throw error;
    }
  }
  return { build };
}

module.exports = { createNativeSourceFinalization, createTimestampEvidence, planLane, classifySources, estimateScratchBytes };
