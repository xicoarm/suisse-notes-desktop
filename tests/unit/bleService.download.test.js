import { describe, it, expect, beforeEach, vi } from 'vitest';

// End-to-end protocol simulation of the local-audio sync (T240 protocol
// §三.2): sync-state echo, file list (count JSON + entries, busy JSON),
// download (audio frames type 0x02 with a BIG-endian frame index, then
// 0x1D + CRC16), and the three-step handshake. The device side is a scripted
// mock of the write characteristic that answers on the notify characteristic.
vi.mock('../../src/utils/platform', () => ({
  isCapacitor: () => true,
  isAndroid: () => false,
  isIOS: () => true
}));
vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: () => {},
  captureException: () => {},
  captureMessage: () => {}
}));

import { BleDeviceManager, crc16Compute } from '../../src/services/bleService';

const enc = (s) => Array.from(new TextEncoder().encode(s));
const CMD = 0x01, AUDIO = 0x02;

/** Attach a scripted device: `handlers` maps the command byte to a function
 *  (payload) => array of frames (byte arrays) the device sends back. */
function attachDevice(m, handlers) {
  m.deviceId = 'dev-1';
  m.connected = true;
  m.ble = {
    writeWithoutResponse: async (_id, _svc, _chr, dv) => {
      const bytes = Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      const h = handlers[bytes[1]];
      const frames = h ? h(bytes.slice(3), bytes) : [];
      // Reply asynchronously, like a real notification.
      setTimeout(() => {
        for (const f of frames) {
          const u8 = Uint8Array.from(f);
          m._onNotify(new DataView(u8.buffer, u8.byteOffset, u8.byteLength));
        }
      }, 0);
    }
  };
}

const syncEcho = (payload) => [[CMD, 0x74, 0x00, ...payload]];

function audioFrames(bytes, frameLen = 320, cmd = 0x1C) {
  const frames = [];
  let idx = 0;
  for (let off = 0; off < bytes.length; off += frameLen, idx++) {
    const chunk = Array.from(bytes.slice(off, off + frameLen));
    frames.push([AUDIO, cmd, 0x00, (idx >> 8) & 0xFF, idx & 0xFF, ...chunk]); // BIG-endian index
  }
  return frames;
}
const doneFrame = (bytes) => { const c = crc16Compute(bytes); return [CMD, 0x1D, 0x00, c & 0xFF, (c >> 8) & 0xFF]; };

describe('BleDeviceManager.downloadFile', () => {
  let m;
  beforeEach(() => { m = new BleDeviceManager(); });

  it('reassembles a multi-frame file (big-endian frame index, index wrap) and verifies the CRC', async () => {
    const file = new Uint8Array(320 * 70000 / 100); // 224 000 bytes → 700 frames
    for (let i = 0; i < file.length; i++) file[i] = (i * 31 + 7) & 0xFF;
    attachDevice(m, {
      0x74: syncEcho,
      0x1C: () => [...audioFrames(file), doneFrame(file)]
    });
    const progress = [];
    const out = await m.downloadFile('R1.opus', (p) => progress.push(p.percent), file.length);
    expect(out.length).toBe(file.length);
    expect(Array.from(out.slice(0, 8))).toEqual(Array.from(file.slice(0, 8)));
    expect(Array.from(out.slice(-8))).toEqual(Array.from(file.slice(-8)));
    expect(progress[progress.length - 1]).toBe(100);
    expect(m._downloadInProgress).toBe(false);
  });

  it('a frame index of 256 on the second frame would be a wrong byte order — detected as a gap', async () => {
    const file = new Uint8Array(1000).fill(0x42);
    const frames = audioFrames(file);
    // Swap the index bytes of frame 1 (little-endian encoding of 1 = 0x01 0x00)
    frames[1][3] = 0x01; frames[1][4] = 0x00;
    attachDevice(m, { 0x74: syncEcho, 0x1C: () => [...frames, doneFrame(file)] });
    await expect(m.downloadFile('R1.opus')).rejects.toThrow(/CRC mismatch: frame 256 received, expected 1/);
  });

  it('a zero-byte file ends with DONE only and is reported as EMPTY_FILE', async () => {
    attachDevice(m, { 0x74: syncEcho, 0x1C: () => [[CMD, 0x1D, 0x00, 0x00, 0x00]] });
    await expect(m.downloadFile('R0.opus')).rejects.toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('a wrong CRC is rejected', async () => {
    const file = new Uint8Array(500).fill(0x11);
    attachDevice(m, { 0x74: syncEcho, 0x1C: () => [...audioFrames(file), [CMD, 0x1D, 0x00, 0x12, 0x34]] });
    await expect(m.downloadFile('R1.opus')).rejects.toThrow(/CRC mismatch: expected 0x3412/);
  });

  it('real-time audio frames (0x14) interleaved with the transfer are ignored', async () => {
    const file = new Uint8Array(640).fill(0x77);
    const frames = audioFrames(file);
    const rt = [AUDIO, 0x14, 0x00, 0x00, 0x00, 1, 2, 3];
    attachDevice(m, { 0x74: syncEcho, 0x1C: () => [frames[0], rt, frames[1], rt, doneFrame(file)] });
    const out = await m.downloadFile('R1.opus');
    expect(out.length).toBe(640);
  });
});

describe('BleDeviceManager.getFileList', () => {
  let m;
  beforeEach(() => { m = new BleDeviceManager(); });

  it('reads the count frame and N entries, exits sync state', async () => {
    const entries = [
      { file: 'R20260101-120000.opus', size: 7680, creat_time: 1, duration_ms: 3000, type: 3, index: 1, delete: 0, toggle_switch: 0 },
      { file: 'R20260101-130000.opus', size: 9600, creat_time: 2, duration_ms: 4000, type: 3, index: 2, delete: 0, toggle_switch: 0 }
    ];
    const writes = [];
    attachDevice(m, {
      0x74: (p) => { writes.push('sync' + p[0]); return syncEcho(p); },
      0x1B: () => [[CMD, 0x1B, 0x00, ...enc(JSON.stringify({ FileNum: 2 }))], ...entries.map(e => [CMD, 0x1B, 0x00, ...enc(JSON.stringify(e))])]
    });
    const files = await m.getFileList();
    expect(files.map(f => f.file)).toEqual(entries.map(e => e.file));
    expect(writes).toEqual(['sync1', 'sync0']);
  });

  it.each([
    ['{"AudioFileList":"MemoryBusy"}', 'DEVICE_MEMORYBUSY'],   // what the firmware sends
    ['{"FileList":"MemoryBusy"}', 'DEVICE_MEMORYBUSY'],        // what the document says
    ['{"FileList":"MemoryErr"}', 'DEVICE_MEMORYERR']
  ])('%s is an error, not an empty list', async (json, code) => {
    attachDevice(m, { 0x74: syncEcho, 0x1B: () => [[CMD, 0x1B, 0x00, ...enc(json)]] });
    await expect(m.getFileList()).rejects.toMatchObject({ code });
  });

  it('a toggle-switch report in the middle of the list does not consume a file slot', async () => {
    const e1 = { file: 'A.opus', size: 1 }, e2 = { file: 'B.opus', size: 2 };
    attachDevice(m, {
      0x74: syncEcho,
      0x1B: () => [
        [CMD, 0x1B, 0x00, ...enc('{"FileNum":2}')],
        [CMD, 0x1B, 0x00, ...enc(JSON.stringify(e1))],
        [CMD, 0x6E, 0x00, 0x01],
        [CMD, 0x1B, 0x00, ...enc(JSON.stringify(e2))]
      ]
    });
    const files = await m.getFileList();
    expect(files.map(f => f.file)).toEqual(['A.opus', 'B.opus']);
  });
});

describe('BleDeviceManager._handshake', () => {
  it('skips a stray reply before step 1 and parses the step-3 device info', async () => {
    const m = new BleDeviceManager();
    const info = { name: 'M1(BLE)', SN: '352404226020000075', model: 'Record Card', isAudioRecorded: '0' };
    attachDevice(m, {
      0x01: (payload) => {
        expect(payload[0]).toBe(0x01); // step 2
        const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(payload.slice(1))));
        expect(json.uuid).toBe('app-uuid');
        expect(typeof json.time).toBe('number');
        return [[CMD, 0x01, 0x00, 0x02, 0x00, ...enc(JSON.stringify(info))]];
      }
    });
    // stray late battery reply, then the device's step 1
    for (const f of [[CMD, 0x09, 0x00, 0x00], [CMD, 0x01, 0x00, 0x00, ...enc('{"uuid":"623d289d-0a37-5260-b0f1-976e9bc9ea4e"}')]]) {
      const u8 = Uint8Array.from(f); m._onNotify(new DataView(u8.buffer));
    }
    const result = await m._handshake('app-uuid');
    expect(result.SN).toBe(info.SN);
    expect(m.deviceUuid).toBe('623d289d-0a37-5260-b0f1-976e9bc9ea4e');
  });

  it('status 0x01 is reported as "rejected pairing"', async () => {
    const m = new BleDeviceManager();
    attachDevice(m, { 0x01: () => [[CMD, 0x01, 0x00, 0x02, 0x01]] });
    const u8 = Uint8Array.from([CMD, 0x01, 0x00, 0x00, ...enc('{"uuid":"d"}')]); m._onNotify(new DataView(u8.buffer));
    await expect(m._handshake('app-uuid')).rejects.toThrow(/rejected pairing/);
  });

  it('a device-initiated recording start with RecordStartErr is not a recording', () => {
    const m = new BleDeviceManager();
    const states = [];
    m._recordingStateCallback = (s, err) => states.push([s, err]);
    const u8 = Uint8Array.from([CMD, 0x14, 0x00, ...enc('{"RecordStartErr":"MemoryFull"}')]); m._onNotify(new DataView(u8.buffer));
    expect(m.isRecording).toBe(false);
    expect(states).toEqual([[false, 'MemoryFull']]);
    const ok = Uint8Array.from([CMD, 0x14, 0x00, ...enc('{"file":"R1.opus","creat_time":1}')]); m._onNotify(new DataView(ok.buffer));
    expect(m.isRecording).toBe(true);
  });
});
