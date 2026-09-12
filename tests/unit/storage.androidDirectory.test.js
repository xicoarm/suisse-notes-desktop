import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Android recordings must live in the app-specific external files directory
// (Directory.External), NOT the public Documents folder: on Android 11+ the
// public folder's listings come from the MediaStore database and chunk files
// went missing from `readdir` (Sentry CAPACITOR-N0, 29 users, Android-only).
// Data written by older versions in Documents must remain readable, and the
// disk-space probe must use @capacitor/device (Filesystem has no such API).
// ---------------------------------------------------------------------------

const m = vi.hoisted(() => ({
  platform: 'android',
  // In-memory fake of two base directories: EXTERNAL (primary) and DOCUMENTS (legacy)
  fs: { EXTERNAL: new Map(), DOCUMENTS: new Map(), CACHE: new Map() },
  deviceInfo: {},
}));

vi.mock('../../src/utils/platform', () => ({
  isElectron: () => false,
  isCapacitor: () => true,
  isAndroid: () => m.platform === 'android',
  isIOS: () => m.platform === 'ios',
  PlatformConstants: { CRITICAL_STORAGE_MB: 100, MIN_STORAGE_MB: 500 },
}));

function dirOf(map, path) {
  // directory "exists" when any entry lives under it or it was mkdir'ed
  if (map.has(path)) return true;
  const prefix = path.endsWith('/') ? path : path + '/';
  for (const key of map.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

vi.mock('@capacitor/filesystem', () => {
  const Filesystem = {
    stat: vi.fn(async ({ path, directory }) => {
      const map = m.fs[directory];
      if (map.has(path)) {
        const v = map.get(path);
        return v?.dir ? { type: 'directory', size: 0 } : { type: 'file', size: v.size };
      }
      if (dirOf(map, path)) return { type: 'directory', size: 0 };
      throw new Error('File does not exist');
    }),
    writeFile: vi.fn(async ({ path, data, directory }) => {
      m.fs[directory].set(path, { size: typeof data === 'string' ? Math.floor(data.length * 3 / 4) : 0, data });
      return { uri: `file:///${directory}/${path}` };
    }),
    rename: vi.fn(async ({ from, to, directory, toDirectory }) => {
      const src = m.fs[directory];
      const dst = m.fs[toDirectory || directory];
      if (!src.has(from) && !dirOf(src, from)) throw new Error('The source object does not exist');
      // move all entries with the prefix (dir) or the single file
      const entries = [...src.entries()].filter(([k]) => k === from || k.startsWith(from + '/'));
      for (const [k, v] of entries) {
        src.delete(k);
        dst.set(k.replace(from, to), v);
      }
    }),
    readdir: vi.fn(async ({ path, directory }) => {
      const map = m.fs[directory];
      if (!dirOf(map, path)) throw new Error('Directory does not exist');
      const prefix = path + '/';
      const names = new Set();
      for (const key of map.keys()) {
        if (key.startsWith(prefix)) names.add(key.slice(prefix.length).split('/')[0]);
      }
      return { files: [...names].map((name) => ({ name, type: map.has(prefix + name) && !map.get(prefix + name)?.dir ? 'file' : 'directory' })) };
    }),
    readFile: vi.fn(async ({ path, directory }) => {
      const v = m.fs[directory].get(path);
      if (!v) throw new Error('File does not exist');
      return { data: v.data };
    }),
    deleteFile: vi.fn(async ({ path, directory }) => {
      if (!m.fs[directory].delete(path)) throw new Error('File does not exist');
    }),
    rmdir: vi.fn(async ({ path, directory }) => {
      const map = m.fs[directory];
      for (const key of [...map.keys()]) if (key === path || key.startsWith(path + '/')) map.delete(key);
    }),
    mkdir: vi.fn(async ({ path, directory }) => { m.fs[directory].set(path, { dir: true }); }),
    copy: vi.fn(async ({ from, to, directory, toDirectory }) => {
      const src = m.fs[directory];
      const dst = m.fs[toDirectory || directory];
      const entries = [...src.entries()].filter(([k]) => k === from || k.startsWith(from + '/'));
      if (entries.length === 0) throw new Error('The source object does not exist');
      for (const [k, v] of entries) dst.set(k.replace(from, to), v);
      return { uri: `file:///${toDirectory || directory}/${to}` };
    }),
    getUri: vi.fn(async ({ path, directory }) => ({ uri: `file:///${directory}/${path}` })),
  };
  return { Filesystem, Directory: { Documents: 'DOCUMENTS', External: 'EXTERNAL', Cache: 'CACHE', Data: 'DATA' } };
});

vi.mock('@capacitor/device', () => ({
  Device: { getInfo: vi.fn(async () => m.deviceInfo) },
}));

import * as storage from '../../src/services/storage';

const b64 = (bytes) => btoa(String.fromCharCode(...bytes));

describe('storage — Android app-private directory with legacy fallback', () => {
  beforeEach(() => {
    m.platform = 'android';
    for (const map of Object.values(m.fs)) map.clear();
    m.deviceInfo = {};
    storage.__resetStorageCaches();
    vi.clearAllMocks();
  });

  it('writes new chunks to Directory.External on Android (never the public Documents folder)', async () => {
    const { Filesystem } = await import('@capacitor/filesystem');
    await storage.createDirectory('recordings/r1/chunks');
    const res = await storage.saveChunk('r1', new Uint8Array([1, 2, 3]), 0, '.webm');

    expect(res.success).toBe(true);
    expect(m.fs.EXTERNAL.has('recordings/r1/chunks/chunk_000000.webm')).toBe(true);
    expect(m.fs.DOCUMENTS.size).toBe(0);
    for (const call of Filesystem.writeFile.mock.calls) expect(call[0].directory).toBe('EXTERNAL');
    for (const call of Filesystem.rename.mock.calls) {
      expect(call[0].directory).toBe('EXTERNAL');
      expect(call[0].toDirectory).toBe('EXTERNAL');
    }
  });

  it('keeps using Directory.Documents on iOS', async () => {
    m.platform = 'ios';
    await storage.createDirectory('recordings/r2/chunks');
    await storage.saveChunk('r2', new Uint8Array([1]), 0, '.webm');
    expect(m.fs.DOCUMENTS.has('recordings/r2/chunks/chunk_000000.webm')).toBe(true);
    expect(m.fs.EXTERNAL.size).toBe(0);
  });

  it('reads, stats, resolves URIs and deletes legacy files left in Documents by older versions', async () => {
    m.fs.DOCUMENTS.set('recordings/old/combined.webm', { size: 3, data: b64([9, 9, 9]) });
    m.fs.DOCUMENTS.set('suissenotes_recordings/R20260601-090000.opus', { size: 2, data: b64([1, 1]) });

    expect(await storage.exists('recordings/old/combined.webm')).toBe(true);
    const st = await storage.statFile('recordings/old/combined.webm');
    expect(st).toMatchObject({ success: true, size: 3, directory: 'DOCUMENTS' });
    const read = await storage.readFile('recordings/old/combined.webm');
    expect(read.success).toBe(true);
    expect(new Uint8Array(read.data)).toEqual(new Uint8Array([9, 9, 9]));
    const uri = await storage.getFileUri('suissenotes_recordings/R20260601-090000.opus');
    expect(uri.uri).toBe('file:///DOCUMENTS/suissenotes_recordings/R20260601-090000.opus');

    const del = await storage.deleteFile('suissenotes_recordings/R20260601-090000.opus');
    expect(del.success).toBe(true);
    expect(m.fs.DOCUMENTS.has('suissenotes_recordings/R20260601-090000.opus')).toBe(false);
  });

  it('lists the recordings root as the union of both locations and treats a missing root as empty', async () => {
    expect(await storage.listFiles('recordings')).toEqual({ success: true, files: [] });

    m.fs.EXTERNAL.set('recordings/new/metadata.json', { size: 2, data: '{}' });
    m.fs.DOCUMENTS.set('recordings/old/metadata.json', { size: 2, data: '{}' });
    const list = await storage.listFiles('recordings');
    expect(list.success).toBe(true);
    expect(list.files.sort()).toEqual(['new', 'old']);
  });

  it('continues a legacy recording in its legacy folder (metadata + chunks stay together)', async () => {
    m.fs.DOCUMENTS.set('recordings/old/chunks/chunk_000000.webm', { size: 1, data: b64([1]) });
    m.fs.DOCUMENTS.set('recordings/old/metadata.json', { size: 20, data: JSON.stringify({ id: 'old', status: 'recording' }) });

    const meta = await storage.loadMetadata('old');
    expect(meta.success).toBe(true);
    expect(meta.metadata.id).toBe('old');

    await storage.saveMetadata('old', { id: 'old', status: 'recovered' });
    expect(m.fs.DOCUMENTS.has('recordings/old/metadata.json')).toBe(true);
    expect(m.fs.EXTERNAL.has('recordings/old/metadata.json')).toBe(false);

    const chunks = await storage.listFiles('recordings/old/chunks');
    expect(chunks.files).toEqual(['chunk_000000.webm']);
  });

  it('migrates legacy Android data into the app-private directory (atomic rename) and is idempotent', async () => {
    m.fs.DOCUMENTS.set('recordings/old/chunks/chunk_000000.webm', { size: 1, data: b64([1]) });
    m.fs.DOCUMENTS.set('recordings/old/combined.webm', { size: 3, data: b64([1, 2, 3]) });
    m.fs.DOCUMENTS.set('suissenotes_recordings/R20260601-090000.opus', { size: 2, data: b64([1, 1]) });

    const first = await storage.ensureAndroidStorageMigrated();
    expect(first.moved).toBe(2);
    expect(first.failed).toBe(0);
    expect(m.fs.EXTERNAL.has('recordings/old/combined.webm')).toBe(true);
    expect(m.fs.EXTERNAL.has('recordings/old/chunks/chunk_000000.webm')).toBe(true);
    expect(m.fs.EXTERNAL.has('suissenotes_recordings/R20260601-090000.opus')).toBe(true);
    expect([...m.fs.DOCUMENTS.keys()].filter(k => k.includes('/'))).toEqual([]);

    // Data is still reachable through the normal API after the move.
    expect((await storage.readFile('recordings/old/combined.webm')).success).toBe(true);

    storage.__resetStorageCaches();
    const second = await storage.ensureAndroidStorageMigrated();
    expect(second).toEqual({ moved: 0, failed: 0, skipped: 0 });
  });

  it('falls back to copy + verified delete when the cross-directory rename is refused', async () => {
    const { Filesystem } = await import('@capacitor/filesystem');
    m.fs.DOCUMENTS.set('suissenotes_recordings/R1.opus', { size: 2, data: b64([1, 1]) });
    Filesystem.rename.mockRejectedValueOnce(new Error('EPERM'));

    const res = await storage.ensureAndroidStorageMigrated();
    expect(res.moved).toBe(1);
    expect(m.fs.EXTERNAL.has('suissenotes_recordings/R1.opus')).toBe(true);
    expect(m.fs.DOCUMENTS.has('suissenotes_recordings/R1.opus')).toBe(false);
  });

  it('does nothing on iOS', async () => {
    m.platform = 'ios';
    m.fs.DOCUMENTS.set('recordings/x/combined.webm', { size: 1, data: b64([1]) });
    expect(await storage.ensureAndroidStorageMigrated()).toEqual({ moved: 0, failed: 0, skipped: 0 });
    expect(m.fs.DOCUMENTS.has('recordings/x/combined.webm')).toBe(true);
  });
});

describe('storage — free disk space via @capacitor/device', () => {
  beforeEach(() => {
    m.platform = 'android';
    m.deviceInfo = {};
    storage.__resetStorageCaches();
  });

  it('prefers realDiskFree, then diskFree', async () => {
    m.deviceInfo = { realDiskFree: 3 * 1024 * 1024 * 1024, diskFree: 1024 };
    expect(await storage.getFreeDiskSpace()).toEqual({ success: true, freeBytes: 3 * 1024 * 1024 * 1024, freeMB: 3072 });
    m.deviceInfo = { diskFree: 250 * 1024 * 1024 };
    expect((await storage.getFreeDiskSpace()).freeMB).toBe(250);
  });

  it('reports unknown (never a made-up number) when the device gives nothing usable', async () => {
    m.deviceInfo = { realDiskFree: 0 };
    expect((await storage.getFreeDiskSpace()).success).toBe(false);
    const check = await storage.checkStorageForRecording();
    expect(check).toEqual({ canRecord: true, status: 'ok', freeMB: -1 });
  });

  it('blocks a new recording below the critical threshold and warns below the low threshold', async () => {
    m.deviceInfo = { realDiskFree: 50 * 1024 * 1024 };
    expect(await storage.checkStorageForRecording()).toMatchObject({ canRecord: false, status: 'critical' });
    m.deviceInfo = { realDiskFree: 300 * 1024 * 1024 };
    expect(await storage.checkStorageForRecording()).toMatchObject({ canRecord: true, status: 'low' });
  });
});
