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
      store.phase = 'recording';

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
      store.phase = 'recording';

      mockElectronAPI.recording.combineChunks.mockRejectedValue(new Error('Processing error'));

      await store.stopRecording();

      expect(mockElectronAPI.recording.setInProgress).toHaveBeenCalledWith(false);
      expect(mockElectronAPI.recording.setProcessing).toHaveBeenCalledWith(false);
      expect(store.phase).toBe('error');
    });
  });

  describe('Stop Recording with Warnings', () => {
    it('should include warning from chunk sequence validation', async () => {
      const store = useRecordingStore();
      store.recordId = 'test-id';
      store.phase = 'recording';

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

  describe('Phase-Based State Machine', () => {
    it('should block navigation during processing phase', () => {
      const store = useRecordingStore();
      store.phase = 'processing';
      expect(store.isBlocking).toBe(true);
      expect(store.isProcessing).toBe(true);
    });

    it('should block navigation during uploading phase', () => {
      const store = useRecordingStore();
      store.phase = 'uploading';
      expect(store.isBlocking).toBe(true);
      expect(store.isUploading).toBe(true);
      expect(store.hasActiveUpload).toBe(true);
    });

    it('should allow navigation after upload completes', () => {
      const store = useRecordingStore();
      store.phase = 'uploaded';
      expect(store.isBlocking).toBe(false);
      expect(store.isUploaded).toBe(true);
    });
  });
});
