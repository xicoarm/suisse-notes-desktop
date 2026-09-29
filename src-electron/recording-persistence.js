'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sourceRecords: nativeSourceRecords, inspectNativeSources } = require('./native-source-persistence');
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
    const buildingPath = path.join(recordPath, `audio_native_building${ext}`);
    const outputPath = path.join(recordPath, `audio${ext}`);
    // Virus scanners, backup agents and indexers set attributes, ACLs, streams
    // or restored access times on fresh files: their ctime/mtime move, their
    // bytes do not (ELECTRON-6V). The chunks written just before a stop are
    // that fresh while this build reads them. Rebuild ONCE against the settled
    // files, so the receipt still binds exactly what was read. A new chunk, a
    // different size or rewritten source metadata withholds publication at once.
    let settledAfter = null;
    for (;;) {
      const evidence = nativeRecordingEvidence(recordPath);
      const fingerprint = fingerprintOfEvidence(evidence);
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
      // The inspection hashed the encoded output before and after reading its
      // packets; the receipt must bind exactly those bytes.
      const inspected = result.plan?.validation?.encodedPacketEvidence?.codedSampleEvidence?.contentSha256;
      if (inspected && inspected !== sha256) throw new Error('Native audio changed after its inspection; originals retained for retry');
      const size = fs.statSync(buildingPath).size;
      const current = nativeRecordingEvidence(recordPath);
      if (fingerprintOfEvidence(current) !== fingerprint) {
        const change = describeSourceChange(evidence, current);
        if (change.timestampsOnly && !settledAfter) {
          settledAfter = change.changes.length > 20
            ? [...change.changes.slice(0, 20), `${change.changes.length - 20} more`] : change.changes;
          // The superseded assembly never became audio.webm; its scratch holds
          // copies of sources that are still on disk. Free it before the
          // rebuild's own space check, leaving one assembly per recording.
          await removeSupersededScratch(recordPath, result.scratchDirectory);
          continue;
        }
        throw new Error(`Native recording sources changed during finalization (${describeChanges(change.changes)}); originals retained for retry`);
      }
      await publishFile(buildingPath, outputPath);
      const receipt = { version: 3, sourceMode: 'native', sourceFingerprint: fingerprint,
        filename: path.basename(outputPath), size, sha256, duration,
        sourceIds: result.sourceIds, systemPcmIncluded: result.systemPcmIncluded === true,
        recovered: options.recovery === true, warnings: result.warnings || [],
        completedAt: new Date().toISOString() };
      await writeFileAtomic(path.join(recordPath, 'finalized.json'), JSON.stringify(receipt));
      // Keep originals and failed scratch for diagnosis. Generated scratch cleanup
      // is deliberately separate from the durable publication transaction.
      return { ...result, outputPath, filename: receipt.filename, duration, fileSize: size, fileSizeMb: (size / 1048576).toFixed(2),
        ...(settledAfter ? { sourceTimestampChanges: settledAfter } : {}) };
    }
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

function sourceEntries(recordPath) {
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
  return files.sort().map(file => {
    const stat = fs.statSync(file);
    return [path.relative(recordPath, file), stat.size, stat.mtimeMs];
  });
}

const sha256Json = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function sourceFingerprint(recordPath) {
  return sha256Json(sourceEntries(recordPath));
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

// Everything a native receipt binds, before hashing: the session marker, each
// native source (metadata and chunk path/size/mtime/ctime), the system-audio
// capture evidence and the retained live mix (path/size/mtime).
function nativeRecordingEvidence(recordPath) {
  const marker = fs.existsSync(path.join(recordPath, NATIVE_CAPTURE_MARKER)) ? readNativeCaptureMarker(recordPath) : null;
  return { marker, native: nativeSourceRecords(recordPath), pcmEvidence: pcmEvidenceFingerprint(recordPath), retained: sourceEntries(recordPath) };
}

function fingerprintOfEvidence(evidence) {
  return sha256Json({ marker: evidence.marker, native: sha256Json(evidence.native), pcmEvidence: evidence.pcmEvidence,
    retained: sha256Json(evidence.retained) });
}

function nativeRecordingFingerprint(recordPath) {
  return fingerprintOfEvidence(nativeRecordingEvidence(recordPath));
}

// Which recorded files changed between two evidence snapshots, and whether
// only their timestamps did: same files, same sizes, same source metadata.
function describeSourceChange(before, after) {
  const files = evidence => {
    const entries = new Map();
    for (const source of evidence.native) {
      for (const [file, size, mtime, ctime] of source.chunks) entries.set(file, { size, mtime, ctime });
    }
    for (const [file, size, mtime] of evidence.retained) entries.set(file, { size, mtime });
    return entries;
  };
  const withoutTimes = evidence => JSON.stringify({ marker: evidence.marker, pcmEvidence: evidence.pcmEvidence,
    native: evidence.native.map(source => ({ ...source, chunks: source.chunks.map(([file, size]) => [file, size]) })),
    retained: evidence.retained.map(([file, size]) => [file, size]) });
  const previous = files(before), current = files(after), changes = [];
  for (const [file, stat] of current) {
    const old = previous.get(file);
    const fields = old ? Object.keys(stat).filter(key => stat[key] !== old[key]) : ['added'];
    if (fields.length) changes.push(`${file} ${fields.join('+')}`);
  }
  for (const file of previous.keys()) if (!current.has(file)) changes.push(`${file} removed`);
  const metadata = evidence => JSON.stringify({ marker: evidence.marker, pcmEvidence: evidence.pcmEvidence,
    native: evidence.native.map(({ chunks, ...source }) => source) });
  if (metadata(before) !== metadata(after)) changes.push('source metadata');
  return { timestampsOnly: withoutTimes(before) === withoutTimes(after), changes };
}

function describeChanges(changes) {
  return changes.slice(0, 4).join(', ') + (changes.length > 4 ? ` and ${changes.length - 4} more` : '');
}

// Only a native-finalization-* directory directly inside this recording.
async function removeSupersededScratch(recordPath, directory) {
  if (typeof directory !== 'string') return;
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(recordPath) || !path.basename(resolved).startsWith('native-finalization-')) return;
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
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
