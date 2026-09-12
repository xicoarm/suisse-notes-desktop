import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stale-frame robustness of the recorder protocol, found by the mobile harness
// (m5-recorder-sync): every file-list frame looks identical on the wire
// (01 1B 00 + JSON), and audio frames of an aborted transfer can still be in
// flight when the next download starts. Order-based parsing turned ONE
// leftover frame into lists with duplicates / missing entries and into
// retries that failed until the file was skipped.
vi.mock('../../src/utils/platform', () => ({ isCapacitor: () => true, isAndroid: () => false, isIOS: () => true }));
vi.mock('../../src/boot/sentry', () => ({ addBreadcrumb: () => {}, captureException: () => {}, captureMessage: () => {} }));

import { BleDeviceManager, crc16Compute } from '../../src/services/bleService';

const enc = (s) => Array.from(new TextEncoder().encode(s));
const CMD = 0x01, AUDIO = 0x02;
const push = (m, bytes) => { const u8 = Uint8Array.from(bytes); m._onNotify(new DataView(u8.buffer, u8.byteOffset, u8.byteLength)); };

function attach(m, handlers) {
  m.deviceId = 'dev'; m.connected = true;
  m.ble = {
    writeWithoutResponse: async (_d, _s, _c, dv) => {
      const b = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      const frames = handlers[b[1]] ? handlers[b[1]](b.slice(3)) : [];
      setTimeout(() => frames.forEach(f => push(m, f)), 0);
    }
  };
  // No quiet-window drain in these tests: stale frames must be handled by parsing.
  m._drainNotifyQueue = async () => {};
}
const listFrame = (obj) => [CMD, 0x1B, 0x00, ...enc(JSON.stringify(obj))];
const entry = (name) => ({ file: name, size: 10, creat_time: 1, duration_ms: 1 });
const syncEcho = (p) => [[CMD, 0x74, 0x00, ...p]];

describe('getFileList parses by shape, not by position', () => {
  let m;
  beforeEach(() => { m = new BleDeviceManager(); });

  it('a leftover ENTRY frame before the count does not shift the list', async () => {
    attach(m, { 0x74: syncEcho, 0x1B: () => [listFrame({ FileNum: 3 }), listFrame(entry('A')), listFrame(entry('B')), listFrame(entry('C'))] });
    push(m, listFrame(entry('C')));           // stale entry of an earlier request
    const files = await m.getFileList();
    // Complete and without duplicates; order is irrelevant (the store sorts by creat_time).
    expect(files.map(f => f.file).sort()).toEqual(['A', 'B', 'C']);
  });

  it('a leftover COUNT frame is a restart marker, not an entry', async () => {
    attach(m, { 0x74: syncEcho, 0x1B: () => [listFrame({ FileNum: 2 }), listFrame(entry('A')), listFrame(entry('B'))] });
    push(m, listFrame({ FileNum: 7 }));
    push(m, listFrame(entry('OLD')));
    const files = await m.getFileList();
    expect(files.map(f => f.file)).toEqual(['A', 'B']);
  });

  it('duplicate entries (stale frames) are ignored', async () => {
    attach(m, { 0x74: syncEcho, 0x1B: () => [listFrame({ FileNum: 2 }), listFrame(entry('A')), listFrame(entry('A')), listFrame(entry('B'))] });
    const files = await m.getFileList();
    expect(files.map(f => f.file)).toEqual(['A', 'B']);
  });

  it('a truncated stream is reported as LIST_INCOMPLETE with what arrived, never as a shorter list', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      attach(m, { 0x74: syncEcho, 0x1B: () => [listFrame({ FileNum: 3 }), listFrame(entry('A'))] });
      const p = m.getFileList();
      const assertion = expect(p).rejects.toMatchObject({ code: 'LIST_INCOMPLETE', files: [expect.objectContaining({ file: 'A' })] });
      await vi.advanceTimersByTimeAsync(11_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('downloadFile drops audio frames of an aborted transfer', () => {
  it('leftover frames before frame 0 and behind the expected index are skipped; the file verifies', async () => {
    const m = new BleDeviceManager();
    const file = new Uint8Array(900).map((_, i) => (i * 7) & 0xFF);
    const frames = [];
    for (let off = 0, idx = 0; off < file.length; off += 320, idx++) {
      frames.push([AUDIO, 0x1C, 0x00, (idx >> 8) & 0xFF, idx & 0xFF, ...file.slice(off, off + 320)]);
    }
    const crc = crc16Compute(file);
    attach(m, {
      0x74: syncEcho,
      0x1C: () => [
        [AUDIO, 0x1C, 0x00, 0x00, 0x96, 9, 9, 9],   // frame 150 of the aborted transfer
        [AUDIO, 0x1C, 0x00, 0x00, 0x97, 9, 9, 9],   // frame 151
        frames[0],
        frames[0],                                  // retransmitted frame 0 → behind → skipped
        frames[1], frames[2],
        [CMD, 0x1D, 0x00, crc & 0xFF, (crc >> 8) & 0xFF]
      ]
    });
    const out = await m.downloadFile('R.opus');
    expect(Array.from(out)).toEqual(Array.from(file));
  });

  it('a genuine hole in the sequence still fails fast', async () => {
    const m = new BleDeviceManager();
    attach(m, {
      0x74: syncEcho,
      0x1C: () => [[AUDIO, 0x1C, 0x00, 0x00, 0x00, 1, 2], [AUDIO, 0x1C, 0x00, 0x00, 0x02, 3, 4], [CMD, 0x1D, 0x00, 0, 0]]
    });
    await expect(m.downloadFile('R.opus')).rejects.toThrow(/frame 2 received, expected 1/);
  });
});
