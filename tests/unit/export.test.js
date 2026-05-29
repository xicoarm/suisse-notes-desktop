import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
  fsStat: vi.fn(),
  fsCopy: vi.fn(),
  fsDelete: vi.fn(),
  fsGetUri: vi.fn(),
  share: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock('../../src/utils/platform', () => ({
  isElectron: mocks.isElectron,
  isCapacitor: mocks.isCapacitor,
}));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: mocks.captureMessage }));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { stat: mocks.fsStat, copy: mocks.fsCopy, deleteFile: mocks.fsDelete, getUri: mocks.fsGetUri },
  Directory: { Documents: 'DOCUMENTS', Cache: 'CACHE' },
}));
vi.mock('@capacitor/share', () => ({ Share: { share: mocks.share } }));

import { buildExportFilename, exportAudio } from '../../src/services/export';

describe('buildExportFilename', () => {
  it('builds "<title>_<date>.<ext>" and strips filesystem-illegal characters', () => {
    const name = buildExportFilename({
      title: 'VR Sitzung: Q2 "Board"',
      createdAt: '2026-05-29T10:00:00Z',
      filePath: 'recordings/x/combined.webm',
    });
    expect(name).toBe('VR Sitzung Q2 Board_2026-05-29.webm');
    expect(name).not.toMatch(/[/\\?%*:|"<>]/);
  });

  it('falls back to "recording" for an empty/whitespace title and omits a bad date', () => {
    expect(buildExportFilename({ title: '   ', createdAt: 'not-a-date', filePath: 'a/b.m4a' }))
      .toBe('recording.m4a');
  });

  it('defaults the extension to webm when the path has none', () => {
    expect(buildExportFilename({ title: 'x', filePath: 'a/b' })).toBe('x.webm');
    expect(buildExportFilename({})).toBe('recording.webm');
  });

  it('lowercases the extension and ignores query/hash suffixes', () => {
    expect(buildExportFilename({ title: 't', filePath: 'a/b.M4A?foo=1' })).toBe('t.m4a');
  });
});

describe('exportAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isElectron.mockReturnValue(false);
    mocks.isCapacitor.mockReturnValue(false);
  });

  it('refuses when there is no local file', async () => {
    expect(await exportAudio({})).toEqual({ success: false, error: 'no_local_file' });
    expect(await exportAudio(null)).toEqual({ success: false, error: 'no_local_file' });
  });

  it('on Electron, calls the Save-As IPC with (filePath, friendlyName) and returns its result', async () => {
    mocks.isElectron.mockReturnValue(true);
    const saveFile = vi.fn().mockResolvedValue({ success: true, savedPath: '/Users/me/x.webm' });
    vi.stubGlobal('window', { electronAPI: { dialog: { saveFile } } });

    const res = await exportAudio({
      title: 'Call', createdAt: '2026-05-29T10:00:00Z', filePath: 'C:/data/recordings/r1/audio.webm',
    });

    expect(saveFile).toHaveBeenCalledWith('C:/data/recordings/r1/audio.webm', 'Call_2026-05-29.webm');
    expect(res).toEqual({ success: true, savedPath: '/Users/me/x.webm' });
    vi.unstubAllGlobals();
  });

  it('on Capacitor, checks source, copies into Cache, then shares the copy uri; returns shared:true', async () => {
    mocks.isCapacitor.mockReturnValue(true);
    mocks.fsStat.mockResolvedValue({ size: 12345 });
    mocks.fsDelete.mockRejectedValue(new Error('not found')); // no stale copy
    mocks.fsCopy.mockResolvedValue({ uri: 'file:///cache/Call_2026-05-29.webm' });
    mocks.share.mockResolvedValue({});

    const res = await exportAudio({
      title: 'Call', createdAt: '2026-05-29T10:00:00Z', filePath: 'recordings/r1/combined.webm',
    });

    expect(mocks.fsStat).toHaveBeenCalledWith({ path: 'recordings/r1/combined.webm', directory: 'DOCUMENTS' });
    expect(mocks.fsCopy).toHaveBeenCalledWith({
      from: 'recordings/r1/combined.webm',
      directory: 'DOCUMENTS',
      to: 'Call_2026-05-29.webm',
      toDirectory: 'CACHE',
    });
    expect(mocks.share).toHaveBeenCalledWith({
      title: 'Call_2026-05-29.webm',
      files: ['file:///cache/Call_2026-05-29.webm'],
    });
    expect(res).toEqual({ success: true, shared: true });
  });

  it('on Capacitor, returns source_missing (without copying) when the file is gone', async () => {
    mocks.isCapacitor.mockReturnValue(true);
    mocks.fsStat.mockRejectedValue(new Error('File does not exist'));

    const res = await exportAudio({ title: 'x', filePath: 'recordings/gone/combined.webm' });
    expect(res).toEqual({ success: false, error: 'source_missing' });
    expect(mocks.fsCopy).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('on Capacitor, treats a dismissed share sheet as cancelled (not an error)', async () => {
    mocks.isCapacitor.mockReturnValue(true);
    mocks.fsStat.mockResolvedValue({ size: 1 });
    mocks.fsDelete.mockResolvedValue({});
    mocks.fsCopy.mockResolvedValue({ uri: 'file:///cache/x.webm' });
    mocks.share.mockRejectedValue(new Error('Share canceled'));

    const res = await exportAudio({ title: 'x', filePath: 'recordings/r1/combined.webm' });
    expect(res).toEqual({ success: false, cancelled: true });
  });
});
