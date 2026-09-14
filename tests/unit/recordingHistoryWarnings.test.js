// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { withCaptureWarnings, hydrateHistoryCaptureWarnings } = require('../../src-electron/recording-history-warnings');

const id = 'a730ee2d-1534-403a-96ef-7f8cb1e2e7c2';
const otherId = '02fb9356-7a4c-41ee-b416-785249c678fd';
let root;
function writeMetadata(recordId, metadata) {
  const directory = path.join(root, recordId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata));
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-history-warnings-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(path.join(os.tmpdir(), 'suisse-history-warnings-'))) throw new Error('Invalid fixture cleanup path');
  fs.rmSync(root, { recursive: true, force: true });
});

describe('persistent capture warnings in desktop history', () => {
  it('carries metadata warnings through recovery, upload updates and later missing metadata', () => {
    writeMetadata(id, {
      userId: 'u1', captureWarnings: ['microphone-disconnected', 'future-capture-warning'],
      uploadStatus: 'recording', filePath: 'must-not-override-history'
    });
    const recovered = withCaptureWarnings({ id, userId: 'u1', recovered: true, uploadStatus: 'pending', filePath: 'audio.webm' }, root);
    expect(recovered).toMatchObject({
      recovered: true, uploadStatus: 'pending', filePath: 'audio.webm',
      captureWarnings: ['microphone-disconnected', 'future-capture-warning']
    });
    fs.unlinkSync(path.join(root, id, 'metadata.json'));
    const uploaded = withCaptureWarnings({ ...recovered, uploadStatus: 'uploaded', captureWarnings: [] }, root, recovered.captureWarnings);
    const reloaded = hydrateHistoryCaptureWarnings([uploaded], 'u1', root)[0];
    expect(reloaded.uploadStatus).toBe('uploaded');
    expect(reloaded.captureWarnings).toEqual(recovered.captureWarnings);
    expect(reloaded).toBe(uploaded); // no unnecessary history rewrite
  });

  it('refreshes an old history entry when a warning is persisted after the initial add', () => {
    writeMetadata(id, { userId: 'u1' });
    const initial = withCaptureWarnings({ id, userId: 'u1' }, root);
    expect(initial.captureWarnings).toEqual([]);
    writeMetadata(id, { userId: 'u1', captureWarnings: ['microphone-zero-signal', 'microphone-zero-signal', null, '', 7] });
    const refreshed = hydrateHistoryCaptureWarnings([initial], 'u1', root)[0];
    expect(refreshed.captureWarnings).toEqual(['microphone-zero-signal']);
    expect(initial.captureWarnings).toEqual([]);
  });

  it('does not read another account metadata and rejects a conflicting metadata owner', () => {
    writeMetadata(id, { userId: 'u2', captureWarnings: ['private-warning'] });
    writeMetadata(otherId, { userId: 'u2', captureWarnings: ['other-private-warning'] });
    const otherRecord = { id: otherId, userId: 'u2' };
    const read = vi.spyOn(fs, 'readFileSync');
    const result = hydrateHistoryCaptureWarnings([{ id, userId: 'u1' }, otherRecord], 'u1', root);
    expect(result[0].captureWarnings).toEqual([]);
    expect(result[1]).toBe(otherRecord);
    expect(read.mock.calls.map(call => call[0])).toEqual([path.join(root, id, 'metadata.json')]);
  });

  it('keeps cached warnings when metadata is malformed and never follows an arbitrary file path or id', () => {
    writeMetadata(id, { captureWarnings: [] });
    fs.writeFileSync(path.join(root, id, 'metadata.json'), '{partial');
    expect(withCaptureWarnings({ id, userId: 'u1', captureWarnings: ['recorder-stall'] }, root).captureWarnings).toEqual(['recorder-stall']);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(withCaptureWarnings({ id: '../outside', userId: 'u1', filePath: path.join(root, id, 'audio.webm') }, root).captureWarnings).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
