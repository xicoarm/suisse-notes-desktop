// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateNativeMedia } = require('../../src-electron/native-media-validation');
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'suisse-native-media-')); });
afterEach(() => {
  if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('suisse-native-media-')) throw new Error('Unsafe fixture cleanup');
  fs.rmSync(root, { recursive: true, force: true });
});
function flacHeader() {
  const data = Buffer.alloc(42); data.write('fLaC'); data.writeUIntBE(34, 5, 3);
  data.writeUIntBE((48000 << 4) | (1 << 1), 18, 3);
  return data;
}
function save(name, data) { const file = path.join(root, name); fs.writeFileSync(file, data); return file; }

describe('native intermediate and final container header gates', () => {
  it('accepts the explicit lossless format without relaxing the final WebM gate', () => {
    const header = flacHeader(), file = save('intermediate.flac', header);
    expect(validateNativeMedia(file, { container: 'flac' })).toMatchObject({ valid: true, size: 42, container: 'flac' });
    expect(validateNativeMedia(file).valid).toBe(false);
    expect(fs.readFileSync(file)).toEqual(header);
    const webm = Buffer.alloc(1024); Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(webm);
    const output = save('audio.webm', webm);
    expect(validateNativeMedia(output)).toMatchObject({ valid: true, container: 'webm' });
    expect(validateNativeMedia(output, { container: 'flac' }).valid).toBe(false);
  });
  it('rejects malformed, truncated and wrong-format lossless intermediates', () => {
    for (const mutate of [data => { data[0] = 0; }, data => { data[4] = 1; },
      data => { data[7] = 33; }, data => { data[18] = 0; }, data => { data[20] &= ~2; }]) {
      const data = flacHeader(); mutate(data);
      expect(validateNativeMedia(save('broken.flac', data), { container: 'flac' }).valid).toBe(false);
    }
    expect(validateNativeMedia(save('short.flac', flacHeader().subarray(0, 41)), { container: 'flac' }).valid).toBe(false);
    expect(validateNativeMedia(root, { container: 'flac' }).valid).toBe(false);
    expect(validateNativeMedia(path.join(root, 'missing'), { container: 'flac' }).valid).toBe(false);
    expect(validateNativeMedia(save('unknown', flacHeader()), { container: 'unknown' }).valid).toBe(false);
  });
});
