/**
 * Upload service with two-phase verification
 * Addresses vulnerabilities V3 and V4:
 * - V3: Race Condition - File Deleted Before Server Confirmation
 * - V4: No Server-Side Acknowledgment Verification
 *
 * Platform-specific implementations:
 * - Electron (Windows/Mac): Uses main process upload via IPC
 * - Capacitor (iOS/Android): Uses TUS protocol for resumable uploads
 */

import { isElectron, isCapacitor, PlatformConstants } from '../utils/platform';
import { calculateUploadChecksum, verifyUploadChecksum } from './integrity';
import { readFile, deleteFile } from './storage';

// Token refresh callback - set by calling code
let onTokenRefreshNeeded = null;

/**
 * Set the token refresh callback
 * @param {Function} callback - Async function that returns { success, token } or null
 */
export const setTokenRefreshCallback = (callback) => {
  onTokenRefreshNeeded = callback;
};

/**
 * Check if an error indicates token expiration
 * @param {string} error - Error message
 * @param {number} status - HTTP status code (if available)
 * @returns {boolean}
 */
const isTokenExpiredError = (error, status = 0) => {
  if (status === 401) return true;

  const tokenErrors = [
    'token expired',
    'jwt expired',
    'invalid token',
    'unauthorized',
    'authentication required',
    'not authenticated'
  ];

  const errorLower = (error || '').toLowerCase();
  return tokenErrors.some(te => errorLower.includes(te));
};

// Upload state
const uploadQueue = [];
let isProcessingQueue = false;

// Active XHR references for cancellation (mobile only)
const activeXhrUploads = new Map();

/**
 * Cancel an active upload
 * @param {string} recordId - Recording ID
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const cancelUpload = async (recordId) => {
  // Check for active XHR upload (mobile)
  const xhr = activeXhrUploads.get(recordId);
  if (xhr) {
    try {
      xhr.abort();
      activeXhrUploads.delete(recordId);
      return { success: true, cancelled: true };
    } catch (e) {
      console.error('Error aborting XHR upload:', e);
      return { success: false, error: e.message };
    }
  }

  return { success: false, error: 'No active upload found' };
};

/**
 * Sleep utility
 * @param {number} ms - Milliseconds to sleep
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculate exponential backoff delay
 * @param {number} attempt - Current attempt number (0-indexed)
 * @returns {number} Delay in milliseconds
 */
const getBackoffDelay = (attempt) => {
  const delay = PlatformConstants.INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, PlatformConstants.MAX_RETRY_DELAY_MS);
};

/**
 * Read file data for checksum calculation
 * Platform-aware file reading
 * @param {string} filePath - Path to the file
 * @returns {Promise<ArrayBuffer>}
 */
const readFileData = async (filePath) => {
  if (isElectron()) {
    // On Electron, use the preload API
    const result = await window.electronAPI.file.readBinary(filePath);
    if (result.success) {
      return new Uint8Array(result.data).buffer;
    }
    throw new Error(result.error || 'Failed to read file');
  }

  if (isCapacitor()) {
    const result = await readFile(filePath);
    if (result.success) {
      return result.data;
    }
    throw new Error(result.error || 'Failed to read file');
  }

  throw new Error('Unsupported platform');
};

/**
 * Poll server for upload status and verification
 * @param {string} apiUrl - Base API URL
 * @param {string} audioFileId - Server-assigned file ID
 * @param {string} localChecksum - Local file checksum for verification
 * @param {number} maxAttempts - Maximum polling attempts
 * @returns {Promise<{persisted: boolean, verified: boolean, error?: string}>}
 */
const pollServerStatus = async (apiUrl, audioFileId, localChecksum, maxAttempts = 15) => {
  const pollInterval = 2000; // 2 seconds between polls

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${apiUrl}/api/desktop/upload/${audioFileId}/status`);

      if (!response.ok) {
        // Server doesn't support status endpoint yet, fall back to trust-based
        if (response.status === 404) {
          console.warn('Upload status endpoint not available, using trust-based confirmation');
          return { persisted: true, verified: false, fallback: true };
        }
        throw new Error(`Status check failed: ${response.status}`);
      }

      const status = await response.json();

      if (status.status === 'persisted' || status.status === 'complete') {
        // Server has persisted the file
        if (status.checksum && localChecksum) {
          // Verify checksum if available
          const checksumMatch = status.checksum === localChecksum;
          if (!checksumMatch) {
            console.error('Checksum mismatch!', { server: status.checksum, local: localChecksum });
            return { persisted: true, verified: false, error: 'Checksum mismatch' };
          }
          return { persisted: true, verified: true };
        }
        // No checksum verification available
        return { persisted: true, verified: false };
      }

      if (status.status === 'failed') {
        return { persisted: false, verified: false, error: status.error || 'Server processing failed' };
      }

      // Still processing, wait and retry
      await sleep(pollInterval);
    } catch (error) {
      console.warn(`Status poll attempt ${attempt + 1} failed:`, error.message);
      if (attempt < maxAttempts - 1) {
        await sleep(pollInterval);
      }
    }
  }

  // Timeout - server didn't confirm in time
  return { persisted: false, verified: false, error: 'Server confirmation timeout' };
};

/**
 * Upload recording with two-phase verification
 * Phase 1: Upload file
 * Phase 2: Verify server persistence before allowing deletion
 *
 * @param {Object} options - Upload options
 * @param {string} options.filePath - Path to the audio file (Capacitor) or File object (mobile file picker)
 * @param {File} options.file - File object for direct file upload (mobile)
 * @param {string} options.recordId - Recording ID
 * @param {string} options.apiUrl - API base URL
 * @param {string} options.authToken - Authentication token
 * @param {Object} options.metadata - Recording metadata
 * @param {Function} options.onProgress - Progress callback (0-100)
 * @param {Function} options.onStatusChange - Status change callback
 * @param {Function} options.getAuthStore - Function to get auth store for token refresh
 * @returns {Promise<{success: boolean, audioFileId?: string, canDelete: boolean, error?: string}>}
 */
export const uploadWithVerification = async (options) => {
  const {
    filePath,
    file, // File object for direct upload
    recordId,
    apiUrl,
    authToken,
    metadata = {},
    onProgress = () => {},
    onStatusChange = () => {},
    getAuthStore = null // For token refresh
  } = options;

  // Helper to get a fresh token
  const getFreshToken = async () => {
    if (getAuthStore) {
      const authStore = getAuthStore();
      const result = await authStore.handleAuthError();
      if (result.success) {
        return result.token;
      }
    }
    return null;
  };

  let audioFileId = null;
  let localChecksum = null;

  try {
    // Phase 1a: Calculate local checksum before upload
    onStatusChange('calculating_checksum');
    try {
      let fileData;
      if (file) {
        // Read from File object (from file picker)
        fileData = await file.arrayBuffer();
      } else if (filePath) {
        // Read from file path (from recording)
        fileData = await readFileData(filePath);
      }

      if (fileData) {
        localChecksum = await calculateUploadChecksum(fileData);
        console.log('Local checksum calculated:', localChecksum);
      }
    } catch (error) {
      console.warn('Could not calculate local checksum:', error.message);
      // Continue without checksum - verification will be trust-based
    }

    // Phase 1b: Upload the file
    onStatusChange('uploading');

    let currentToken = authToken;
    let uploadAttempts = 0;
    const maxTokenRefreshAttempts = 2;

    while (uploadAttempts < maxTokenRefreshAttempts) {
      uploadAttempts++;

      if (isElectron()) {
        // Use Electron's upload mechanism via IPC
        // The Electron main process handles the actual upload with retry logic
        const uploadResult = await window.electronAPI.upload.start({
          recordId,
          filePath,
          metadata
        });

        if (!uploadResult.success) {
          // Check for token expiration
          if (isTokenExpiredError(uploadResult.error, uploadResult.status)) {
            const newToken = await getFreshToken();
            if (newToken && uploadAttempts < maxTokenRefreshAttempts) {
              currentToken = newToken;
              console.log('Token refreshed, retrying upload...');
              continue;
            }
          }
          throw new Error(uploadResult.error || 'Upload failed');
        }

        audioFileId = uploadResult.audioFileId;
        break;
      } else if (isCapacitor()) {
        // Use fetch-based upload for mobile
        // Support both File object (from picker) and filePath (from recording)
        const uploadResult = file
          ? await uploadFileMobileSimple(null, apiUrl, currentToken, metadata, onProgress, file, recordId)
          : await uploadFileMobile(filePath, apiUrl, currentToken, metadata, onProgress, recordId);

        if (!uploadResult.success) {
          // Check for token expiration
          if (isTokenExpiredError(uploadResult.error, uploadResult.status)) {
            const newToken = await getFreshToken();
            if (newToken && uploadAttempts < maxTokenRefreshAttempts) {
              currentToken = newToken;
              console.log('Token refreshed, retrying upload...');
              continue;
            }
          }
          throw new Error(uploadResult.error || 'Upload failed');
        }

        audioFileId = uploadResult.audioFileId;
        break;
      } else {
        throw new Error('Unsupported platform');
      }
    }

    // Phase 2: Verify server persistence
    onStatusChange('verifying');
    const verification = await pollServerStatus(apiUrl, audioFileId, localChecksum);

    if (!verification.persisted) {
      console.error('Server did not confirm file persistence:', verification.error);
      return {
        success: false,
        audioFileId,
        canDelete: false,
        error: verification.error || 'Server did not confirm file persistence'
      };
    }

    if (verification.error === 'Checksum mismatch') {
      console.error('Checksum verification failed');
      return {
        success: false,
        audioFileId,
        canDelete: false,
        error: 'File verification failed - checksums do not match'
      };
    }

    // Upload successful and verified (or trust-based)
    onStatusChange('complete');
    return {
      success: true,
      audioFileId,
      canDelete: true,
      verified: verification.verified,
      fallback: verification.fallback
    };
  } catch (error) {
    console.error('Upload failed:', error);
    onStatusChange('error');
    return {
      success: false,
      audioFileId,
      canDelete: false,
      error: error.message
    };
  }
};

/**
 * Mobile-specific file upload using TUS protocol for resumable uploads
 * Supports large files (4-5+ hours of recording) with:
 * - Chunked uploads (5MB chunks)
 * - Resume capability if interrupted
 * - No full file memory loading
 *
 * @param {string} filePath - File path
 * @param {string} apiUrl - API URL
 * @param {string} authToken - Auth token
 * @param {Object} metadata - Metadata
 * @param {Function} onProgress - Progress callback
 * @param {string|null} recordId - Record ID for tracking cancellation
 * @returns {Promise<{success: boolean, audioFileId?: string, error?: string}>}
 */
const uploadFileMobile = async (filePath, apiUrl, authToken, metadata, onProgress, recordId = null) => {
  try {
    // Import TUS client dynamically
    const { Upload } = await import('tus-js-client');

    // Read file for upload - for very large files, consider streaming
    // Note: Capacitor Filesystem reads as base64, which we convert to ArrayBuffer
    const fileResult = await readFile(filePath);
    if (!fileResult.success) {
      throw new Error(fileResult.error || 'Failed to read file for upload');
    }

    const fileBlob = new Blob([fileResult.data], { type: 'audio/m4a' });
    const fileSize = fileBlob.size;

    // Calculate appropriate chunk size based on file size
    // Smaller chunks for large files to handle memory better
    const getChunkSize = (size) => {
      if (size > 500 * 1024 * 1024) return 2 * 1024 * 1024;  // >500MB: 2MB chunks
      if (size > 100 * 1024 * 1024) return 5 * 1024 * 1024;  // >100MB: 5MB chunks
      return 10 * 1024 * 1024; // Default: 10MB chunks
    };

    return new Promise((resolve, reject) => {
      const upload = new Upload(fileBlob, {
        endpoint: `${apiUrl}/api/desktop/upload/tus`,
        retryDelays: [0, 1000, 3000, 5000, 10000, 30000], // Retry delays in ms
        chunkSize: getChunkSize(fileSize),
        metadata: {
          filename: 'recording.m4a',
          filetype: 'audio/m4a',
          ...metadata,
          recordMetadata: JSON.stringify(metadata)
        },
        headers: {
          'Authorization': `Bearer ${authToken}`
        },
        onError: (error) => {
          console.error('TUS upload error:', error);
          // Check if we can fall back to simple upload for smaller files
          if (fileSize < 50 * 1024 * 1024) {
            console.log('Falling back to simple upload for small file');
            uploadFileMobileSimple(filePath, apiUrl, authToken, metadata, onProgress, null, recordId)
              .then(resolve)
              .catch(reject);
          } else {
            reject(new Error(error.message || 'Upload failed'));
          }
        },
        onProgress: (bytesUploaded, bytesTotal) => {
          const percentage = Math.round((bytesUploaded / bytesTotal) * 100);
          onProgress(percentage);
        },
        onSuccess: () => {
          // Extract audioFileId from the upload URL
          const uploadUrl = upload.url;
          const audioFileId = uploadUrl ? uploadUrl.split('/').pop() : null;
          resolve({
            success: true,
            audioFileId
          });
        }
      });

      // Check if there's a previous upload to resume
      upload.findPreviousUploads().then((previousUploads) => {
        if (previousUploads.length > 0) {
          console.log('Resuming previous upload');
          upload.resumeFromPreviousUpload(previousUploads[0]);
        }
        upload.start();
      }).catch(() => {
        // If fingerprinting fails, just start fresh
        upload.start();
      });
    });
  } catch (error) {
    console.error('TUS upload initialization failed:', error);
    // Fall back to simple upload if TUS fails to initialize
    return uploadFileMobileSimple(filePath, apiUrl, authToken, metadata, onProgress, null, recordId);
  }
};

/**
 * Simple mobile upload fallback (non-resumable)
 * Used as fallback when TUS is not available or for small files
 * Handles both filePath (Capacitor) and File object (file picker)
 *
 * @param {string|null} filePath - File path for Capacitor filesystem
 * @param {string} apiUrl - API base URL
 * @param {string} authToken - Auth token
 * @param {Object} metadata - Upload metadata
 * @param {Function} onProgress - Progress callback
 * @param {File|null} fileObj - Direct File object (optional)
 * @param {string|null} recordId - Record ID for tracking cancellation
 * @returns {Promise<{success: boolean, audioFileId?: string, error?: string, status?: number}>}
 */
const uploadFileMobileSimple = async (filePath, apiUrl, authToken, metadata, onProgress, fileObj = null, recordId = null) => {
  try {
    let fileBlob;

    if (fileObj) {
      // Use the File object directly (from file picker)
      fileBlob = fileObj;
    } else if (filePath) {
      // Read from Capacitor filesystem
      const fileResult = await readFile(filePath);
      if (!fileResult.success) {
        throw new Error(fileResult.error || 'Failed to read file for upload');
      }
      fileBlob = new Blob([fileResult.data], { type: 'audio/m4a' });
    } else {
      throw new Error('No file provided for upload');
    }

    const formData = new FormData();
    formData.append('audio', fileBlob, fileObj?.name || 'recording.m4a');
    formData.append('metadata', JSON.stringify(metadata));

    // Calculate timeout based on file size (1 minute per 10MB, minimum 10 minutes)
    const fileSizeMB = fileBlob.size / (1024 * 1024);
    const timeoutMinutes = Math.max(10, Math.ceil(fileSizeMB / 10));
    const timeoutMs = timeoutMinutes * 60 * 1000;

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      // Store XHR reference for cancellation
      if (recordId) {
        activeXhrUploads.set(recordId, xhr);
      }

      const cleanup = () => {
        if (recordId) {
          activeXhrUploads.delete(recordId);
        }
      };

      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          const progress = Math.round((event.loaded / event.total) * 100);
          onProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        cleanup();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText);
            resolve({
              success: true,
              audioFileId: response.audioFileId || response.id
            });
          } catch (e) {
            resolve({ success: true, audioFileId: null });
          }
        } else if (xhr.status === 401) {
          // Token expired - signal for retry with refresh
          let errorMsg = 'Token expired';
          try {
            const errData = JSON.parse(xhr.responseText);
            errorMsg = errData.error || errData.message || 'Token expired';
          } catch (e) { /* ignore parse errors */ }
          resolve({ success: false, error: errorMsg, status: 401 });
        } else {
          let errorMsg = `Upload failed with status ${xhr.status}`;
          try {
            const errData = JSON.parse(xhr.responseText);
            errorMsg = errData.error || errData.message || errorMsg;
          } catch (e) { /* ignore parse errors */ }
          reject(new Error(errorMsg));
        }
      });

      xhr.addEventListener('error', () => {
        cleanup();
        reject(new Error('Network error during upload'));
      });

      xhr.addEventListener('timeout', () => {
        cleanup();
        reject(new Error('Upload timeout - file may be too large. Try with a better connection.'));
      });

      xhr.addEventListener('abort', () => {
        cleanup();
        resolve({ success: false, error: 'Upload cancelled', cancelled: true });
      });

      xhr.open('POST', `${apiUrl}/api/desktop/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
      xhr.timeout = timeoutMs;
      xhr.send(formData);
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
};

/**
 * Upload with automatic retry and exponential backoff
 * @param {Object} options - Same options as uploadWithVerification
 * @returns {Promise<{success: boolean, audioFileId?: string, canDelete: boolean, error?: string}>}
 */
export const uploadWithRetry = async (options) => {
  const maxRetries = PlatformConstants.MAX_UPLOAD_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await uploadWithVerification(options);

    if (result.success) {
      return result;
    }

    // Check if error is retryable
    const retryable = isRetryableError(result.error);
    if (!retryable || attempt >= maxRetries) {
      return result;
    }

    const delay = getBackoffDelay(attempt);
    console.log(`Upload attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
    await sleep(delay);
  }

  return {
    success: false,
    canDelete: false,
    error: 'Max retries exceeded'
  };
};

/**
 * Check if an error is retryable
 * @param {string} error - Error message
 * @returns {boolean}
 */
const isRetryableError = (error) => {
  if (!error) return false;

  const nonRetryable = [
    'Checksum mismatch',
    'Invalid file format',
    'Unauthorized',
    'Forbidden'
  ];

  return !nonRetryable.some(msg => error.includes(msg));
};

/**
 * Safe file deletion after successful upload
 * Only deletes if file is not locked and upload was verified
 * @param {string} filePath - File path
 * @param {string} recordId - Recording ID
 * @param {Object} recordingStore - Recording store instance for lock checking
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export const safeDeleteAfterUpload = async (filePath, recordId, recordingStore) => {
  // Check if file is locked
  if (recordingStore && !recordingStore.canDelete(recordId)) {
    console.warn('Cannot delete file - still locked for upload');
    return { success: false, error: 'File is locked' };
  }

  try {
    if (isElectron()) {
      return await window.electronAPI.file.delete(filePath);
    } else if (isCapacitor()) {
      return await deleteFile(filePath);
    }

    return { success: false, error: 'Unsupported platform' };
  } catch (error) {
    console.error('Error deleting file:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Add upload to queue for background processing
 * @param {Object} uploadOptions - Upload options
 */
export const queueUpload = (uploadOptions) => {
  uploadQueue.push({
    ...uploadOptions,
    id: uploadOptions.recordId,
    addedAt: Date.now(),
    attempts: 0,
    status: 'pending'
  });

  // Start processing queue if not already running
  if (!isProcessingQueue) {
    processUploadQueue();
  }
};

/**
 * Process upload queue in background
 */
const processUploadQueue = async () => {
  if (isProcessingQueue || uploadQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (uploadQueue.length > 0) {
    const upload = uploadQueue.find(u => u.status === 'pending');
    if (!upload) break;

    upload.status = 'uploading';
    upload.attempts++;

    const result = await uploadWithVerification(upload);

    if (result.success) {
      upload.status = 'complete';
      upload.audioFileId = result.audioFileId;
      // Remove from queue
      const index = uploadQueue.indexOf(upload);
      if (index > -1) {
        uploadQueue.splice(index, 1);
      }
    } else {
      if (upload.attempts >= PlatformConstants.MAX_UPLOAD_RETRIES) {
        upload.status = 'failed';
        upload.error = result.error;
      } else {
        upload.status = 'pending';
        // Wait before retrying
        await sleep(getBackoffDelay(upload.attempts - 1));
      }
    }
  }

  isProcessingQueue = false;
};

/**
 * Get upload queue status
 * @returns {Array} Queue items with status
 */
export const getUploadQueueStatus = () => {
  return uploadQueue.map(item => ({
    id: item.id,
    status: item.status,
    attempts: item.attempts,
    addedAt: item.addedAt,
    error: item.error
  }));
};

/**
 * Clear completed or failed uploads from queue
 */
export const clearCompletedUploads = () => {
  const remaining = uploadQueue.filter(u => u.status === 'pending' || u.status === 'uploading');
  uploadQueue.length = 0;
  uploadQueue.push(...remaining);
};
