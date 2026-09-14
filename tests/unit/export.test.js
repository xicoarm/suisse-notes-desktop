import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isElectron: vi.fn(() => false),
  isCapacitor: vi.fn(() => false),
  statFile: vi.fn(),
  copyToCache: vi.fn(),
  getFileUri: vi.fn(),
  share: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock('../../src/utils/platform', () => ({
  isElectron: mocks.isElectron,
  isCapacitor: mocks.isCapacitor,
}));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: mocks.captureMessage, addBreadcrumb: mocks.addBreadcrumb }));
vi.mock('../../src/services/storage', () => ({
  statFile: mocks.statFile,
  copyToCache: mocks.copyToCache,
  getFileUri: mocks.getFileUri,
}));
vi.mock('@capacitor/share', () => ({ Share: { share: mocks.share } }));

import { buildExportFilename, buildExportNotice, exportAudio } from '../../src/services/export';

describe('desktop export completion notice', () => {
  it('surfaces recovered capture warnings instead of an unqualified positive notice', () => {
    expect(buildExportNotice({ recovered: true, captureWarnings: ['native-source-interrupted'] }, key => key))
      .toEqual({ type: 'warning', message: 'exportSaved', caption: 'historyCaptureWarningDescription', timeout: 7000 });
  });
  it('preserves the normal successful export notice when there are no capture warnings', () => {
    expect(buildExportNotice({ success: true }, key => key)).toEqual({ type: 'positive', message: 'exportSaved', timeout: 2500 });
  });
});

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
    mocks.statFile.mockResolvedValue({ success: true, size: 12345 });
    mocks.copyToCache.mockResolvedValue({ success: true, uri: 'file:///cache/Call_2026-05-29.webm' });
    mocks.share.mockResolvedValue({});

    const res = await exportAudio({
      title: 'Call', createdAt: '2026-05-29T10:00:00Z', filePath: 'recordings/r1/combined.webm',
    });

    expect(mocks.statFile).toHaveBeenCalledWith('recordings/r1/combined.webm');
    expect(mocks.copyToCache).toHaveBeenCalledWith('recordings/r1/combined.webm', 'Call_2026-05-29.webm');
    expect(mocks.share).toHaveBeenCalledWith({
      title: 'Call_2026-05-29.webm',
      files: ['file:///cache/Call_2026-05-29.webm'],
    });
    expect(res).toEqual({ success: true, shared: true });
  });

  it('on Capacitor, falls back to sharing the original in place if the cache copy fails', async () => {
    mocks.isCapacitor.mockReturnValue(true);
    mocks.statFile.mockResolvedValue({ success: true, size: 10 });
    mocks.copyToCache.mockResolvedValue({ success: false, error: 'copy not permitted' });
    mocks.getFileUri.mockResolvedValue({ success: true, uri: 'file:///docs/recordings/r1/combined.webm' });
    mocks.share.mockResolvedValue({});

    const res = await exportAudio({ title: 'x', filePath: 'recordings/r1/combined.webm' });

    expect(mocks.getFileUri).toHaveBeenCalledWith('recordings/r1/combined.webm');
    expect(mocks.share).toHaveBeenCalledWith({ title: 'x.webm', files: ['file:///docs/recordings/r1/combined.webm'] });
    expect(res).toEqual({ success: true, shared: true });
  });

  it('on Capacitor, returns source_missing (without copying) when the file is gone', async () => {
    mocks.isCapacitor.mockReturnValue(true);
    mocks.statFile.mockResolvedValue({ success: false, error: 'File does not exist' });

    const res = await exportAudio({ title: 'x', filePath: 'recordings/gone/combined.webm' });
    expect(res).toEqual({ success: false, error: 'source_missing' });
    expect(mocks.copyToCache).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it('on Capacitor, treats a dismissed share sheet as cancelled (not an error)', async () => {
    mocks.isCapacitor.mockReturnValue(true);
    mocks.statFile.mockResolvedValue({ success: true, size: 1 });
    mocks.copyToCache.mockResolvedValue({ success: true, uri: 'file:///cache/x.webm' });
    mocks.share.mockRejectedValue(new Error('Share canceled'));

    const res = await exportAudio({ title: 'x', filePath: 'recordings/r1/combined.webm' });
    expect(res).toEqual({ success: false, cancelled: true });
  });
});
