import { describe, it, expect, beforeEach, vi } from 'vitest';

// T240 protocol hardening (protocol doc 2025-06-13):
//  - a command's reply is the frame echoing its command bytes; unsolicited
//    frames (toggle switch 0x6E, socket 0x0C, late replies) must never be
//    parsed as the answer of the next command;
//  - audio frames (type 0x02) only exist inside a download;
//  - abortDownload outside a download must not poison later reads;
//  - unpair carries the "keep recordings" flag byte.
vi.mock('../../src/utils/platform', () => ({
  isCapacitor: () => true,
  isAndroid: () => false,
  isIOS: () => true
}));
const crumbs = vi.hoisted(() => ({ list: [] }));
vi.mock('../../src/boot/sentry', () => ({
  addBreadcrumb: (b) => crumbs.list.push(b),
  captureException: () => {},
  captureMessage: () => {}
}));

import { BleDeviceManager } from '../../src/services/bleService';

const frame = (bytes) => {
  const u8 = Uint8Array.from(bytes);
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
};
const CMD_BATTERY = [0x09, 0x00];
const CMD_STORAGE = [0x06, 0x00];

describe('BleDeviceManager notification routing', () => {
  let m;
  beforeEach(() => {
    m = new BleDeviceManager();
    crumbs.list.length = 0;
  });

  it('_readResponse returns the reply echoing the command and skips other frames', async () => {
    m._onNotify(frame([0x01, ...CMD_STORAGE, 0x7b, 0x7d]));   // late storage reply
    m._onNotify(frame([0x01, ...CMD_BATTERY, 0x55]));          // the battery reply we want
    const resp = await m._readResponse(CMD_BATTERY, 1000);
    expect(Array.from(resp)).toEqual([0x01, 0x09, 0x00, 0x55]);
    expect(crumbs.list.some(c => /skipped frame while waiting for cmd 0x9/.test(c.message))).toBe(true);
  });

  it('_readResponse times out overall instead of waiting per skipped frame', async () => {
    m._onNotify(frame([0x01, ...CMD_STORAGE, 0x7b]));
    await expect(m._readResponse(CMD_BATTERY, 30)).rejects.toThrow('BLE response timeout');
  });

  it('unsolicited toggle-switch (0x6E) and socket (0x0C) reports never enter the queue', () => {
    m._onNotify(frame([0x01, 0x6E, 0x00, 0x01]));
    m._onNotify(frame([0x01, 0x0C, 0x00, 0x00]));
    expect(m._notifyQueue).toHaveLength(0);
  });

  it('audio frames are dropped outside a download and kept during one', () => {
    m._onNotify(frame([0x02, 0x1C, 0x00, 0x00, 0x00, 0xAA, 0xBB])); // stale file stream
    m._onNotify(frame([0x02, 0x14, 0x00, 0x01, 0x02]));             // real-time stream
    expect(m._notifyQueue).toHaveLength(0);
    m._downloadInProgress = true;
    m._onNotify(frame([0x02, 0x1C, 0x00, 0x00, 0x00, 0xAA, 0xBB]));
    expect(m._notifyQueue).toHaveLength(1);
    m._onNotify(frame([0x02, 0x14, 0x00, 0x01, 0x02]));             // real-time still dropped
    expect(m._notifyQueue).toHaveLength(1);
  });

  it('abortDownload outside a download is a no-op (later reads keep working)', async () => {
    m.abortDownload();
    expect(m._downloadAborted).toBe(false);
    m._onNotify(frame([0x01, ...CMD_BATTERY, 0x42]));
    const resp = await m._readResponse(CMD_BATTERY, 500);
    expect(resp[3]).toBe(0x42);
  });

  it('abortDownload during a download rejects the pending read with the cancel sentinel', async () => {
    m._downloadInProgress = true;
    const pending = m._readNotification(5000);
    m.abortDownload();
    await expect(pending).rejects.toThrow('BLE download cancelled');
    expect(m._downloadAborted).toBe(true);
  });

  it('device button start/stop frames update isRecording without entering the queue', () => {
    const states = [];
    m._recordingStateCallback = (s) => states.push(s);
    m._onNotify(frame([0x01, 0x14, 0x00]));
    m._onNotify(frame([0x01, 0x17, 0x00]));
    expect(states).toEqual([true, false]);
    expect(m._notifyQueue).toHaveLength(0);
  });
});

describe('BleDeviceManager.unpair', () => {
  it('sends 0x05 with the keep-recordings flag (0x00) and waits for the echo', async () => {
    const m = new BleDeviceManager();
    const writes = [];
    m.connected = true;
    m.deviceId = 'dev-1';
    m.ble = {
      writeWithoutResponse: async (_id, _svc, _chr, dv) => {
        writes.push(Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)));
        // device acknowledges
        m._onNotify(frame([0x01, 0x05, 0x00, 0x01]));
      }
    };
    m.disconnect = vi.fn(async () => { m.connected = false; });
    await m.unpair();
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(0, 3)).toEqual([0x01, 0x05, 0x00]);
    expect(writes[0][3]).toBe(0x00);
    expect(m.disconnect).toHaveBeenCalled();
  });
});
