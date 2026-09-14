'use strict';
const fs = require('fs');

// The native reconstruction path writes FLAC intermediates and a WebM final.
// Validate the requested container explicitly; a file extension is not proof.
// Full media decoding/timeline validation follows this readability/header gate.
function validateNativeMedia(file, { container = 'webm' } = {}) {
  if (!['webm', 'flac'].includes(container)) return { valid: false, error: 'Unsupported native audio container' };
  let fd;
  try {
    const stat = fs.lstatSync(file), minimum = container === 'flac' ? 42 : 1024;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimum) return { valid: false, error: 'Native audio file is missing, unsafe or too small' };
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(42);
    if (fs.readSync(fd, head, 0, head.length, 0) !== head.length) return { valid: false, error: 'Native audio header could not be read completely' };
    if (container === 'webm') {
      if (!head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { valid: false, error: 'Native output lacks its WebM/EBML header' };
    } else {
      if (!head.subarray(0, 4).equals(Buffer.from('fLaC')) || (head[4] & 0x7f) !== 0 || head.readUIntBE(5, 3) !== 34) {
        return { valid: false, error: 'Native intermediate lacks a valid FLAC STREAMINFO header' };
      }
      const sampleRate = head.readUIntBE(18, 3) >>> 4;
      const channels = ((head[20] >>> 1) & 7) + 1;
      if (sampleRate !== 48000 || channels !== 2) return { valid: false, error: 'Native intermediate must contain 48kHz stereo FLAC' };
    }
    const tail = Buffer.alloc(Math.min(stat.size, 1024));
    if (fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length) !== tail.length) return { valid: false, error: 'Native audio tail could not be read completely' };
    return { valid: true, size: stat.size, container };
  } catch (error) {
    return { valid: false, error: `Native audio validation failed: ${error.message}` };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { validateNativeMedia };
