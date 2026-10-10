// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { uploadErrorKey } from '../../src/utils/uploadErrors';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

describe('upload failure -> translated text', () => {
  it.each([
    ['Insufficient minutes', 'insufficientMinutesUpload'],
    ['Upload failed with status 402', 'insufficientMinutesUpload'],
    ['Request failed with status code 413', 'uploadTooLarge'],
    ['Payload Too Large', 'uploadTooLarge'],
    ['Request timed out after 30s (network error)', 'uploadFailedNoInternet'],
    ['getaddrinfo ENOTFOUND app.suisse-meets.ch', 'uploadFailedNoInternet'],
    ['Upload failed with status 502', 'uploadFailedServer'],
    ['', 'uploadFailedServer']
  ])('%j -> %s', (raw, key) => {
    expect(uploadErrorKey(raw)).toBe(key);
  });

  it('offline wins over a server-looking message', () => {
    expect(uploadErrorKey('Upload failed with status 500', { online: false })).toBe('uploadFailedNoInternet');
  });

  it.each(SUPPORTED_LOCALES)('every text exists in %s', (locale) => {
    const messages = i18n.global.getLocaleMessage(locale);
    for (const key of ['insufficientMinutesUpload', 'uploadTooLarge', 'uploadFailedNoInternet', 'uploadFailedServer',
      'fileUploadFailed', 'uploadCancelFailed', 'unsupportedFileFormat', 'fileReadFailed', 'uploadFailed', 'retryUpload', 'viewHistory']) {
      expect(typeof messages[key], `${locale}.${key}`).toBe('string');
    }
  });

  it('the Record and Upload pages no longer show English-only labels or raw errors in their error cards', () => {
    for (const file of ['src/pages/RecordPage.vue', 'src/pages/UploadPage.vue']) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/>Upload Failed</);
      expect(source).not.toMatch(/label="Retry Upload"/);
      expect(source).not.toMatch(/\{\{ uploadError \}\}/);
    }
    const upload = fs.readFileSync('src/pages/UploadPage.vue', 'utf8');
    expect(upload).not.toMatch(/message: 'Unsupported file format'/);
    expect(upload).not.toMatch(/message: 'Could not get file path'/);
  });
});
