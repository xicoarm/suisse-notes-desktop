import { describe, it, expect } from 'vitest';
import {
  validateRecordId,
  validateExtension,
  validateUserId,
  validateChunkIndex,
  validateEmail,
  validatePassword,
  validateRecordingMetadata
} from '../../src/utils/validation';

describe('validateRecordId', () => {
  it('should accept valid UUID', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(validateRecordId(uuid)).toBe(uuid);
  });

  it('should accept simple alphanumeric ID', () => {
    expect(validateRecordId('recording_123')).toBe('recording_123');
    expect(validateRecordId('rec-456')).toBe('rec-456');
  });

  it('should reject empty recordId', () => {
    expect(() => validateRecordId('')).toThrow('Recording ID is required');
    expect(() => validateRecordId(null)).toThrow('Recording ID is required');
    expect(() => validateRecordId(undefined)).toThrow('Recording ID is required');
  });

  it('should reject invalid format', () => {
    expect(() => validateRecordId('../../../etc/passwd')).toThrow('Invalid recording ID format');
    expect(() => validateRecordId('path/traversal')).toThrow('Invalid recording ID format');
    expect(() => validateRecordId('a'.repeat(100))).toThrow('Invalid recording ID format');
  });
});

describe('validateExtension', () => {
  it('should accept valid audio extensions', () => {
    expect(validateExtension('.webm')).toBe('.webm');
    expect(validateExtension('.mp3')).toBe('.mp3');
    expect(validateExtension('.wav')).toBe('.wav');
    expect(validateExtension('.WEBM')).toBe('.webm'); // Case insensitive
  });

  it('should accept valid video extensions', () => {
    expect(validateExtension('.mp4')).toBe('.mp4');
    expect(validateExtension('.mov')).toBe('.mov');
  });

  it('should reject invalid extensions', () => {
    expect(() => validateExtension('.exe')).toThrow('Invalid file extension');
    expect(() => validateExtension('.js')).toThrow('Invalid file extension');
    expect(() => validateExtension('.sh')).toThrow('Invalid file extension');
  });

  it('should reject empty extension', () => {
    expect(() => validateExtension('')).toThrow('File extension is required');
    expect(() => validateExtension(null)).toThrow('File extension is required');
  });

  it('should reject path traversal attempts', () => {
    expect(() => validateExtension('.webm/../../../')).toThrow('Invalid file extension');
  });
});

describe('validateUserId', () => {
  it('should accept valid user IDs', () => {
    expect(validateUserId('user123')).toBe('user123');
    expect(validateUserId('user@example.com')).toBe('user@example.com');
    expect(validateUserId('user_name-123')).toBe('user_name-123');
  });

  it('should reject empty userId', () => {
    expect(() => validateUserId('')).toThrow('User ID is required');
    expect(() => validateUserId(null)).toThrow('User ID is required');
  });

  it('should reject too long userId', () => {
    expect(() => validateUserId('a'.repeat(200))).toThrow('User ID too long');
  });

  it('should reject invalid characters', () => {
    expect(() => validateUserId('user<script>')).toThrow('User ID contains invalid characters');
    expect(() => validateUserId('user;DROP TABLE')).toThrow('User ID contains invalid characters');
    expect(() => validateUserId('user\n\r')).toThrow('User ID contains invalid characters');
  });
});

describe('validateChunkIndex', () => {
  it('should accept valid chunk indices', () => {
    expect(validateChunkIndex(0)).toBe(0);
    expect(validateChunkIndex(1)).toBe(1);
    expect(validateChunkIndex(1000)).toBe(1000);
  });

  it('should reject negative indices', () => {
    expect(() => validateChunkIndex(-1)).toThrow('Invalid chunk index');
  });

  it('should reject non-integer indices', () => {
    expect(() => validateChunkIndex(1.5)).toThrow('Invalid chunk index');
    expect(() => validateChunkIndex('1')).toThrow('Invalid chunk index');
  });

  it('should reject too large indices', () => {
    expect(() => validateChunkIndex(200000)).toThrow('Chunk index too large');
  });
});

describe('validateEmail', () => {
  it('should accept valid emails', () => {
    expect(validateEmail('user@example.com')).toBe('user@example.com');
    expect(validateEmail('USER@EXAMPLE.COM')).toBe('user@example.com');
    expect(validateEmail('user.name@domain.co.uk')).toBe('user.name@domain.co.uk');
  });

  it('should reject invalid emails', () => {
    expect(() => validateEmail('invalid')).toThrow('Invalid email format');
    expect(() => validateEmail('@nodomain.com')).toThrow('Invalid email format');
    expect(() => validateEmail('no@')).toThrow('Invalid email format');
  });

  it('should reject empty email', () => {
    expect(() => validateEmail('')).toThrow('Email is required');
  });
});

describe('validatePassword', () => {
  it('should accept valid passwords', () => {
    expect(validatePassword('password123')).toBe('password123');
    expect(validatePassword('MySecureP@ss!')).toBe('MySecureP@ss!');
  });

  it('should reject short passwords', () => {
    expect(() => validatePassword('short')).toThrow('Password must be at least 8 characters');
  });

  it('should reject empty password', () => {
    expect(() => validatePassword('')).toThrow('Password is required');
  });
});

describe('validateRecordingMetadata', () => {
  it('should validate duration', () => {
    const result = validateRecordingMetadata({ duration: 120 });
    expect(result.duration).toBe(120);
  });

  it('should validate title', () => {
    const result = validateRecordingMetadata({ title: 'My Recording' });
    expect(result.title).toBe('My Recording');
  });

  it('should truncate long titles', () => {
    const longTitle = 'a'.repeat(300);
    const result = validateRecordingMetadata({ title: longTitle });
    expect(result.title.length).toBe(255);
  });

  it('should handle empty/invalid input', () => {
    expect(validateRecordingMetadata(null)).toEqual({});
    expect(validateRecordingMetadata(undefined)).toEqual({});
    expect(validateRecordingMetadata('string')).toEqual({});
  });

  it('should ignore invalid duration', () => {
    const result = validateRecordingMetadata({ duration: 'invalid' });
    expect(result.duration).toBeUndefined();
  });
});
