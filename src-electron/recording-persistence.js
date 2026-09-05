'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
function createRecordingPersistence({ prepareRaw, remux, concatSessions, merge, validate, probe, fromPcm }) {
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

  async function finalize(recordPath, ext = '.webm') {
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
    if (![1, 2].includes(receipt.version) || receipt.filename !== 'audio.webm' || !/^[a-f0-9]{64}$/.test(receipt.sha256)) return null;
    const pcmPath = path.join(recordPath, 'system_audio.raw');
    const hasPcm = fs.existsSync(pcmPath) && fs.statSync(pcmPath).size > 0;
    // Version 1 could acknowledge a mic-only file even after its system merge
    // failed. Its checksum proves file identity, not inclusion of participants.
    if (receipt.version === 1 && hasPcm) return null;
    if (receipt.version === 2 && (hasPcm
      ? !['microphone-and-system', 'system-only'].includes(receipt.sourceMode)
      : receipt.sourceMode !== 'microphone')) return null;
    if (receipt.sourceFingerprint !== sourceFingerprint(recordPath)) return null;
    const outputPath = path.join(recordPath, receipt.filename);
    const size = fs.statSync(outputPath).size;
    if (size !== receipt.size || await checksum(outputPath) !== receipt.sha256) return null;
    return { success: true, outputPath, duration: receipt.duration || 0, fileSize: size, fileSizeMb: (size / 1048576).toFixed(2) };
  } catch (_) { return null; }
}

module.exports = { createRecordingPersistence, readFinalizedRecording, listSessions, checksum };
