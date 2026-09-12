'use strict';

const fs = require('fs');
const path = require('path');
const { inspectNativeSources } = require('./native-source-persistence');
const { readFinalizedRecording } = require('./recording-persistence');
const { FINALIZATION_PENDING_MARKER } = require('./recording-upload-eligibility');

function failure(code, message) { return Object.assign(new Error(message), { code }); }
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

// Validate this export only; do not expand the authority of generic path IPCs.
function exportPath(recordingsPath, sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw failure('invalid_source', 'Invalid recording path');
  const root = path.resolve(recordingsPath), file = path.resolve(sourcePath);
  if (!inside(root, file)) throw failure('invalid_source', 'Invalid recording path');
  const rootStat = stat(root);
  if (!rootStat) return file; // Missing storage is reported without creating it.
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('invalid_source', 'Unsafe recording directory');
  let current = root;
  for (const name of path.relative(root, file).split(path.sep)) {
    current = path.join(current, name);
    const entry = stat(current);
    if (!entry) break;
    if (entry.isSymbolicLink() || !inside(fs.realpathSync(root), fs.realpathSync(current))) {
      throw failure('invalid_source', 'Unsafe recording path');
    }
  }
  return file;
}

function hasRetainedSources(directory) {
  const directoryStat = stat(directory);
  if (!directoryStat) return false;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw failure('invalid_source', 'Unsafe recording directory');
  const files = (folder, pattern) => {
    const entry = stat(folder);
    if (!entry) return false;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw failure('invalid_source', 'Unsafe recording source directory');
    let found = false;
    for (const name of fs.readdirSync(folder).filter(name => pattern.test(name))) {
      const source = stat(path.join(folder, name));
      if (!source?.isFile() || source.isSymbolicLink()) throw failure('invalid_source', 'Unsafe recording source');
      found = found || source.size > 0;
    }
    return found;
  };
  let found = files(path.join(directory, 'chunks'), /^chunk_\d+\.webm$/);
  found = files(path.join(directory, 'sessions'), /^session_\d+\.webm$/) || found;
  const batches = path.join(directory, 'source-chunks'), batchStat = stat(batches);
  if (batchStat) {
    if (!batchStat.isDirectory() || batchStat.isSymbolicLink()) throw failure('invalid_source', 'Unsafe recording batches');
    for (const name of fs.readdirSync(batches).filter(name => /^\d+$/.test(name))) found = files(path.join(batches, name), /^chunk_\d+\.webm$/) || found;
  }
  const pcm = stat(path.join(directory, 'system_audio.raw'));
  if (pcm && (!pcm.isFile() || pcm.isSymbolicLink())) throw failure('invalid_source', 'Unsafe system audio source');
  found = (pcm?.size > 0) || found;
  // A reservation/attempt marker alone is not audio. The real native parser
  // also checks native metadata and unsafe source paths. The finalizer owns
  // complete chunk/timestamp coverage validation before publishing anything.
  return inspectNativeSources(directory).some(source => source.hasAudio) || found;
}

function assertExportRecoveryReady(directory, busy) {
  if (busy) throw failure('recording_busy', 'Finish recording, saving or transferring audio before recovering this recording.');
  if (!hasRetainedSources(directory)) throw failure('source_missing', 'The local audio file and its original audio sources are unavailable on this computer.');
}

// A validated result is authoritative for local location and byte size only.
// Upload state, remote identifiers and explicit user choices remain untouched.
function repairRecoveredHistoryRecord(existing, result) {
  const previousWarnings = Array.isArray(existing.captureWarnings) ? existing.captureWarnings : [];
  return { ...existing, filePath: result.outputPath, fileSize: result.fileSize,
    duration: existing.duration > 0 ? existing.duration : result.duration,
    recovered: true,
    captureWarnings: [...new Set([...previousWarnings, ...(result.warnings || []).map(warning =>
      typeof warning === 'string' ? warning : warning?.kind || warning?.code || 'native-source-recovery')]
      .filter(warning => typeof warning === 'string' && warning.trim()))] };
}

function createRecordingExporter({ recordingsPath, validateRecordId, getOwner, getCurrentUserId,
  isBusy, isLocked, withRecordingLock, finalize, repairHistory, saveAs }) {
  async function authorize(id) {
    const owner = getOwner(id), current = await getCurrentUserId();
    if (!owner || owner === 'unknown' || owner !== current) throw failure('recording_owner_required', 'Sign in as the recording owner to recover this audio.');
    return owner;
  }
  return async (sourcePath, suggestedName) => {
    try {
      const root = recordingsPath(), source = exportPath(root, sourcePath);
      const existing = stat(source);
      if (existing && !existing.isFile()) throw failure('invalid_source', 'The recording path is not an audio file');
      const relative = path.relative(root, source).split(path.sep);
      const canonical = relative.length === 2 && relative[1] === 'audio.webm';
      // A failed recovery can publish audio before its durable receipt fails.
      // Do not turn the next click into success merely because a file exists.
      const pending = canonical && stat(path.join(path.dirname(source), FINALIZATION_PENDING_MARKER));
      if (existing && !pending) {
        return await saveAs(source, suggestedName);
      }
      if (!canonical) throw failure('source_missing', 'The local audio file is unavailable on this computer.');
      const id = validateRecordId(relative[0]), directory = path.dirname(source);
      await authorize(id);
      if (isLocked(id)) throw failure('recording_busy', 'This recording is being saved or transferred. Please try again after it finishes.');
      assertExportRecoveryReady(directory, isBusy(id));
      return await withRecordingLock(id, async () => {
        const owner = await authorize(id);
        exportPath(root, source);
        assertExportRecoveryReady(directory, isBusy(id));
        const result = await finalize(id);
        if (!result?.success) throw failure(result?.code || 'recovery_failed', result?.error || 'The recording could not be recovered. Original audio is retained.');
        // Only the existing finalizer's complete receipt authorizes exporting
        // a rebuilt file. A scratch file or success flag is insufficient.
        const verified = await readFinalizedRecording(directory);
        if (!verified || verified.outputPath !== source || stat(path.join(directory, FINALIZATION_PENDING_MARKER))) {
          throw failure('recovery_failed', 'Recovered audio could not be verified. Original audio is retained.');
        }
        if (await authorize(id) !== owner) throw failure('recording_owner_required', 'The signed-in account changed during recovery.');
        const repaired = repairHistory(id, owner, { ...verified, warnings: result.warnings || verified.warnings });
        if (!repaired) throw failure('recording_owner_required', 'The recording history changed during recovery.');
        exportPath(root, source);
        const saved = await saveAs(source, suggestedName);
        return { ...saved, recovered: true, captureWarnings: repaired.captureWarnings || [] };
      });
    } catch (error) {
      return { success: false, error: error.code || 'export_failed', message: error.message };
    }
  };
}

module.exports = { createRecordingExporter, repairRecoveredHistoryRecord, assertExportRecoveryReady, hasRetainedSources, exportPath };
