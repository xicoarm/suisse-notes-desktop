import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRecordingStore } from '../../src/stores/recording';

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-1234'
}));

// Mock electronAPI
const mockElectronAPI = {
  recording: {
    createSession: vi.fn(),
    saveChunk: vi.fn(),
    combineChunks: vi.fn(),
    createSessionFile: vi.fn(),
    setInProgress: vi.fn().mockResolvedValue({ success: true }),
    setProcessing: vi.fn().mockResolvedValue({ success: true })
  }
};

vi.stubGlobal('window', {
  electronAPI: mockElectronAPI
});

describe('Recording Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should have correct initial state', () => {
      const store = useRecordingStore();
      expect(store.recordId).toBeNull();
      expect(store.phase).toBe('idle');
      expect(store.duration).toBe(0);
      expect(store.chunkIndex).toBe(0);
      expect(store.uploadProgress).toBe(0);
      expect(store.error).toBeNull();
    });
  });

  describe('getters', () => {
    it('isRecording should return true when recording', () => {
      const store = useRecordingStore();
      store.phase = 'recording';
      expect(store.isRecording).toBe(true);
      expect(store.isPaused).toBe(false);
    });

    it('isPaused should return true when paused', () => {
      const store = useRecordingStore();
      store.phase = 'paused';
      expect(store.isPaused).toBe(true);
      expect(store.isRecording).toBe(false);
    });

    it('isUploading should return true when uploading', () => {
      const store = useRecordingStore();
      store.phase = 'uploading';
      expect(store.isUploading).toBe(true);
    });

    it('hasActiveUpload should detect uploading phase', () => {
      const store = useRecordingStore();
      expect(store.hasActiveUpload).toBe(false);

      store.phase = 'uploading';
      expect(store.hasActiveUpload).toBe(true);
    });

    it('formattedDuration should format time correctly', () => {
      const store = useRecordingStore();

      store.duration = 0;
      expect(store.formattedDuration).toBe('00:00:00');

      store.duration = 65;
      expect(store.formattedDuration).toBe('00:01:05');

      store.duration = 3661;
      expect(store.formattedDuration).toBe('01:01:01');
    });
  });

  describe('actions', () => {
    describe('startRecording', () => {
      it('should initialize recording state', async () => {
        const store = useRecordingStore();
        mockElectronAPI.recording.createSession.mockResolvedValue({ success: true });

        const result = await store.startRecording();

        expect(result.success).toBe(true);
        expect(store.recordId).toBe('test-uuid-1234');
        expect(store.phase).toBe('recording');
        expect(store.chunkIndex).toBe(0);
        expect(store.error).toBeNull();
      });

      it('should handle session creation failure', async () => {
        const store = useRecordingStore();
        mockElectronAPI.recording.createSession.mockResolvedValue({
          success: false,
          error: 'Disk full'
        });

        const result = await store.startRecording();

        expect(result.success).toBe(false);
        expect(store.phase).toBe('error');
      });
    });

    describe('pauseRecording', () => {
      it('should pause when recording', () => {
        const store = useRecordingStore();
        store.phase = 'recording';

        store.pauseRecording();

        expect(store.phase).toBe('paused');
      });

      it('should not change state when not recording', () => {
        const store = useRecordingStore();
        store.phase = 'idle';

        store.pauseRecording();

        expect(store.phase).toBe('idle');
      });
    });

    describe('resumeRecording', () => {
      it('should resume when paused', () => {
        const store = useRecordingStore();
        store.phase = 'paused';

        store.resumeRecording();

        expect(store.phase).toBe('recording');
      });
    });

    describe('stopRecording', () => {
      it('should combine chunks and return file path', async () => {
        const store = useRecordingStore();
        store.recordId = 'test-id';
        store.phase = 'recording';

        mockElectronAPI.recording.combineChunks.mockResolvedValue({
          success: true,
          outputPath: '/path/to/audio.webm'
        });

        const result = await store.stopRecording();

        expect(result.success).toBe(true);
        expect(result.filePath).toBe('/path/to/audio.webm');
        expect(store.audioFilePath).toBe('/path/to/audio.webm');
        expect(store.phase).toBe('stopping');
      });
    });

    describe('saveChunk', () => {
      it('should save chunk and increment index', async () => {
        const store = useRecordingStore();
        store.recordId = 'test-id';
        store.chunkIndex = 0;

        mockElectronAPI.recording.saveChunk.mockResolvedValue({ success: true });

        const result = await store.saveChunk(new ArrayBuffer(1000));

        expect(result.success).toBe(true);
        expect(store.chunkIndex).toBe(1);
      });
    });

    describe('updateDuration', () => {
      it('should update duration', () => {
        const store = useRecordingStore();
        store.updateDuration(120);
        expect(store.duration).toBe(120);
      });
    });

    describe('updateUploadProgress', () => {
      it('should update upload progress', () => {
        const store = useRecordingStore();
        store.updateUploadProgress(50, 5000, 10000);

        expect(store.uploadProgress).toBe(50);
        expect(store.bytesUploaded).toBe(5000);
        expect(store.bytesTotal).toBe(10000);
      });
    });

    describe('reset', () => {
      it('should reset all state to initial values', () => {
        const store = useRecordingStore();

        // Set some values
        store.recordId = 'test-id';
        store.phase = 'recording';
        store.duration = 100;
        store.chunkIndex = 5;
        store.error = 'Some error';

        store.reset();

        expect(store.recordId).toBeNull();
        expect(store.phase).toBe('idle');
        expect(store.duration).toBe(0);
        expect(store.chunkIndex).toBe(0);
        expect(store.error).toBeNull();
      });
    });
  });
});
