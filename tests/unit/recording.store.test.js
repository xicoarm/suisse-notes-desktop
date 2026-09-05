import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRecordingStore } from '../../src/stores/recording';
import { createChunkIntegrity, createRecordingIntegrity } from '../../src/services/integrity';
import * as storage from '../../src/services/storage';

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

      it('keeps preparation distinct from confirmed audio capture', async () => {
        const store = useRecordingStore();
        mockElectronAPI.recording.createSession.mockResolvedValue({ success: true });
        const result = await store.startRecording(null, { deferCaptureStart: true });
        expect(result.success).toBe(true);
        expect(store.phase).toBe('preparing');
        expect(store.isRecording).toBe(false);
        expect(store.isBlocking).toBe(true);
        store.confirmCaptureStarted();
        expect(store.isRecording).toBe(true);
      });

      it('durably selects native mode and retains retry visibility without any mixed chunks', async () => {
        const store = useRecordingStore();
        mockElectronAPI.recording.createSession.mockResolvedValue({ success: true });
        await store.startRecording(null, { deferCaptureStart: true, captureMode: 'native-sources-v1' });
        expect(mockElectronAPI.recording.createSession).toHaveBeenCalledWith(store.recordId, '.webm', null, { captureMode: 'native-sources-v1' });
        expect(store.captureMode).toBe('native-sources-v1');
        mockElectronAPI.recording.combineChunks.mockResolvedValue({ success: false, error: 'Cannot finalize yet' });
        expect(await store.stopRecording()).toMatchObject({ success: false, partialRecovery: true, chunkCount: 0 });
        store.reset();
        expect(store.captureMode).toBeNull();
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
      it('passes the independent elapsed time instead of the clamped display to finalization', async () => {
        const store = useRecordingStore();
        store.recordId = 'test-id'; store.phase = 'recording'; store.duration = 3;
        mockElectronAPI.recording.combineChunks.mockResolvedValue({ success: true, outputPath: '/path/to/audio.webm' });
        await store.stopRecording(90);
        expect(mockElectronAPI.recording.combineChunks).toHaveBeenCalledWith('test-id', '.webm', 90);
      });
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
        expect(store.phase).toBe('stopped');
      });
    });

    describe('saveChunk', () => {
      function storeWithSavedPrefix() {
        const store = useRecordingStore();
        store.recordId = 'test-id';
        store.integrity = createRecordingIntegrity(store.recordId);
        store.integrity.chunks.push(createChunkIntegrity(0, Uint8Array.of(1, 2, 3)));
        store.integrity.totalSize = 3;
        store.chunkIndex = 1;
        mockElectronAPI.recording.saveChunk.mockReset();
        return store;
      }

      it('appends acknowledged desktop chunks in order without copying the existing array', async () => {
        const store = storeWithSavedPrefix();
        const integrity = store.integrity;
        const chunks = integrity.chunks;
        const prior = chunks[0];
        let acknowledgeFirst;
        mockElectronAPI.recording.saveChunk
          .mockImplementationOnce(() => new Promise(resolve => { acknowledgeFirst = resolve; }))
          .mockResolvedValue({ success: true });
        const first = store.saveChunk(Uint8Array.of(4, 5));
        const second = store.saveChunk(Uint8Array.of(6, 7, 8, 9));
        await vi.waitFor(() => expect(mockElectronAPI.recording.saveChunk).toHaveBeenCalledTimes(1));
        expect(chunks).toHaveLength(1);
        expect(integrity.totalSize).toBe(3);
        acknowledgeFirst({ success: true });
        await Promise.all([first, second]);
        expect(store.integrity).toBe(integrity);
        expect(store.integrity.chunks).toBe(chunks);
        expect(chunks[0]).toBe(prior);
        expect(chunks.map(chunk => [chunk.index, chunk.size])).toEqual([[0, 3], [1, 2], [2, 4]]);
        expect(store.integrity.totalSize).toBe(9);
        expect(store.chunkIndex).toBe(3);
        expect(mockElectronAPI.recording.saveChunk.mock.calls.map(call => call[2])).toEqual([1, 2]);
      });

      it('adds desktop integrity and bytes exactly once after a transient retry', async () => {
        vi.useFakeTimers();
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          const store = storeWithSavedPrefix();
          const chunks = store.integrity.chunks;
          mockElectronAPI.recording.saveChunk
            .mockResolvedValueOnce({ success: false, code: 'EIO', error: 'temporary write failure' })
            .mockResolvedValue({ success: true });
          const saving = store.saveChunk(Uint8Array.of(4, 5));
          await vi.advanceTimersByTimeAsync(0);
          expect(chunks).toHaveLength(1);
          expect(store.integrity.totalSize).toBe(3);
          expect(store.chunkIndex).toBe(1);
          await vi.advanceTimersByTimeAsync(1000);
          expect(await saving).toEqual({ success: true });
          expect(store.integrity.chunks).toBe(chunks);
          expect(chunks.map(chunk => [chunk.index, chunk.size])).toEqual([[0, 3], [1, 2]]);
          expect(store.integrity.totalSize).toBe(5);
          expect(store.chunkIndex).toBe(2);
          expect(mockElectronAPI.recording.saveChunk.mock.calls.map(call => call[2])).toEqual([1, 1]);
        } finally { log.mockRestore(); error.mockRestore(); vi.useRealTimers(); }
      });

      it('does not append integrity or count bytes for a failed desktop write', async () => {
        const store = storeWithSavedPrefix();
        const chunks = store.integrity.chunks;
        const prior = chunks[0];
        mockElectronAPI.recording.saveChunk.mockResolvedValue({ success: false, diskFull: true, error: 'Disk full' });
        expect(await store.saveChunk(Uint8Array.of(4, 5))).toMatchObject({ success: false, diskFull: true });
        expect(store.integrity.chunks).toBe(chunks);
        expect(chunks).toHaveLength(1);
        expect(chunks[0]).toBe(prior);
        expect(store.integrity.totalSize).toBe(3);
        expect(store.chunkIndex).toBe(1);
      });

      it('preserves the immutable mobile integrity snapshot while metadata is being saved', async () => {
        const store = storeWithSavedPrefix();
        vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } });
        const save = vi.spyOn(storage, 'saveChunk').mockResolvedValue({ success: true });
        let snapshot, finishMetadata;
        const metadata = vi.spyOn(storage, 'saveMetadata').mockImplementation((recordId, value) => {
          snapshot = value;
          return new Promise(resolve => { finishMetadata = resolve; });
        });
        try {
          const flushing = store.flushCurrentState();
          const capturedIntegrity = snapshot.integrity;
          const capturedChunks = capturedIntegrity.chunks;
          await store.saveChunk(Uint8Array.of(4, 5));
          expect(store.integrity).not.toBe(capturedIntegrity);
          expect(store.integrity.chunks).not.toBe(capturedChunks);
          expect(snapshot.chunkIndex).toBe(1);
          expect(capturedChunks.map(chunk => [chunk.index, chunk.size])).toEqual([[0, 3]]);
          expect(capturedIntegrity.totalSize).toBe(3);
          expect(store.integrity.totalSize).toBe(5);
          expect(store.chunkIndex).toBe(2);
          finishMetadata({ success: true });
          await flushing;
        } finally {
          finishMetadata?.({ success: true });
          metadata.mockRestore(); save.mockRestore();
          vi.stubGlobal('window', { electronAPI: mockElectronAPI });
        }
      });

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
