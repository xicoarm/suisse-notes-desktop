import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRecordingStore } from '../../src/stores/recording';

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-resilience'
}));

// Mock electronAPI
const mockElectronAPI = {
  recording: {
    createSession: vi.fn(),
    saveChunk: vi.fn(),
    combineChunks: vi.fn(),
    createSessionFile: vi.fn(),
    setInProgress: vi.fn().mockResolvedValue({ success: true }),
    setProcessing: vi.fn().mockResolvedValue({ success: true }),
    checkDiskSpace: vi.fn()
  }
};

vi.stubGlobal('window', {
  electronAPI: mockElectronAPI
});

describe('Resilience Features', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('Chunk Save Retry Logic', () => {
    it('should retry on failure and succeed on second attempt', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';
      store.chunkIndex = 0;

      // Fail first time, succeed second time
      mockElectronAPI.recording.saveChunk
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({ success: true });

      const result = await store.saveChunk(new ArrayBuffer(1000));

      expect(result.success).toBe(true);
      expect(store.chunkIndex).toBe(1);
      expect(mockElectronAPI.recording.saveChunk).toHaveBeenCalledTimes(2);
    });

    it('should retry up to 3 times before failing', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';
      store.chunkIndex = 0;

      // Fail all 4 attempts (1 + 3 retries)
      mockElectronAPI.recording.saveChunk.mockRejectedValue(new Error('Persistent error'));

      const result = await store.saveChunk(new ArrayBuffer(1000));

      expect(result.success).toBe(false);
      expect(result.retriesExhausted).toBe(true);
      expect(store.chunkIndex).toBe(0); // Should not increment on failure
      expect(mockElectronAPI.recording.saveChunk).toHaveBeenCalledTimes(4);
    }, 15000); // Increase timeout for retry delays

    it('should handle server error response in saveChunk', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';
      store.chunkIndex = 0;

      mockElectronAPI.recording.saveChunk.mockResolvedValue({
        success: false,
        error: 'Disk full'
      });

      // First attempt fails, mock succeeds on retry
      mockElectronAPI.recording.saveChunk
        .mockResolvedValueOnce({ success: false, error: 'Disk full' })
        .mockResolvedValueOnce({ success: true });

      const result = await store.saveChunk(new ArrayBuffer(1000));

      expect(result.success).toBe(true);
    });
  });

  describe('Session File Creation (Auto-Split)', () => {
    it('should create session file successfully', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';

      mockElectronAPI.recording.createSessionFile.mockResolvedValue({ success: true });

      const result = await store.createSessionFile();

      expect(result.success).toBe(true);
      expect(mockElectronAPI.recording.createSessionFile).toHaveBeenCalledWith('test-id', '.webm');
    });

    it('should handle session file creation failure', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';

      mockElectronAPI.recording.createSessionFile.mockResolvedValue({
        success: false,
        error: 'FFmpeg error'
      });

      const result = await store.createSessionFile();

      expect(result.success).toBe(false);
      expect(result.error).toContain('FFmpeg error');
    });

    it('should reset chunk index after auto-split', () => {
      const store = useRecordingStore();
      store.chunkIndex = 500;

      store.resetChunkIndex();

      expect(store.chunkIndex).toBe(0);
    });
  });

  describe('Recording State Management (Window Close Protection)', () => {
    it('should notify main process when recording starts', async () => {
      const store = useRecordingStore();
      mockElectronAPI.recording.createSession.mockResolvedValue({ success: true });

      await store.startRecording();

      expect(mockElectronAPI.recording.setInProgress).toHaveBeenCalledWith(true);
    });

    it('should clear recording state on start failure', async () => {
      const store = useRecordingStore();
      mockElectronAPI.recording.createSession.mockResolvedValue({
        success: false,
        error: 'Disk full'
      });

      await store.startRecording();

      // Should call setInProgress(false) after failure
      expect(mockElectronAPI.recording.setInProgress).toHaveBeenCalledWith(false);
    });

    it('should transition states correctly when stopping', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';
      store.status = 'recording';

      mockElectronAPI.recording.combineChunks.mockResolvedValue({
        success: true,
        outputPath: '/path/to/audio.webm'
      });

      await store.stopRecording();

      // Should call setInProgress(false) first, then setProcessing(true), then setProcessing(false)
      expect(mockElectronAPI.recording.setInProgress).toHaveBeenCalledWith(false);
      expect(mockElectronAPI.recording.setProcessing).toHaveBeenCalledWith(true);
      expect(mockElectronAPI.recording.setProcessing).toHaveBeenCalledWith(false);
    });

    it('should clear all states on stop error', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';
      store.status = 'recording';

      mockElectronAPI.recording.combineChunks.mockRejectedValue(new Error('Processing error'));

      await store.stopRecording();

      expect(mockElectronAPI.recording.setInProgress).toHaveBeenCalledWith(false);
      expect(mockElectronAPI.recording.setProcessing).toHaveBeenCalledWith(false);
      expect(store.status).toBe('error');
    });
  });

  describe('Stop Recording with Warnings', () => {
    it('should include warning from chunk sequence validation', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';
      store.status = 'recording';

      mockElectronAPI.recording.combineChunks.mockResolvedValue({
        success: true,
        outputPath: '/path/to/audio.webm',
        warning: 'Missing chunks detected (indices: 5, 6). Audio may have gaps.'
      });

      const result = await store.stopRecording();

      expect(result.success).toBe(true);
      expect(result.warning).toContain('Missing chunks');
    });
  });

  describe('Background Upload Management', () => {
    it('should update background upload progress correctly', () => {
      const store = useRecordingStore();
      store.backgroundUpload = {
        active: true,
        recordId: 'bg-upload-id',
        progress: 0,
        bytesUploaded: 0,
        bytesTotal: 10000,
        metadata: null
      };

      store.updateBackgroundUploadProgress('bg-upload-id', 50, 5000, 10000);

      expect(store.backgroundUpload.progress).toBe(50);
      expect(store.backgroundUpload.bytesUploaded).toBe(5000);
    });

    it('should not update progress for different recordId', () => {
      const store = useRecordingStore();
      store.backgroundUpload = {
        active: true,
        recordId: 'bg-upload-id',
        progress: 25,
        bytesUploaded: 2500,
        bytesTotal: 10000,
        metadata: null
      };

      store.updateBackgroundUploadProgress('different-id', 75, 7500, 10000);

      // Should remain unchanged
      expect(store.backgroundUpload.progress).toBe(25);
      expect(store.backgroundUpload.bytesUploaded).toBe(2500);
    });

    it('should clear background upload correctly', () => {
      const store = useRecordingStore();
      store.backgroundUpload = {
        active: true,
        recordId: 'bg-upload-id',
        progress: 100,
        bytesUploaded: 10000,
        bytesTotal: 10000,
        metadata: { duration: 120 }
      };

      store.clearBackgroundUpload();

      expect(store.backgroundUpload.active).toBe(false);
      expect(store.backgroundUpload.recordId).toBeNull();
      expect(store.backgroundUpload.progress).toBe(0);
    });
  });
});
