/**
 * Input validation utilities
 * Used by both renderer and main process for consistent validation
 */

// Validate UUID format for recordId
export function validateRecordId(recordId) {
  if (!recordId || typeof recordId !== 'string') {
    throw new Error('Recording ID is required');
  }
  // Allow UUID v4 format or simple alphanumeric IDs with hyphens/underscores
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const simpleIdRegex = /^[a-zA-Z0-9_-]{1,64}$/;
  if (!uuidRegex.test(recordId) && !simpleIdRegex.test(recordId)) {
    throw new Error('Invalid recording ID format');
  }
  return recordId;
}

// Validate file extension (whitelist approach)
export function validateExtension(ext) {
  const allowedExts = ['.webm', '.mp3', '.wav', '.ogg', '.flac', '.m4a', '.mp4', '.aac', '.opus', '.wma', '.amr', '.3gp', '.mov', '.mkv', '.avi'];
  if (!ext || typeof ext !== 'string') {
    throw new Error('File extension is required');
  }
  const normalizedExt = ext.toLowerCase();
  if (!allowedExts.includes(normalizedExt)) {
    throw new Error(`Invalid file extension: ${ext}`);
  }
  return normalizedExt;
}

// Validate userId
export function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID is required');
  }
  if (userId.length > 128) {
    throw new Error('User ID too long');
  }
  // Prevent injection attacks
  if (!/^[a-zA-Z0-9_@.-]+$/.test(userId)) {
    throw new Error('User ID contains invalid characters');
  }
  return userId;
}

// Validate chunk index
export function validateChunkIndex(chunkIndex) {
  if (typeof chunkIndex !== 'number' || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error('Invalid chunk index');
  }
  if (chunkIndex > 100000) { // Reasonable upper limit
    throw new Error('Chunk index too large');
  }
  return chunkIndex;
}

// Validate email format
export function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    throw new Error('Email is required');
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    throw new Error('Invalid email format');
  }
  return email.toLowerCase().trim();
}

// Validate password strength
export function validatePassword(password) {
  if (!password || typeof password !== 'string') {
    throw new Error('Password is required');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return password;
}

// Validate recording metadata
export function validateRecordingMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  const validated = {};

  if (metadata.duration !== undefined) {
    const duration = Number(metadata.duration);
    if (!isNaN(duration) && duration >= 0) {
      validated.duration = duration;
    }
  }

  if (metadata.title && typeof metadata.title === 'string') {
    validated.title = metadata.title.slice(0, 255); // Max 255 chars
  }

  return validated;
}
