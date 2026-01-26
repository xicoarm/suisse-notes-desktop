/**
 * Cross-platform file picker service
 * Provides unified file selection across Electron (desktop) and Capacitor (mobile)
 */
import { isElectron, isCapacitor } from '../utils/platform';

const AUDIO_VIDEO_EXTENSIONS = ['mp3', 'mp4', 'wav', 'm4a', 'webm', 'ogg', 'flac', 'aac', 'mov', 'm4v', 'mpeg', 'mpga', 'opus', 'oga', 'wma', 'amr', '3gp', 'avi', 'mkv'];

/**
 * Pick an audio/video file using the platform-appropriate file picker
 * @returns {Promise<{success: boolean, filePath?: string, fileSize?: number, filename?: string, mimeType?: string, file?: File, cancelled?: boolean, error?: string}>}
 */
export const pickAudioFile = async () => {
  if (isElectron()) {
    const result = await window.electronAPI.dialog.openFile({
      filters: [{
        name: 'Audio/Video Files',
        extensions: AUDIO_VIDEO_EXTENSIONS
      }]
    });
    return result;
  }

  if (isCapacitor()) {
    // Use HTML5 file input (works on all mobile browsers and Capacitor WebView)
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*,video/*';

      input.onchange = async (e) => {
        const file = e.target.files?.[0];
        if (file) {
          // Read file as blob for upload
          resolve({
            success: true,
            filePath: URL.createObjectURL(file),
            fileSize: file.size,
            filename: file.name,
            mimeType: file.type,
            file: file // Pass the actual file object for upload
          });
        } else {
          resolve({ success: false, cancelled: true });
        }
      };

      input.oncancel = () => {
        resolve({ success: false, cancelled: true });
      };

      input.click();
    });
  }

  return { success: false, error: 'Unsupported platform' };
};

export default {
  pickAudioFile
};
