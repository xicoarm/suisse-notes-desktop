'use strict';

const fs = require('fs');
const path = require('path');

function warningKinds(value) {
  return Array.isArray(value) ? value.filter(kind => typeof kind === 'string' && kind.trim()).map(kind => kind.trim()) : [];
}

// History keeps its own copy so a warning remains visible after explicit local
// audio deletion. Read only a managed recording's metadata, never filePath (an
// imported audio file can live anywhere), and never adopt another owner's data.
function withCaptureWarnings(recording, recordingsPath, previousWarnings = []) {
  let metadataWarnings = [];
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(recording.id || '')) {
    try {
      const directory = path.join(recordingsPath, recording.id);
      if (!fs.lstatSync(directory).isSymbolicLink()) {
        const metadataPath = path.join(directory, 'metadata.json');
        if (!fs.lstatSync(metadataPath).isSymbolicLink()) {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          if (!metadata.userId || metadata.userId === recording.userId) metadataWarnings = warningKinds(metadata.captureWarnings);
        }
      }
    } catch (_) { /* Missing/unreadable legacy metadata must not hide history. */ }
  }
  const captureWarnings = [...new Set([...warningKinds(previousWarnings), ...warningKinds(recording.captureWarnings), ...metadataWarnings])];
  if (Array.isArray(recording.captureWarnings) && recording.captureWarnings.length === captureWarnings.length &&
      recording.captureWarnings.every((kind, index) => kind === captureWarnings[index])) return recording;
  return { ...recording, captureWarnings };
}

function hydrateHistoryCaptureWarnings(recordings, userId, recordingsPath) {
  return recordings.map(recording => userId && recording.userId === userId
    ? withCaptureWarnings(recording, recordingsPath) : recording);
}

module.exports = { withCaptureWarnings, hydrateHistoryCaptureWarnings };
