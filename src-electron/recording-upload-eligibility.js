'use strict';

const fs = require('fs');
const path = require('path');
const { readFinalizedRecording } = require('./recording-persistence');
const { usesNativeSources } = require('./native-recording-session');

// Main should publish this before finalization and remove it only after a new
// complete receipt is durable. Its presence is authoritative even if an older
// output/receipt still matches unchanged source files.
const FINALIZATION_PENDING_MARKER = 'finalization-pending.json';
const recoveryRequired = error => ({ allowed: false, requiresFinalization: true,
  error: error || 'Finish saving or recovering this recording before uploading it. All local audio is retained.' });
const comparablePath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);

async function statOptional(file) {
  try { return await fs.promises.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function sourceDirectory(directory) {
  const stat = await statOptional(directory);
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('A recording source directory is malformed');
  return fs.promises.readdir(directory, { withFileTypes: true });
}

function assertSourceFiles(entries, pattern) {
  const atomicTemporary = /\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/i;
  if (entries.some(entry => !entry.isFile() || (!pattern.test(entry.name) && !atomicTemporary.test(entry.name)))) {
    throw new Error('Recording source files are incomplete or malformed');
  }
}

/**
 * Read-only upload gate for this app's generated audio.webm. Imported paths and
 * source-free legacy output keep their existing handling. A generated output
 * with retained sources or a completion receipt must match the current durable
 * receipt, including source fingerprint and output hash. Inspection errors fail
 * closed; they are never interpreted as absence of source audio.
 *
 * Call under the existing recording/upload ownership guard before receipt resume
 * or any network transfer. This is an eligibility snapshot, not a filesystem lock.
 */
async function assessRecordingUpload({ recordId, filePath, recordingsRoot } = {}) {
  if (typeof recordId !== 'string' || !recordId || recordId === '.' || recordId === '..' || /[/\\]/.test(recordId) ||
      typeof filePath !== 'string' || !filePath || typeof recordingsRoot !== 'string' || !recordingsRoot) {
    return recoveryRequired('The recording location is invalid. Local files were not changed.');
  }
  const recordPath = path.resolve(recordingsRoot, recordId);
  const generatedPath = path.join(recordPath, 'audio.webm');
  if (comparablePath(path.dirname(recordPath)) !== comparablePath(recordingsRoot)) {
    return recoveryRequired('The recording location is outside its managed directory.');
  }
  if (comparablePath(filePath) !== comparablePath(generatedPath)) {
    return { allowed: true, requiresFinalization: false };
  }

  try {
    if (await statOptional(path.join(recordPath, FINALIZATION_PENDING_MARKER))) return recoveryRequired();
    const receiptStat = await statOptional(path.join(recordPath, 'finalized.json'));
    if (receiptStat && (!receiptStat.isFile() || receiptStat.isSymbolicLink())) return recoveryRequired();

    let hasSources = false;
    const chunks = await sourceDirectory(path.join(recordPath, 'chunks'));
    if (chunks) {
      assertSourceFiles(chunks, /^chunk_\d+\.webm$/);
      hasSources ||= chunks.length > 0;
    }
    const batches = await sourceDirectory(path.join(recordPath, 'source-chunks'));
    if (batches) {
      for (const batch of batches) {
        if (!batch.isDirectory() || !/^\d+$/.test(batch.name)) throw new Error('A recording source batch is malformed');
        const files = await sourceDirectory(path.join(recordPath, 'source-chunks', batch.name));
        if (!files?.length) throw new Error('A recording source batch is empty or missing');
        assertSourceFiles(files, /^chunk_\d+\.webm$/);
      }
      hasSources ||= batches.length > 0;
    }
    const sessions = await sourceDirectory(path.join(recordPath, 'sessions'));
    if (sessions) {
      assertSourceFiles(sessions, /^(?:session_\d+|source_(?:raw|building|final))\.webm$/);
      hasSources ||= sessions.length > 0;
    }
    // Version 3 receipts bind the native archive, its session authority marker,
    // retained live mix and AudioTee PCM. Older mix-only receipts cannot pass.
    hasSources ||= usesNativeSources(recordPath);
    const pcm = await statOptional(path.join(recordPath, 'system_audio.raw'));
    if (pcm && (!pcm.isFile() || pcm.isSymbolicLink())) throw new Error('The system audio source is malformed');
    hasSources ||= Boolean(pcm?.size);
    if (!hasSources && !receiptStat) return { allowed: true, requiresFinalization: false };

    // This performs the one full output checksum needed for eligibility. Avoid
    // separately hashing it here and repeating the same multi-hour file read.
    const finalized = await readFinalizedRecording(recordPath);
    if (!finalized || comparablePath(finalized.outputPath) !== comparablePath(filePath)) return recoveryRequired();
    return { allowed: true, requiresFinalization: false };
  } catch (_) {
    return recoveryRequired('The saved audio could not be inspected safely. Retry saving or recovering the recording before uploading it.');
  }
}

module.exports = { assessRecordingUpload, FINALIZATION_PENDING_MARKER };
