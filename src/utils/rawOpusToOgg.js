/**
 * Convert raw 80-byte Opus packets to Ogg Opus container format.
 *
 * The T240 BLE recording device stores audio as concatenated 80-byte
 * Opus packets (SILK WB 20ms, mono, 16kHz). These are valid Opus
 * packets with built-in padding (RFC 6716 code 3) but lack the Ogg
 * container that browsers/iOS need for playback.
 *
 * This function wraps the raw packets in a proper Ogg Opus stream
 * so they can be played by standard audio elements and decoded by
 * ffmpeg on the server.
 */

const PACKET_SIZE = 80;
const SAMPLES_PER_PACKET_48K = 960; // 20ms at 48kHz (Ogg Opus granule rate)

/**
 * Detect if a Uint8Array contains raw 80-byte Opus packets from the T240 device.
 * Checks: file size is a multiple of 80, and first byte is a valid Opus TOC (0x4B).
 */
export function isRawOpusPackets(data) {
  if (!data || data.length < PACKET_SIZE || data.length % PACKET_SIZE !== 0) {
    return false;
  }
  // First byte should be 0x4B (Opus TOC: SILK WB 20ms, mono, code 3)
  return data[0] === 0x4B;
}

/**
 * Convert raw 80-byte Opus packets into a valid Ogg Opus file.
 * @param {Uint8Array} rawData - Concatenated 80-byte Opus packets
 * @returns {Uint8Array} - Valid Ogg Opus file
 */
export function rawOpusToOgg(rawData) {
  const numPackets = Math.floor(rawData.length / PACKET_SIZE);
  if (numPackets === 0) return rawData;

  try {
    const serial = 0x4B4146; // "KAF"
    const pages = [];

    // Page 0: OpusHead (BOS)
    const opusHead = new Uint8Array(19);
    writeString(opusHead, 0, 'OpusHead');
    opusHead[8] = 1;   // version
    opusHead[9] = 1;   // channels (mono)
    writeUint16LE(opusHead, 10, 312);    // pre-skip
    writeUint32LE(opusHead, 12, 16000);  // input sample rate
    writeInt16LE(opusHead, 16, 0);       // output gain
    opusHead[18] = 0;  // channel mapping family
    pages.push(makeOggPage(0x02, 0, serial, 0, [opusHead]));

    // Page 1: OpusTags
    const vendor = 'raw2ogg';
    const opusTags = new Uint8Array(8 + 4 + vendor.length + 4);
    writeString(opusTags, 0, 'OpusTags');
    writeUint32LE(opusTags, 8, vendor.length);
    writeString(opusTags, 12, vendor);
    writeUint32LE(opusTags, 12 + vendor.length, 0); // no comments
    pages.push(makeOggPage(0x00, 0, serial, 1, [opusTags]));

    // Audio pages: batch ~20 packets per page
    let granule = 0;
    let batch = [];
    let pageSeq = 2;
    const BATCH_SIZE = 20;

    for (let i = 0; i < numPackets; i++) {
      const packet = rawData.slice(i * PACKET_SIZE, (i + 1) * PACKET_SIZE);
      batch.push(packet);
      granule += SAMPLES_PER_PACKET_48K;

      if (batch.length >= BATCH_SIZE || i === numPackets - 1) {
        const flags = (i === numPackets - 1) ? 0x04 : 0x00; // EOS on last page
        pages.push(makeOggPage(flags, granule, serial, pageSeq, batch));
        pageSeq++;
        batch = [];
      }
    }

    // Concatenate all pages
    let totalSize = 0;
    for (const page of pages) totalSize += page.length;
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const page of pages) {
      result.set(page, offset);
      offset += page.length;
    }

    // P2 Fix: Validate output starts with OggS magic and has reasonable size
    // Expected: 2 header pages + ceil(numPackets/BATCH_SIZE) audio pages
    if (result.length < 47 || result[0] !== 0x4F || result[1] !== 0x67 || result[2] !== 0x67 || result[3] !== 0x53) {
      throw new Error(`OGG output validation failed: invalid header magic (got ${result.slice(0, 4)})`);
    }

    return result;
  } catch (error) {
    console.error('rawOpusToOgg conversion failed:', error);
    throw error;
  }
}


// ===== Ogg page construction =====

function makeOggPage(headerType, granule, serial, pageSeq, segments) {
  // Build segment table
  const segTable = [];
  for (const seg of segments) {
    let len = seg.length;
    while (len >= 255) {
      segTable.push(255);
      len -= 255;
    }
    segTable.push(len);
  }

  const headerSize = 27 + segTable.length;
  let dataSize = 0;
  for (const seg of segments) dataSize += seg.length;
  const page = new Uint8Array(headerSize + dataSize);

  // Write header (CRC = 0 initially)
  writeString(page, 0, 'OggS');
  page[4] = 0;           // version
  page[5] = headerType;  // flags
  writeGranule(page, 6, granule);
  writeUint32LE(page, 14, serial);
  writeUint32LE(page, 18, pageSeq);
  writeUint32LE(page, 22, 0); // CRC placeholder
  page[26] = segTable.length;
  for (let i = 0; i < segTable.length; i++) {
    page[27 + i] = segTable[i];
  }

  // Write segment data
  let offset = headerSize;
  for (const seg of segments) {
    page.set(seg, offset);
    offset += seg.length;
  }

  // Compute and write CRC
  const crc = crc32Ogg(page);
  writeUint32LE(page, 22, crc);

  return page;
}


// ===== Binary helpers =====

function writeString(buf, offset, str) {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}

function writeUint16LE(buf, offset, value) {
  buf[offset] = value & 0xFF;
  buf[offset + 1] = (value >> 8) & 0xFF;
}

function writeInt16LE(buf, offset, value) {
  writeUint16LE(buf, offset, value & 0xFFFF);
}

function writeUint32LE(buf, offset, value) {
  buf[offset] = value & 0xFF;
  buf[offset + 1] = (value >> 8) & 0xFF;
  buf[offset + 2] = (value >> 16) & 0xFF;
  buf[offset + 3] = (value >> 24) & 0xFF;
}

function writeGranule(buf, offset, value) {
  // Write 64-bit LE granule position (value fits in 52-bit JS number)
  writeUint32LE(buf, offset, value & 0xFFFFFFFF);
  writeUint32LE(buf, offset + 4, Math.floor(value / 0x100000000));
}


// ===== OGG CRC32 =====

let _crcTable = null;

function getCrcTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
    _crcTable[i] = crc;
  }
  return _crcTable;
}

function crc32Ogg(data) {
  const table = getCrcTable();
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = (((crc << 8) >>> 0) ^ table[((crc >>> 24) ^ data[i]) & 0xFF]) >>> 0;
  }
  return crc;
}
