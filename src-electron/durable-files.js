'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { pipeline } = require('stream/promises');

// A successful write means all bytes, including the directory entry, have been
// flushed. Windows cannot fsync a directory through Node; FlushFileBuffers on
// the writable file handle is still required there. Hardware may lie about
// flush completion, so this is not a guarantee against physical disk failure.
function syncDirectorySync(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

async function syncFile(filePath) {
  const file = await fs.promises.open(filePath, 'r+');
  try { await file.sync(); } finally { await file.close(); }
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(source, destination);
      syncDirectorySync(path.dirname(destination));
      if (path.dirname(source) !== path.dirname(destination)) {
        syncDirectorySync(path.dirname(source));
      }
      return;
    } catch (error) {
      if (!['EBUSY', 'EACCES', 'EPERM'].includes(error.code) || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

async function publishFile(source, destination) {
  await syncFile(source);
  // Never unlink the destination first: a failed replacement must leave the
  // previous, playable recording intact.
  await renameWithRetry(source, destination);
}

async function writeFileAtomic(filePath, data) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await fs.promises.open(temporary, 'wx');
    await file.writeFile(data); // handles short writes; one write() need not
    await file.sync();
    await file.close();
    file = null;
    await renameWithRetry(temporary, filePath);
  } finally {
    if (file) await file.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function writeFileAtomicSync(filePath, data) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    syncDirectorySync(path.dirname(filePath));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (_) { /* already published */ }
  }
}

async function concatenateFiles(inputs, destination) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  // An async iterator + pipeline provides backpressure and propagates both
  // input and output errors. An unreadable chunk is never silently skipped.
  async function* bytes() {
    for (const input of inputs) {
      for await (const data of fs.createReadStream(input)) yield data;
    }
  }
  try {
    await pipeline(bytes(), fs.createWriteStream(temporary, { flags: 'wx' }));
    await publishFile(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

// Move a whole batch atomically before remuxing. Retain it until the recording
// is explicitly deleted or a verified upload permits deletion. Deterministic
// session filenames make a crash at ANY remux boundary safe to retry without
// appending the same batch twice. Later chunks go into a fresh directory.
async function archiveChunkBatch(recordPath, ext = '.webm') {
  const chunks = path.join(recordPath, 'chunks');
  const archive = path.join(recordPath, 'source-chunks');
  const files = await fs.promises.readdir(chunks).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (!files.some(file => /^chunk_\d+\./.test(file) && file.endsWith(ext))) return null;
  await fs.promises.mkdir(archive, { recursive: true });
  const existing = await fs.promises.readdir(archive);
  const latest = existing.reduce((max, name) => /^\d+$/.test(name) ? Math.max(max, Number(name)) : max, 0);
  const id = String(Math.max(Date.now(), latest + 1));
  const batchPath = path.join(archive, id);
  await renameWithRetry(chunks, batchPath);
  await fs.promises.mkdir(chunks, { recursive: true });
  syncDirectorySync(recordPath);
  return { id, path: batchPath };
}

function listChunkBatches(recordPath) {
  const archive = path.join(recordPath, 'source-chunks');
  if (!fs.existsSync(archive)) return [];
  return fs.readdirSync(archive)
    .filter(id => /^\d+$/.test(id) && fs.statSync(path.join(archive, id)).isDirectory())
    .sort((a, b) => Number(a) - Number(b))
    .map(id => ({ id, path: path.join(archive, id) }));
}

function assertManagedRecordingDirectory(recordingsRoot, directory) {
  const root = path.resolve(recordingsRoot);
  const target = path.resolve(directory);
  if (target === root || path.dirname(target) !== root) throw new Error('Refusing to delete outside one managed recording directory');
  return target;
}

module.exports = {
  assertManagedRecordingDirectory, writeFileAtomic, writeFileAtomicSync, publishFile, syncFile,
  syncDirectorySync, renameWithRetry, concatenateFiles,
  archiveChunkBatch, listChunkBatches,
};
