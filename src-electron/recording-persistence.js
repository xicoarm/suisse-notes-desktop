'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sourceFingerprint: nativeSourceFingerprint, inspectNativeSources } = require('./native-source-persistence');
const { usesNativeSources, NATIVE_CAPTURE_MARKER, readNativeCaptureMarker } = require('./native-recording-session');
const { inspectPcmCaptureEvidence, pcmEvidenceFingerprint } = require('./pcm-capture-evidence');
const {
  archiveChunkBatch, listChunkBatches, concatenateFiles,
  publishFile, writeFileAtomic,
} = require('./durable-files');

async function checksum(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(filePath)) hash.update(bytes);
  return hash.digest('hex');
}

function listSessions(recordPath, ext = '.webm') {
  const directory = path.join(recordPath, 'sessions');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => /^session_\d+\.[a-z0-9]+$/.test(name) && name.endsWith(ext))
    .sort((a, b) => Number(a.split('_')[1].split('.')[0]) - Number(b.split('_')[1].split('.')[0]))
    .map(name => path.join(directory, name));
}

// Dependencies do the media work; this module owns the on-disk transaction.
// A readable header alone is NOT permission to delete the original audio.
// Source batches and sessions remain available for retry, export and support.
function createRecordingPersistence({ prepareRaw, remux, concatSessions, merge, validate, probe, fromPcm, nativeBuild }) {
  async function assertValid(filePath) {
    const result = await validate(filePath);
    if (!result.valid) throw new Error(result.error || 'Invalid recording output');
    return result;
  }

  async function createSessions(recordPath, ext = '.webm') {
    await archiveChunkBatch(recordPath, ext);
    const sessionsPath = path.join(recordPath, 'sessions');
    await fs.promises.mkdir(sessionsPath, { recursive: true });
    const batches = listChunkBatches(recordPath);
    const batchIds = new Set(batches.map(batch => batch.id));
    const legacySessions = listSessions(recordPath, ext).filter(file => !batchIds.has(path.basename(file).split('_')[1].split('.')[0]));
    const chunks = batches.flatMap(batch => fs.readdirSync(batch.path)
      .filter(name => /^chunk_\d+\.[a-z0-9]+$/.test(name) && name.endsWith(ext))
      .sort((a, b) => Number(a.split('_')[1].split('.')[0]) - Number(b.split('_')[1].split('.')[0]))
      .map(name => path.join(batch.path, name)));
    if (!chunks.length) return legacySessions;
    const indices = chunks.map(file => Number(path.basename(file).split('_')[1].split('.')[0]));
    if ((!legacySessions.length && indices[0] !== 0) || indices.some((index, i) => i > 0 && index !== indices[i - 1] + 1)) {
      throw new Error('Recording source chunks contain a gap or duplicate index; originals retained for recovery');
    }
    // MediaRecorder only guarantees that ALL blobs joined in order are
    // playable. A timeslice/rotation can land inside an EBML cluster. Preserve
    // the continuous byte stream across every rotation before remuxing once.
    const rawPath = path.join(sessionsPath, 'source_raw' + ext);
    const buildingPath = path.join(sessionsPath, 'source_building' + ext);
    const finalPath = path.join(sessionsPath, 'source_final' + ext);
    await concatenateFiles(chunks, rawPath);
    const preparation = await prepareRaw(rawPath);
    await remux(rawPath, buildingPath, preparation);
    await assertValid(buildingPath);
    await publishFile(buildingPath, finalPath);
    await fs.promises.unlink(rawPath).catch(() => {});
    return [...legacySessions, finalPath];
  }

  async function finalizeNative(recordPath, ext, options) {
    if (!nativeBuild) throw new Error('Native audio finalization is unavailable; all source audio is retained');
    const pcmEvidence = inspectPcmCaptureEvidence(recordPath, { recovery: options.recovery === true });
    if (!pcmEvidence.canFinalize) {
      throw Object.assign(new Error('System audio did not finish saving. Retry saving to recover the available audio; original sources are retained.'), { code: 'PCM_CAPTURE_RECOVERY_REQUIRED' });
    }
    const fingerprint = nativeRecordingFingerprint(recordPath);
    const buildingPath = path.join(recordPath, `audio_native_building${ext}`);
    const outputPath = path.join(recordPath, `audio${ext}`);
    await writeFileAtomic(path.join(recordPath, 'finalization-plan.json'), JSON.stringify({
      version: 2, sourceMode: 'native', sourceFingerprint: fingerprint,
    }));
    const result = await nativeBuild(recordPath, buildingPath, options);
    if (result?.success !== true || result.outputPath !== buildingPath) throw new Error('Native audio was not finalized');
    assertNativeSourceCoverage(recordPath, result);
    result.warnings = [...(result.warnings || []), ...pcmEvidence.warnings.map(warning => ({ ...warning, kind: `system-audio-${warning.kind}` }))];
    await assertValid(buildingPath);
    // Native finalization measures decoded Opus samples after pre-skip/discard
    // padding. The nominal container duration includes codec padding.
    const duration = result.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('Native audio duration could not be verified');
    const sha256 = await checksum(buildingPath);
    const size = fs.statSync(buildingPath).size;
    if (nativeRecordingFingerprint(recordPath) !== fingerprint) throw new Error('Native recording sources changed during finalization; originals retained for retry');
    await publishFile(buildingPath, outputPath);
    const receipt = { version: 3, sourceMode: 'native', sourceFingerprint: fingerprint,
      filename: path.basename(outputPath), size, sha256, duration,
      sourceIds: result.sourceIds, systemPcmIncluded: result.systemPcmIncluded === true,
      recovered: options.recovery === true, warnings: result.warnings || [],
      completedAt: new Date().toISOString() };
    await writeFileAtomic(path.join(recordPath, 'finalized.json'), JSON.stringify(receipt));
    // Keep originals and failed scratch for diagnosis. Generated scratch cleanup
    // is deliberately separate from the durable publication transaction.
    return { ...result, outputPath, filename: receipt.filename, duration, fileSize: size, fileSizeMb: (size / 1048576).toFixed(2) };
  }

  async function finalize(recordPath, ext = '.webm', options = {}) {
    if (usesNativeSources(recordPath)) return finalizeNative(recordPath, ext, options);
    const sessions = await createSessions(recordPath, ext);
    const pcmPath = path.join(recordPath, 'system_audio.raw');
    const hasPcm = fs.existsSync(pcmPath) && fs.statSync(pcmPath).size > 0;
    const pcmOnly = !sessions.length && fromPcm && hasPcm;
    if (!sessions.length && !pcmOnly) throw new Error('No audio segments found to finalize');
    if (hasPcm && !pcmOnly && !merge) throw new Error('System audio must be combined before finalization; original sources retained');
    const fingerprint = sourceFingerprint(recordPath);
    const sourceMode = pcmOnly ? 'system-only' : hasPcm ? 'microphone-and-system' : 'microphone';
    const planPath = path.join(recordPath, 'finalization-plan.json');
    // A failed final batch throws above. Never publish only the earlier batches.
    const buildingPath = path.join(recordPath, `audio_building${ext}`);
    const outputPath = path.join(recordPath, `audio${ext}`);
    if (pcmOnly && fs.existsSync(outputPath)) {
      const completed = await readFinalizedRecording(recordPath);
      if (completed) return completed;
      // Older builds could leave a microphone-only output beside unmerged
      // system PCM after deleting the mic chunks. We cannot tell whether that
      // output already includes system audio. Replacing it with PCM alone or
      // mixing it again could lose the microphone or duplicate participants.
      let previousPlan;
      try { previousPlan = JSON.parse(await fs.promises.readFile(planPath, 'utf8')); } catch (_) { /* unknown provenance */ }
      if (previousPlan?.version !== 1 || previousPlan.sourceMode !== 'system-only' || previousPlan.sourceFingerprint !== fingerprint) {
        throw new Error('Existing audio and separate system audio need recovery before finalization; both original files are retained');
      }
    }
    // Establish source provenance BEFORE publishing output. A crash after
    // system-only publication but before its receipt must be distinguishable
    // from an old microphone file beside unmerged PCM.
    await writeFileAtomic(planPath, JSON.stringify({ version: 1, sourceMode, sourceFingerprint: fingerprint }));
    if (pcmOnly) await fromPcm(pcmPath, buildingPath);
    else if (sessions.length === 1) await concatenateFiles(sessions, buildingPath);
    else await concatSessions(sessions, buildingPath);
    await assertValid(buildingPath);
    if (merge && !pcmOnly) await merge(buildingPath);
    await assertValid(buildingPath);
    const duration = await probe(buildingPath);
    const sha256 = await checksum(buildingPath);
    const size = fs.statSync(buildingPath).size;
    if (sourceFingerprint(recordPath) !== fingerprint) throw new Error('Recording sources changed during finalization; originals retained for retry');
    await publishFile(buildingPath, outputPath);
    // If the app dies between publish and this marker, restart safely repeats
    // the operation from the retained sources. It never trusts a partial file.
    const receipt = { sourceFingerprint: fingerprint, version: 2, sourceMode, filename: path.basename(outputPath), size, sha256, duration, completedAt: new Date().toISOString() };
    await writeFileAtomic(path.join(recordPath, 'finalized.json'), JSON.stringify(receipt));
    return { success: true, outputPath, filename: receipt.filename, duration, fileSize: size, fileSizeMb: (size / 1048576).toFixed(2) };
  }

  return { createSessions, finalize };
}

function sourceFingerprint(recordPath) {
  const batches = listChunkBatches(recordPath);
  const batchIds = new Set(batches.map(batch => batch.id));
  const files = [];
  for (const directory of [path.join(recordPath, 'chunks'), ...batches.map(batch => batch.path)]) {
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).filter(name => /^chunk_\d+\.webm$/.test(name))) files.push(path.join(directory, name));
  }
  files.push(...listSessions(recordPath).filter(file => !batchIds.has(path.basename(file).split('_')[1].split('.')[0])));
  const pcm = path.join(recordPath, 'system_audio.raw');
  if (fs.existsSync(pcm)) files.push(pcm);
  return crypto.createHash('sha256').update(JSON.stringify(files.sort().map(file => {
    const stat = fs.statSync(file);
    return [path.relative(recordPath, file), stat.size, stat.mtimeMs];
  }))).digest('hex');
}

async function readFinalizedRecording(recordPath) {
  try {
    const receipt = JSON.parse(await fs.promises.readFile(path.join(recordPath, 'finalized.json'), 'utf8'));
    if (![1, 2, 3].includes(receipt.version) || receipt.filename !== 'audio.webm' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return null;
    const native = usesNativeSources(recordPath);
    if (native !== (receipt.version === 3) || (native && receipt.sourceMode !== 'native')) return null;
    if (native) assertNativeSourceCoverage(recordPath, receipt);
    const pcmPath = path.join(recordPath, 'system_audio.raw');
    const hasPcm = fs.existsSync(pcmPath) && fs.statSync(pcmPath).size > 0;
    // Version 1 could acknowledge a mic-only file even after its system merge
    // failed. Its checksum proves file identity, not inclusion of participants.
    if (receipt.version === 1 && hasPcm) return null;
    if (receipt.version === 2 && (hasPcm
      ? !['microphone-and-system', 'system-only'].includes(receipt.sourceMode)
      : receipt.sourceMode !== 'microphone')) return null;
    if (receipt.sourceFingerprint !== (native ? nativeRecordingFingerprint(recordPath) : sourceFingerprint(recordPath))) return null;
    const outputPath = path.join(recordPath, receipt.filename);
    const size = fs.statSync(outputPath).size;
    if (size !== receipt.size || await checksum(outputPath) !== receipt.sha256) return null;
    return { success: true, outputPath, duration: receipt.duration || 0, fileSize: size, fileSizeMb: (size / 1048576).toFixed(2), warnings: receipt.warnings || [] };
  } catch (_) { return null; }
}

function nativeRecordingFingerprint(recordPath) {
  const marker = fs.existsSync(path.join(recordPath, NATIVE_CAPTURE_MARKER)) ? readNativeCaptureMarker(recordPath) : null;
  return crypto.createHash('sha256').update(JSON.stringify({
    marker, native: nativeSourceFingerprint(recordPath), pcmEvidence: pcmEvidenceFingerprint(recordPath), retained: sourceFingerprint(recordPath),
  })).digest('hex');
}

function assertNativeSourceCoverage(recordPath, result) {
  const ids = inspectNativeSources(recordPath).filter(source => source.hasAudio).map(source => source.sourceId).sort();
  if (!Array.isArray(result.sourceIds) || JSON.stringify([...result.sourceIds].sort()) !== JSON.stringify(ids)) {
    throw new Error('Native finalization did not account for every saved audio source');
  }
  const pcm = path.join(recordPath, 'system_audio.raw');
  const hasPcm = fs.existsSync(pcm) && fs.statSync(pcm).size > 0;
  if (result.systemPcmIncluded !== hasPcm) throw new Error('Native finalization did not account for system PCM');
}

module.exports = { createRecordingPersistence, readFinalizedRecording, listSessions, checksum };
