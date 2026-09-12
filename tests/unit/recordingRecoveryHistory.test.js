// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { repairRecoveredHistoryRecord } = require('../../src-electron/recording-export');

describe('authoritative recovered history location', () => {
  it.each(['completed', 'uploaded', 'skipped', 'cancelled', 'pending_verification', 'failed', 'pending'])('repairs stale location/size without changing %s or user intent', status => {
    const existing = { id: 'recording', userId: 'owner', filePath: '/old/profile/audio.webm', fileSize: 999,
      uploadStatus: status, storagePreference: 'keep', audioFileId: 'remote', uploadVerified: true,
      duration: 90, captureWarnings: ['microphone-disconnected'], title: 'Meeting' };
    const result = repairRecoveredHistoryRecord(existing, { outputPath: '/canonical/audio.webm', fileSize: 123, duration: 89,
      warnings: [{ kind: 'native-source-interrupted' }] });
    expect(result).toEqual({ ...existing, filePath: '/canonical/audio.webm', fileSize: 123, recovered: true,
      captureWarnings: ['microphone-disconnected', 'native-source-interrupted'] });
    expect(existing.filePath).toBe('/old/profile/audio.webm');
  });
  it('fills an unknown duration and preserves accumulated warning kinds', () => {
    expect(repairRecoveredHistoryRecord({ duration: 0, captureWarnings: ['gap'] }, {
      outputPath: '/canonical/audio.webm', fileSize: 123, duration: 20, warnings: ['gap', { code: 'partial' }]
    })).toMatchObject({ duration: 20, captureWarnings: ['gap', 'partial'] });
  });
});
