'use strict';

/**
 * Crash recovery of interrupted recordings and the clean-up of old empty
 * recording folders. Moved out of electron-main.js in review round 9
 * (council 3, R-S4).
 *
 * - Starts only with a SessionScope (released session: not signed out, no
 *   tombstone, not held). Without one there is no recovery and no clean-up;
 *   main starts them again after the next sign-in (afterSessionApplied) and
 *   when a held start is released.
 * - Every effect goes through the scope: history, active-recording state,
 *   queue, renderer events, the re-scan timer, ffprobe and the finalization
 *   port (its media work writes only temporary files; publishing - each
 *   rename, the marker, metadata, history - is checked by the publish gate
 *   of the scope right before the system call).
 * - A session change ends the run: nothing more is written, the attempt is
 *   not counted (recoveryAttempts unchanged) and no source is deleted.
 * - The clean-up runs only after a complete, not aborted recovery in the
 *   same scope.
 */

const path = require('path');
const { isSessionEnded } = require('./ended');
const queueOps = require('./queue-ops');

// Never resurrect a recording the user finished with or explicitly
// dismissed. Terminal states include upload success AND user intent
// (skipped/cancelled).
const TERMINAL_STATUSES = ['completed', 'uploaded', 'skipped', 'cancelled', 'pending_verification'];

/**
 * @param {object} d
 * @param {object} d.read - read-only helpers of main (paths, recording state, finalized receipt, sources, validation)
 * @param {object} d.pure - safeParseDuration, repairRecoveredHistoryRecord, withCaptureWarnings
 * @param {object} d.pending - background/pending-uploads.js (queue run of the same scope)
 * @param {object} d.report - telemetry
 * @param {object} d.config - FINALIZATION_PENDING_MARKER, rescanMs
 * @param {object} d.log
 */
function createRecovery({ read, pure, pending, report, config, log }) {
  let running = null;      // scope of the recovery in progress
  let completed = null;    // scope whose recovery completed (once per session)

  /** @returns {Promise<{ completed: true } | { sessionEnded: true } | { skipped: true } | { failed: true }>} */
  async function recoverOrphanedRecordings(scope, { rescan = false } = {}) {
    if (running && running.alive()) {
      log.warn('Recovery already in progress, skipping');
      return { skipped: true };
    }
    // Once per session: a completed run of a scope that is still alive.
    if (!rescan && completed && completed.alive()) return { skipped: true };
    running = scope;
    try {
      await recoverIn(scope);
      completed = scope;
      return { completed: true };
    } catch (error) {
      if (isSessionEnded(error) || !scope.alive()) {
        log.info('Recovery ended by a session change; it runs again after the next sign-in');
        return { sessionEnded: true };
      }
      // Not complete: no clean-up after it; the next start tries again.
      log.error('Error during orphaned recording recovery:', error);
      report.captureException(error);
      return { failed: true };
    } finally {
      if (running === scope) running = null;
    }
  }

  async function recoverIn(scope) {
    const recordingsPath = read.getRecordingsPath();
    if (!scope.fs.existsSync(recordingsPath)) {
      log.info('No recordings directory found, skipping recovery');
      scope.update.active(() => null);
      return;
    }

    // Check if there's an active recording that was interrupted
    const activeSession = scope.read.active();
    if (activeSession) log.info('Found interrupted recording session:', activeSession.recordId);

    // Scan for directories with chunks that don't have a combined audio file
    const dirs = scope.fs.readdirSync(recordingsPath);
    let recoveredCount = 0;
    let totalAttempted = 0;
    let skippedLive = false;
    let skippedFresh = false;
    const recoveredForUpload = []; // {recordId, filePath, metadata} to enqueue for autonomous upload
    const recoveredRecords = [];   // lightweight {id, createdAt, durationSeconds} for the renderer toast

    for (const dir of dirs) {
      scope.assertAlive();
      try {
        const dirPath = path.join(recordingsPath, dir);
        const stats = scope.fs.statSync(dirPath);
        if (!stats.isDirectory()) continue;

        const chunksPath = path.join(dirPath, 'chunks');
        const audioPath = path.join(dirPath, 'audio.webm');

        // A filename is not a completion record: FFmpeg can leave a partial
        // output after a crash. Check the durable receipt, then repair history.
        const state = read.recordingState(dir);
        if (state.inFlight || state.locked) continue;
        const existingRecord = scope.read.history().find(r => r.id === dir);
        const finalized = scope.fs.existsSync(path.join(dirPath, config.FINALIZATION_PENDING_MARKER)) ? null : await read.readFinalizedRecording(dirPath);
        scope.assertAlive();
        if (finalized && existingRecord?.filePath === finalized.outputPath &&
            !['recording', 'processing', 'stopped'].includes(existingRecord.uploadStatus)) continue;

        // Check if there are chunks or sessions to recover
        const chunkFiles = scope.fs.existsSync(chunksPath)
          ? scope.fs.readdirSync(chunksPath).filter(f => f.startsWith('chunk_'))
          : [];
        const hasChunks = chunkFiles.length > 0;
        const hasSessions = read.listSessions(dirPath).length > 0;
        const hasBatches = read.listChunkBatches(dirPath).length > 0;
        const hasOutput = scope.fs.existsSync(audioPath);
        const pcmPath = path.join(dirPath, 'system_audio.raw');
        const hasPcm = scope.fs.existsSync(pcmPath) && scope.fs.statSync(pcmPath).size > 0;
        const hasNative = read.usesNativeSources(dirPath);
        if (!hasChunks && !hasSessions && !hasBatches && !hasOutput && !hasPcm && !hasNative) continue;
        // Older releases deleted sources after combining and wrote no receipt.
        // Such an audio.webm that history already points at, in a settled state,
        // needs nothing; without this every launch "recovered" it again.
        if (!finalized && hasOutput && !hasChunks && !hasSessions && !hasBatches && !hasPcm && !hasNative &&
            existingRecord?.filePath === audioPath && TERMINAL_STATUSES.includes(existingRecord.uploadStatus)) continue;

        // Never touch a recording that is being written RIGHT NOW: recovering
        // it would combine and DELETE its live chunks mid-recording.
        if (state.unsaved || state.live) {
          log.info(`Recovery: skipping ${dir} — recording is live`);
          skippedLive = true;
          continue;
        }
        // Freshness backstop in case active-session tracking is stale: a chunk
        // written within the last 60s means a recorder is (or was just)
        // writing here — leave it for the re-scan.
        if (hasChunks) {
          try {
            const newestChunk = chunkFiles.reduce((best, f) => {
              const n = parseInt(f.replace('chunk_', ''), 10);
              return Number.isFinite(n) && n > best.n ? { n, f } : best;
            }, { n: -1, f: null });
            if (newestChunk.f) {
              const ageMs = Date.now() - scope.fs.statSync(path.join(chunksPath, newestChunk.f)).mtimeMs;
              if (ageMs < 60000) {
                log.info(`Recovery: skipping ${dir} — chunks still being written (${Math.round(ageMs / 1000)}s old)`);
                skippedLive = true;
                skippedFresh = true;
                continue;
              }
            }
          } catch (e) {
            log.warn(`Recovery: freshness check failed for ${dir}:`, e.message);
          }
        }

        totalAttempted++;
        log.info(`Attempting to recover orphaned recording: ${dir}`);

        let result = finalized;
        // Older releases removed sources after finalization. Restore a surviving
        // legacy output into history instead of making it invisible.
        if (!result && hasOutput && !hasChunks && !hasSessions && !hasBatches && !hasNative) {
          const eligibility = await read.assessRecordingUpload({ recordId: dir, filePath: audioPath, recordingsRoot: recordingsPath });
          scope.assertAlive();
          const validation = eligibility.allowed && read.validateAudioOutput(audioPath);
          if (validation?.valid) {
            const duration = pure.safeParseDuration(await scope.port.probeAudio(audioPath));
            result = { success: true, outputPath: audioPath, duration, fileSize: validation.size, fileSizeMb: (validation.size / 1048576).toFixed(2) };
          }
        }
        // Media work writes temporary files only; the port publishes through
        // the publish gate of this scope.
        if (!result) result = await scope.port.finalizeForRecovery(dir);

        if (result.success) {
          recoveredCount++;
          log.info(`Successfully recovered recording: ${dir} (${result.fileSizeMb}MB)`);

          // Add/update the history entry with the recovered file + "pending"
          // upload status. Read metadata.json for userId/startedAt/duration.
          let metadataUserId = null;
          let metadataStartedAt = null;
          let metadataDuration = 0;
          const metadataPath = path.join(dirPath, 'metadata.json');
          if (scope.fs.existsSync(metadataPath)) {
            try {
              const metadata = JSON.parse(scope.fs.readFileSync(metadataPath, 'utf8'));
              metadataUserId = metadata.userId;
              metadataStartedAt = metadata.startedAt;
              metadataDuration = metadata.duration || 0;
              log.info(`Read metadata.json for ${dir}: userId=${metadataUserId}, startedAt=${metadataStartedAt}`);
            } catch (e) {
              log.warn(`Could not read metadata.json for ${dir}:`, e.message);
            }
          }
          const recoveredFileSize = result.fileSize || parseFloat(result.fileSizeMb) * 1024 * 1024;
          metadataDuration = result.duration || metadataDuration;

          scope.update.history((recordings) => {
            const existingIndex = recordings.findIndex(r => r.id === dir);
            if (existingIndex === -1) {
              // No history entry yet — create one for the recovered recording.
              const matchingActive = activeSession?.recordId === dir ? activeSession : null;
              const userId = metadataUserId || matchingActive?.userId || 'unknown';
              const createdAt = metadataStartedAt || matchingActive?.startedAt || new Date().toISOString();
              recordings.push(pure.withCaptureWarnings({
                id: dir,
                userId,
                createdAt,
                duration: metadataDuration,
                fileSize: recoveredFileSize,
                filePath: result.outputPath,
                uploadStatus: 'pending',
                storagePreference: 'keep',
                recovered: true
              }, recordingsPath));
              log.info(`Added recovered recording to history: ${dir} (userId: ${userId})`);
              recoveredForUpload.push({ recordId: dir, filePath: result.outputPath, metadata: { duration: String(metadataDuration || 0) } });
              recoveredRecords.push({ id: dir, createdAt, durationSeconds: metadataDuration || 0 });
              return recordings;
            }
            // A history entry already EXISTS (created at record-start, stuck at
            // 'recording' with an empty filePath because the app died
            // mid-recording). Update it in place so the recovered file becomes
            // visible and gets uploaded; never clobber a terminal status.
            const existing = recordings[existingIndex];
            const terminal = TERMINAL_STATUSES.includes(existing.uploadStatus);
            recordings[existingIndex] = pure.withCaptureWarnings({
              ...pure.repairRecoveredHistoryRecord(existing, { ...result, fileSize: recoveredFileSize, duration: metadataDuration }),
              uploadStatus: terminal ? existing.uploadStatus : 'pending',
              recovered: true
            }, recordingsPath);
            log.info(`Updated recovered recording history: ${dir} (status ${existing.uploadStatus} -> ${recordings[existingIndex].uploadStatus}, canonical filePath repaired)`);
            if (!terminal) {
              const finalRec = recordings[existingIndex];
              recoveredForUpload.push({ recordId: dir, filePath: finalRec.filePath, metadata: { duration: String(finalRec.duration || 0), ...(finalRec.prep || {}) } });
              recoveredRecords.push({ id: dir, createdAt: finalRec.createdAt, durationSeconds: finalRec.duration || 0 });
            }
            return recordings;
          });
        } else {
          log.warn(`Could not recover recording ${dir}: ${result.error}`);
          scope.notify('system:capture-warning', { kind: 'recovery-failed', recordId: dir });
        }
      } catch (err) {
        // A session change ends the whole run (nothing more written, the
        // attempt not counted); any other error only this directory.
        if (isSessionEnded(err) || !scope.alive()) throw err;
        log.error(`Error processing directory ${dir} for recovery:`, err);
      }
    }

    // Only clear active recording state if recovery succeeded or there was nothing to recover.
    // If all attempts failed, preserve state so next startup retries.
    if (skippedLive) {
      // The active session belongs to a recording that is live (or freshly
      // written) right now — leave its crash-recovery state untouched.
    } else if (totalAttempted === 0 || recoveredCount > 0) {
      scope.update.active(() => null);
    } else {
      // Track failed recovery attempts to avoid infinite retries
      const attempts = (activeSession?.recoveryAttempts || 0) + 1;
      if (attempts >= 3) {
        log.error(`Recovery failed ${attempts} times, giving up on active recording`);
        report.captureMessage(`Recording recovery failed after ${attempts} attempts`, 'error');
        scope.update.active(() => null);
      } else if (activeSession) {
        scope.update.active(() => ({ ...activeSession, recoveryAttempts: attempts }));
        log.warn(`Recovery failed (attempt ${attempts}/3), will retry on next startup`);
      }
    }

    if (recoveredCount > 0) {
      log.info(`Recovery complete: ${recoveredCount} recording(s) recovered`);
      // Enqueue recovered recordings into the main-process upload queue so
      // they upload even if the renderer never comes up.
      for (const u of recoveredForUpload) {
        try {
          const owner = read.recordingOwner(u.recordId);
          scope.update.queue((q) => queueOps.addToQueue(q, { recordId: u.recordId, filePath: u.filePath, metadata: u.metadata, userId: owner }));
        } catch (e) {
          if (isSessionEnded(e)) throw e;
          log.warn('recovery: enqueue failed:', e.message);
        }
      }
      // Count only recordings that actually came back to the user.
      if (recoveredRecords.length > 0) {
        scope.notify('recording:recovered', { count: recoveredRecords.length, records: recoveredRecords });
      }
      // Kick the queue immediately in this scope (no new ticket).
      if (recoveredForUpload.length > 0) {
        scope.timer(0, () => {
          pending.run(scope).catch(err => log.error('recovery: upload processing failed:', err));
        });
      }
    }

    // A dir was skipped because its chunks were written <60s ago but no
    // recording is in progress (crash-then-quick-reopen). Re-scan once the
    // freshness window has passed, in the same scope.
    if (skippedFresh && !read.recordingInProgress()) {
      log.info('Recovery: scheduling re-scan in 2 minutes for freshly-written chunk dirs');
      scope.timer(config.rescanMs, () => {
        recoverOrphanedRecordings(scope, { rescan: true }).catch(err => log.error('Error in recovery re-scan:', err));
      });
    }
  }

  // === Cleanup Old Orphaned Directories ===
  // Remove directories that are older than 7 days and have no audio file.
  async function cleanupOldOrphanedDirectories(scope) {
    try {
      const recordingsPath = read.getRecordingsPath();
      if (!scope.fs.existsSync(recordingsPath)) return { completed: true };
      const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
      const now = Date.now();
      let cleanedCount = 0;
      for (const dir of scope.fs.readdirSync(recordingsPath)) {
        scope.assertAlive();
        try {
          const dirPath = path.join(recordingsPath, dir);
          const stats = scope.fs.statSync(dirPath);
          if (!stats.isDirectory()) continue;
          const hasAudioFile = scope.fs.existsSync(path.join(dirPath, 'audio.webm')) ||
            read.usesNativeSources(dirPath) ||
            read.listChunkBatches(dirPath).length > 0 ||
            (scope.fs.existsSync(path.join(dirPath, 'system_audio.raw')) && scope.fs.statSync(path.join(dirPath, 'system_audio.raw')).size > 0);
          const isOld = (now - stats.mtimeMs) > MAX_AGE_MS;
          if (!isOld || hasAudioFile) continue;
          const chunksPath = path.join(dirPath, 'chunks');
          const sessionsPath = path.join(dirPath, 'sessions');
          const hasChunks = scope.fs.existsSync(chunksPath);
          const hasSessions = scope.fs.existsSync(sessionsPath);
          if (!hasChunks && !hasSessions) continue;
          const chunkFiles = hasChunks ? scope.fs.readdirSync(chunksPath).filter(f => f.startsWith('chunk_')) : [];
          const sessionFiles = hasSessions ? scope.fs.readdirSync(sessionsPath).filter(f => f.endsWith('.webm')) : [];
          if (chunkFiles.length > 0 || sessionFiles.length > 0) {
            // NEVER delete directories with audio data — user might still want it
            log.warn(`Keeping old orphaned directory with ${chunkFiles.length} chunks, ${sessionFiles.length} sessions: ${dir}`);
            continue;
          }
          // Empty chunks/sessions dirs — safe to clean up
          log.info(`Cleaning up old empty orphaned directory: ${dir}`);
          try {
            await scope.fs.rmRecordingDir(recordingsPath, dirPath);
            cleanedCount++;
          } catch (err) {
            if (isSessionEnded(err)) throw err;
            log.warn(`Cleanup failed for ${dirPath} (recovery-orphans): ${err.code || err.message}`);
            report.captureMessage(`rmDirSafe failed: ${err.code || 'unknown'}`, { level: 'warning', tags: { operation: 'recovery-orphans' }, extra: { dirPath, errorCode: err.code, errorMessage: err.message } });
          }
        } catch (err) {
          if (isSessionEnded(err) || !scope.alive()) throw err;
          log.error(`Error checking directory ${dir} for cleanup:`, err);
        }
      }
      if (cleanedCount > 0) log.info(`Cleaned up ${cleanedCount} old orphaned directory(ies)`);
      return { completed: true };
    } catch (error) {
      if (isSessionEnded(error) || !scope.alive()) return { sessionEnded: true };
      log.error('Error during orphaned directory cleanup:', error);
      return { completed: true };
    }
  }

  /**
   * Recovery, then (only after a complete, not aborted run in the same
   * scope) the clean-up. Once per session; a second start in the same
   * session is skipped.
   */
  async function runRecoveryAndCleanup(scope) {
    const outcome = await recoverOrphanedRecordings(scope);
    if (!outcome.completed || !scope.alive()) return outcome;
    return cleanupOldOrphanedDirectories(scope);
  }

  return {
    recoverOrphanedRecordings,
    cleanupOldOrphanedDirectories,
    runRecoveryAndCleanup,
    /** recording:isRecoveryRunning (renderer waits before a new recording). */
    isRunning: () => !!running && running.alive(),
  };
}

module.exports = { createRecovery, TERMINAL_STATUSES };
