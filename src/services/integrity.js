/**
 * Data integrity service
 * Provides checksum utilities for verifying chunk and file integrity
 * Addresses vulnerability V7: No Chunk Integrity Verification
 */

/**
 * CRC32 lookup table (precomputed for performance)
 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * Calculate CRC32 checksum for a buffer
 * Fast and lightweight, suitable for chunk verification
 * @param {ArrayBuffer | Uint8Array | number[]} data - Data to checksum
 * @returns {string} CRC32 checksum as hex string
 */
export const calculateCRC32 = (data) => {
  let bytes;
  if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (Array.isArray(data)) {
    bytes = new Uint8Array(data);
  } else {
    throw new Error('Invalid data type for CRC32 calculation');
  }

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }

  // Convert to unsigned 32-bit integer and then to hex
  const result = (crc ^ 0xFFFFFFFF) >>> 0;
  return result.toString(16).padStart(8, '0');
};

/**
 * Calculate SHA-256 hash for a buffer
 * More secure but slower, suitable for full file verification
 * @param {ArrayBuffer | Uint8Array | number[]} data - Data to hash
 * @returns {Promise<string>} SHA-256 hash as hex string
 */
export const calculateSHA256 = async (data) => {
  let buffer;
  if (data instanceof ArrayBuffer) {
    buffer = data;
  } else if (data instanceof Uint8Array) {
    buffer = data.buffer;
  } else if (Array.isArray(data)) {
    buffer = new Uint8Array(data).buffer;
  } else {
    throw new Error('Invalid data type for SHA-256 calculation');
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

/**
 * Verify data against a CRC32 checksum
 * @param {ArrayBuffer | Uint8Array | number[]} data - Data to verify
 * @param {string} expectedChecksum - Expected CRC32 checksum (hex string)
 * @returns {boolean} True if checksums match
 */
export const verifyCRC32 = (data, expectedChecksum) => {
  const actualChecksum = calculateCRC32(data);
  return actualChecksum === expectedChecksum.toLowerCase();
};

/**
 * Verify data against a SHA-256 hash
 * @param {ArrayBuffer | Uint8Array | number[]} data - Data to verify
 * @param {string} expectedHash - Expected SHA-256 hash (hex string)
 * @returns {Promise<boolean>} True if hashes match
 */
export const verifySHA256 = async (data, expectedHash) => {
  const actualHash = await calculateSHA256(data);
  return actualHash === expectedHash.toLowerCase();
};

/**
 * Chunk integrity metadata structure
 * @typedef {Object} ChunkIntegrity
 * @property {number} index - Chunk index
 * @property {number} size - Chunk size in bytes
 * @property {string} crc32 - CRC32 checksum
 * @property {number} timestamp - When chunk was saved (ms since epoch)
 */

/**
 * Create integrity metadata for a chunk
 * @param {number} index - Chunk index
 * @param {ArrayBuffer | Uint8Array | number[]} data - Chunk data
 * @returns {ChunkIntegrity} Integrity metadata
 */
export const createChunkIntegrity = (index, data) => {
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : (data instanceof Uint8Array ? data : new Uint8Array(data));

  return {
    index,
    size: bytes.length,
    crc32: calculateCRC32(bytes),
    timestamp: Date.now()
  };
};

/**
 * Verify a chunk against its integrity metadata
 * @param {ArrayBuffer | Uint8Array | number[]} data - Chunk data
 * @param {ChunkIntegrity} integrity - Integrity metadata to verify against
 * @returns {{valid: boolean, errors: string[]}} Verification result
 */
export const verifyChunkIntegrity = (data, integrity) => {
  const errors = [];
  const bytes = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : (data instanceof Uint8Array ? data : new Uint8Array(data));

  // Check size
  if (bytes.length !== integrity.size) {
    errors.push(`Size mismatch: expected ${integrity.size}, got ${bytes.length}`);
  }

  // Check CRC32
  const actualCRC32 = calculateCRC32(bytes);
  if (actualCRC32 !== integrity.crc32) {
    errors.push(`CRC32 mismatch: expected ${integrity.crc32}, got ${actualCRC32}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

/**
 * Recording integrity metadata structure
 * @typedef {Object} RecordingIntegrity
 * @property {string} recordId - Recording session ID
 * @property {ChunkIntegrity[]} chunks - Array of chunk integrity metadata
 * @property {number} totalSize - Total size of all chunks
 * @property {string} combinedCRC32 - CRC32 of combined data (set after combination)
 * @property {string} combinedSHA256 - SHA-256 of combined file (set after combination)
 */

/**
 * Create empty recording integrity metadata
 * @param {string} recordId - Recording session ID
 * @returns {RecordingIntegrity} Empty integrity metadata
 */
export const createRecordingIntegrity = (recordId) => {
  return {
    recordId,
    chunks: [],
    totalSize: 0,
    combinedCRC32: null,
    combinedSHA256: null
  };
};

/**
 * Add chunk integrity to recording metadata
 * @param {RecordingIntegrity} recording - Recording integrity metadata
 * @param {ChunkIntegrity} chunk - Chunk integrity to add
 * @returns {RecordingIntegrity} Updated recording integrity
 */
export const addChunkToRecordingIntegrity = (recording, chunk) => {
  return {
    ...recording,
    chunks: [...recording.chunks, chunk],
    totalSize: recording.totalSize + chunk.size
  };
};

/**
 * Verify all chunks in a recording against their integrity metadata
 * @param {Function} readChunk - Async function to read chunk data by index
 * @param {RecordingIntegrity} integrity - Recording integrity metadata
 * @returns {Promise<{valid: boolean, invalidChunks: number[], errors: string[]}>}
 */
export const verifyRecordingIntegrity = async (readChunk, integrity) => {
  const invalidChunks = [];
  const errors = [];

  for (const chunkIntegrity of integrity.chunks) {
    try {
      const data = await readChunk(chunkIntegrity.index);
      const result = verifyChunkIntegrity(data, chunkIntegrity);

      if (!result.valid) {
        invalidChunks.push(chunkIntegrity.index);
        errors.push(`Chunk ${chunkIntegrity.index}: ${result.errors.join(', ')}`);
      }
    } catch (error) {
      invalidChunks.push(chunkIntegrity.index);
      errors.push(`Chunk ${chunkIntegrity.index}: Failed to read - ${error.message}`);
    }
  }

  return {
    valid: invalidChunks.length === 0,
    invalidChunks,
    errors
  };
};

/**
 * Calculate checksum for upload verification
 * Uses SHA-256 for secure server verification
 * @param {ArrayBuffer | Uint8Array} data - File data
 * @returns {Promise<string>} Checksum in format "sha256:hexstring"
 */
export const calculateUploadChecksum = async (data) => {
  const hash = await calculateSHA256(data);
  return `sha256:${hash}`;
};

/**
 * Verify upload checksum returned by server
 * @param {ArrayBuffer | Uint8Array} localData - Local file data
 * @param {string} serverChecksum - Server-provided checksum (format: "sha256:hexstring")
 * @returns {Promise<boolean>} True if checksums match
 */
export const verifyUploadChecksum = async (localData, serverChecksum) => {
  if (!serverChecksum || !serverChecksum.startsWith('sha256:')) {
    console.warn('Invalid or missing server checksum format');
    return false;
  }

  const expectedHash = serverChecksum.replace('sha256:', '');
  return verifySHA256(localData, expectedHash);
};
