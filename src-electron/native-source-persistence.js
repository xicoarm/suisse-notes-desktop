'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic, syncFile, syncDirectorySync, renameWithRetry } = require('./durable-files');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_OFFSET_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_CHUNKS = 10000000;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 16384;
// The main-process recording lock serializes operations for each recording.
// This cache is only an optimization: the first write after restart discovers
// the committed files, including a chunk published immediately before a crash.
const nextIndices = new Map();

function invalid(message) {
  const error = new Error(`Native audio sources: ${message}; originals retained`);
  error.code = 'NATIVE_SOURCE_INVALID';
  return error;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function onlyKeys(value, allowed, name) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw invalid(`invalid ${name}`);
  }
}

function validateId(sourceId) {
  if (typeof sourceId !== 'string' || !UUID.test(sourceId)) throw invalid('invalid source ID');
  return sourceId;
}

function offset(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > MAX_OFFSET_MS) throw invalid(`invalid ${name}`);
  return value;
}

function count(value, name = 'chunk count') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CHUNKS) throw invalid(`invalid ${name}`);
  return value;
}

function settings(value = {}) {
  if (!plainObject(value) || Object.keys(value).length > 32) throw invalid('invalid source settings');
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype', '__proto__'].includes(key) ||
        !(typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) ||
          (typeof item === 'string' && item.length <= 1024))) throw invalid('invalid source settings');
    result[key] = item;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 8192) throw invalid('source settings are too large');
  return result;
}

function manifestFrom(value, fromDisk = false) {
  onlyKeys(value, ['version', 'sourceId', 'kind', 'startOffsetMs', 'mimeType', 'settings'], 'source manifest');
  if ((fromDisk && value.version !== 1) || (!fromDisk && value.version !== undefined && value.version !== 1) ||
      !['microphone', 'system'].includes(value.kind) || typeof value.mimeType !== 'string' ||
      value.mimeType.length > 128 || !/^audio\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9_-]+\s*=\s*[a-z0-9.,+_ -]+)*$/i.test(value.mimeType)) {
    throw invalid('invalid source manifest');
  }
  return { version: 1, sourceId: validateId(value.sourceId), kind: value.kind,
    startOffsetMs: offset(value.startOffsetMs, 'reserved start offset'), mimeType: value.mimeType,
    settings: settings(value.settings) };
}

function startedFrom(value, manifest, fromDisk = false) {
  onlyKeys(value, ['version', 'sourceId', 'startOffsetMs'], 'source start marker');
  if ((fromDisk && (value.version !== 1 || value.sourceId !== manifest.sourceId)) ||
      (value.version !== undefined && value.version !== 1) ||
      (value.sourceId !== undefined && value.sourceId !== manifest.sourceId)) throw invalid('invalid source start marker');
  const startOffsetMs = offset(value.startOffsetMs, 'actual start offset');
  if (startOffsetMs < manifest.startOffsetMs) throw invalid('actual start precedes source reservation');
  return { version: 1, sourceId: manifest.sourceId, startOffsetMs };
}

function terminalFrom(value, manifest, started, fromDisk = false) {
  onlyKeys(value, ['version', 'sourceId', 'endOffsetMs', 'chunkCount', 'reason'], 'source end marker');
  if ((fromDisk && (value.version !== 1 || value.sourceId !== manifest.sourceId)) ||
      (value.version !== undefined && value.version !== 1) ||
      (value.sourceId !== undefined && value.sourceId !== manifest.sourceId) ||
      typeof value.reason !== 'string' || value.reason.length < 1 || value.reason.length > 128 ||
      [...value.reason].some(character => character.charCodeAt(0) < 32)) {
    throw invalid('invalid source end marker');
  }
  const endOffsetMs = offset(value.endOffsetMs, 'end offset');
  if (endOffsetMs < (started ? started.startOffsetMs : manifest.startOffsetMs)) throw invalid('source end precedes source start');
  const chunkCount = count(value.chunkCount);
  if (!started && chunkCount !== 0) throw invalid('unstarted source claims recorded chunks');
  return { version: 1, sourceId: manifest.sourceId, endOffsetMs, chunkCount, reason: value.reason };
}

function statMaybe(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function assertDirectory(directory, optional = false) {
  const stat = statMaybe(directory);
  if (!stat && optional) return false;
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw invalid(`missing or unsafe directory ${path.basename(directory)}`);
  return stat;
}

function paths(recordPath, sourceId) {
  if (typeof recordPath !== 'string' || !path.isAbsolute(recordPath)) throw invalid('recording directory must be absolute');
  const recording = path.resolve(recordPath);
  assertDirectory(recording);
  const root = path.join(recording, 'native-sources');
  if (sourceId === undefined) return { recording, root };
  validateId(sourceId);
  const directory = path.join(root, sourceId);
  return { recording, root, directory, chunks: path.join(directory, 'chunks'),
    manifest: path.join(directory, 'manifest.json'), started: path.join(directory, 'started.json'), end: path.join(directory, 'end.json') };
}

function readJson(file, optional = false) {
  const stat = statMaybe(file);
  if (!stat && optional) return undefined;
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_METADATA_BYTES) {
    throw invalid(`missing or invalid ${path.basename(file)}`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    throw invalid(`cannot read ${path.basename(file)} (${error.code || 'malformed JSON'})`);
  }
}

function readMetadata(layout) {
  assertDirectory(layout.root);
  assertDirectory(layout.directory);
  assertDirectory(layout.chunks);
  for (const name of fs.readdirSync(layout.directory)) {
    if (!['manifest.json', 'started.json', 'end.json', 'chunks'].includes(name) && !name.endsWith('.tmp')) {
      throw invalid(`unrecognized source entry ${name}`);
    }
  }
  const manifest = manifestFrom(readJson(layout.manifest), true);
  if (manifest.sourceId !== path.basename(layout.directory)) throw invalid('manifest source ID does not match directory');
  const startJson = readJson(layout.started, true);
  const started = startJson === undefined ? null : startedFrom(startJson, manifest, true);
  const endJson = readJson(layout.end, true);
  const terminal = endJson === undefined ? null : terminalFrom(endJson, manifest, started, true);
  return { manifest, started, terminal };
}

function inspectSource(layout, metadata = readMetadata(layout)) {
  const { manifest, started, terminal } = metadata;
  const chunks = [];
  for (const name of fs.readdirSync(layout.chunks)) {
    if (name.endsWith('.tmp')) continue;
    const match = /^chunk_(0|[1-9]\d*)\.webm$/.exec(name);
    if (!match) throw invalid(`unrecognized source chunk ${name}`);
    const index = count(Number(match[1]), 'chunk index');
    if (index >= MAX_CHUNKS) throw invalid('chunk index exceeds limit');
    const file = path.join(layout.chunks, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_CHUNK_BYTES) throw invalid(`invalid source chunk ${name}`);
    chunks.push({ index, path: file, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  }
  chunks.sort((a, b) => a.index - b.index);
  if (!started && chunks.length) throw invalid('source chunks have no durable start marker');
  const gaps = [];
  let next = 0;
  for (const chunk of chunks) {
    if (chunk.index > next) gaps.push({ start: next, end: chunk.index - 1 });
    next = chunk.index + 1;
  }
  const terminalMismatch = !!terminal && (terminal.chunkCount !== chunks.length || next !== terminal.chunkCount || gaps.length > 0);
  return { sourceId: manifest.sourceId, kind: manifest.kind, mimeType: manifest.mimeType, settings: manifest.settings,
    reservedStartOffsetMs: manifest.startOffsetMs, startOffsetMs: started ? started.startOffsetMs : null,
    started: !!started, directory: layout.directory, manifestPath: layout.manifest,
    startedPath: started ? layout.started : null, endPath: terminal ? layout.end : null,
    endOffsetMs: terminal ? terminal.endOffsetMs : null, reason: terminal ? terminal.reason : null,
    chunks, chunkPaths: chunks.map(chunk => chunk.path), chunkCount: chunks.length,
    expectedChunkCount: terminal ? terminal.chunkCount : null, gaps, terminalMismatch,
    interrupted: !terminal, complete: !!started && !!terminal && !gaps.length && !terminalMismatch,
    hasAudio: chunks.length > 0 };
}

function inspectNativeSources(recordPath) {
  const layout = paths(recordPath);
  if (!assertDirectory(layout.root, true)) return [];
  const sources = [];
  for (const sourceId of fs.readdirSync(layout.root)) {
    if (sourceId.endsWith('.tmp')) continue;
    sources.push(inspectSource(paths(recordPath, validateId(sourceId))));
  }
  return sources.sort((a, b) => (a.startOffsetMs ?? a.reservedStartOffsetMs) -
    (b.startOffsetMs ?? b.reservedStartOffsetMs) || a.sourceId.localeCompare(b.sourceId));
}

async function makeDirectory(directory) {
  if (!assertDirectory(directory, true)) await fs.promises.mkdir(directory);
  // A previous mkdir may have succeeded before its parent sync failed.
  syncDirectorySync(path.dirname(directory));
}

async function confirmExisting(file) {
  // A previous attempt can have renamed the file successfully and then failed
  // its directory sync. An exact retry still completes the durability boundary.
  await syncFile(file);
  syncDirectorySync(path.dirname(file));
}

async function beginSource(recordPath, options) {
  const manifest = manifestFrom(options);
  const layout = paths(recordPath, manifest.sourceId);
  await makeDirectory(layout.root);
  if (statMaybe(layout.directory)) {
    const metadata = readMetadata(layout);
    if (JSON.stringify(metadata.manifest) !== JSON.stringify(manifest)) throw invalid('source reservation conflicts with existing manifest');
    await confirmExisting(layout.manifest);
    // Replaying an ambiguous directory publication must also flush the parent
    // of the published UUID directory, not just its manifest entry.
    syncDirectorySync(layout.root);
    return { success: true, sourceId: manifest.sourceId, duplicate: true };
  }
  // A reservation is either fully visible or remains an unacknowledged .tmp
  // directory. A crash before its manifest publication cannot poison recovery
  // of earlier epochs with a public, unidentifiable UUID directory.
  const staging = path.join(layout.root, `${manifest.sourceId}.${crypto.randomUUID()}.tmp`);
  await makeDirectory(staging);
  await makeDirectory(path.join(staging, 'chunks'));
  await writeFileAtomic(path.join(staging, 'manifest.json'), JSON.stringify(manifest));
  syncDirectorySync(path.join(staging, 'chunks'));
  syncDirectorySync(staging);
  // Deliberately retain failed staging directories. Their audio provenance is
  // never inferred, and neither inspection nor a retry deletes crash evidence.
  await renameWithRetry(staging, layout.directory);
  return { success: true, sourceId: manifest.sourceId, duplicate: false };
}

async function markSourceStarted(recordPath, sourceId, options) {
  const layout = paths(recordPath, sourceId);
  const metadata = readMetadata(layout);
  const started = startedFrom(options, metadata.manifest);
  if (metadata.started) {
    if (JSON.stringify(metadata.started) !== JSON.stringify(started)) throw invalid('source start conflicts with existing marker');
    await confirmExisting(layout.started);
    return { success: true, sourceId, startOffsetMs: started.startOffsetMs, duplicate: true };
  }
  if (metadata.terminal) throw invalid('cannot start an ended source');
  await writeFileAtomic(layout.started, JSON.stringify(started));
  return { success: true, sourceId, startOffsetMs: started.startOffsetMs, duplicate: false };
}

function rememberIndex(layout, index) {
  const stat = fs.lstatSync(layout.chunks);
  nextIndices.delete(layout.directory);
  nextIndices.set(layout.directory, { index, ino: stat.ino, birthtimeMs: stat.birthtimeMs });
  if (nextIndices.size > 256) nextIndices.delete(nextIndices.keys().next().value);
}

function nextIndex(layout, metadata) {
  const cached = nextIndices.get(layout.directory);
  const stat = fs.lstatSync(layout.chunks);
  if (cached && cached.ino === stat.ino && cached.birthtimeMs === stat.birthtimeMs) return cached.index;
  const source = inspectSource(layout, metadata);
  if (source.gaps.length || source.terminalMismatch) throw invalid('source chunks contain a gap or terminal mismatch');
  rememberIndex(layout, source.chunkCount);
  return source.chunkCount;
}

function chunkBytes(value) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_CHUNK_BYTES) {
    throw invalid('invalid source chunk bytes');
  }
  // Own the bytes across the asynchronous flush, even if an IPC caller reuses
  // or changes its input buffer while the write is pending.
  return Buffer.from(value);
}

async function saveSourceChunk(recordPath, sourceId, bytes, index) {
  count(index, 'chunk index');
  if (index >= MAX_CHUNKS) throw invalid('chunk index exceeds limit');
  const data = chunkBytes(bytes);
  const layout = paths(recordPath, sourceId);
  const metadata = readMetadata(layout);
  if (!metadata.started) throw invalid('source has no durable start marker');
  const expected = nextIndex(layout, metadata);
  const destination = path.join(layout.chunks, `chunk_${index}.webm`);
  const existing = statMaybe(destination);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== data.length ||
        !fs.readFileSync(destination).equals(data)) throw invalid('chunk retry conflicts with saved bytes');
    if (index > expected) throw invalid('chunk index would leave a gap');
    await confirmExisting(destination);
    if (index === expected) rememberIndex(layout, expected + 1);
    return { success: true, sourceId, index, byteLength: data.length, duplicate: true };
  }
  if (metadata.terminal) throw invalid('cannot append to an ended source');
  if (index !== expected) throw invalid('chunk index would leave a gap or replace missing audio');
  await writeFileAtomic(destination, data);
  rememberIndex(layout, expected + 1);
  return { success: true, sourceId, index, byteLength: data.length, duplicate: false };
}

async function endSource(recordPath, sourceId, options) {
  const layout = paths(recordPath, sourceId);
  const metadata = readMetadata(layout);
  const terminal = terminalFrom(options, metadata.manifest, metadata.started);
  const source = inspectSource(layout, metadata);
  if (source.gaps.length || source.terminalMismatch || source.chunkCount !== terminal.chunkCount) {
    throw invalid('source end chunk count mismatch or gap');
  }
  if (metadata.terminal) {
    if (JSON.stringify(metadata.terminal) !== JSON.stringify(terminal)) throw invalid('source end conflicts with existing marker');
    await confirmExisting(layout.end);
  } else {
    await writeFileAtomic(layout.end, JSON.stringify(terminal));
  }
  nextIndices.delete(layout.directory);
  return { success: true, sourceId, chunkCount: terminal.chunkCount,
    endOffsetMs: terminal.endOffsetMs, duplicate: !!metadata.terminal };
}

function sourceFingerprint(recordPath) {
  const descriptions = inspectNativeSources(recordPath);
  const records = descriptions.map(source => ({
    manifest: readJson(source.manifestPath), started: source.startedPath ? readJson(source.startedPath) : null,
    end: source.endPath ? readJson(source.endPath) : null,
    chunks: source.chunks.map(chunk => [path.relative(recordPath, chunk.path), chunk.size, chunk.mtimeMs, chunk.ctimeMs]),
    gaps: source.gaps, terminalMismatch: source.terminalMismatch,
  }));
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}

module.exports = { beginSource, markSourceStarted, saveSourceChunk, endSource, inspectNativeSources, sourceFingerprint };
