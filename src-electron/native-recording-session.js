'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./durable-files');

const NATIVE_CAPTURE_MODE = 'native-sources-v1';
const NATIVE_CAPTURE_MARKER = 'native-capture.json';

function usesNativeSources(recordPath) {
  // Presence fails closed, including an interrupted/empty source reservation.
  return fs.existsSync(path.join(recordPath, NATIVE_CAPTURE_MARKER)) ||
    fs.existsSync(path.join(recordPath, 'native-sources'));
}

function readNativeCaptureMarker(recordPath) {
  const file = path.join(recordPath, NATIVE_CAPTURE_MARKER);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid native capture session');
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (marker.version !== 1 || marker.captureMode !== NATIVE_CAPTURE_MODE) throw new Error('Unknown native capture session');
  return marker;
}

async function markNativeCaptureSession(recordPath) {
  const file = path.join(recordPath, NATIVE_CAPTURE_MARKER);
  const marker = { version: 1, captureMode: NATIVE_CAPTURE_MODE };
  if (fs.existsSync(file)) readNativeCaptureMarker(recordPath);
  await writeFileAtomic(file, JSON.stringify(marker));
}

module.exports = { NATIVE_CAPTURE_MODE, NATIVE_CAPTURE_MARKER, usesNativeSources, readNativeCaptureMarker, markNativeCaptureSession };
