import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock every module upload-direct.js imports so it loads in isolation.
const mocks = vi.hoisted(() => ({
  getFileUri: vi.fn(),
  isCapacitor: vi.fn(() => true),
  captureMessage: vi.fn(),
  convertFileSrc: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('../../src/services/storage', () => ({ getFileUri: mocks.getFileUri }));
vi.mock('../../src/utils/platform', () => ({ isCapacitor: mocks.isCapacitor }));
vi.mock('../../src/boot/sentry', () => ({ captureMessage: mocks.captureMessage }));
vi.mock('@capacitor/core', () => ({ Capacitor: { convertFileSrc: mocks.convertFileSrc } }));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { stat: mocks.stat, readFile: mocks.readFile },
  Directory: { Documents: 'DOCUMENTS' },
}));

import { readBlobFromCapacitorPath } from '../../src/services/upload-direct';

// These tests pin the OOM guard on the base64 last-resort path. The PRIMARY
// path (disk-backed fetch) is what actually fixes the Android crash and is not
// exercised here — it is memory-safe by construction and cannot be measured in
// jsdom. The guard exists so that IF the disk-backed fetch ever fails on a
// large file, the app returns a clean error instead of OOM-killing the WebView.
describe('readBlobFromCapacitorPath — base64 fallback OOM guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isCapacitor.mockReturnValue(true);
    mocks.getFileUri.mockResolvedValue({
      success: true,
      uri: '/data/user/0/ch.suissenotes.app/files/recordings/x/combined.webm',
    });
    // convertFileSrc must return a URI different from the file:// one so the
    // code takes the base64 fallback branch when fetch() throws.
    mocks.convertFileSrc.mockImplementation((u) => `https://localhost/_capacitor_file_${u}`);
    // Force the disk-backed fetch to fail, routing into the base64 fallback.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
  });

  it('refuses to base64-decode a file above the cap (would OOM) and never reads it into memory', async () => {
    mocks.stat.mockResolvedValue({ size: 150 * 1024 * 1024 }); // 150 MB > 80 MB cap

    await expect(
      readBlobFromCapacitorPath('recordings/x/combined.webm')
    ).rejects.toMatchObject({ tooLargeForBase64: true });

    // Critical: the whole-file base64 read must NOT have happened.
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('still reads a small file via the base64 fallback (guard does not block normal uploads)', async () => {
    mocks.stat.mockResolvedValue({ size: 2 * 1024 * 1024 }); // 2 MB < cap
    mocks.readFile.mockResolvedValue({ data: 'AAAA' }); // valid base64 → 3 bytes

    const blob = await readBlobFromCapacitorPath('recordings/x/small.webm');

    expect(blob).toBeInstanceOf(Blob);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
  });

  it('proceeds best-effort if stat fails for an unrelated reason', async () => {
    mocks.stat.mockRejectedValue(new Error('stat unavailable'));
    mocks.readFile.mockResolvedValue({ data: 'AAAA' });

    const blob = await readBlobFromCapacitorPath('recordings/x/small.webm');

    expect(blob).toBeInstanceOf(Blob);
    expect(mocks.readFile).toHaveBeenCalledTimes(1);
  });
});
