// @vitest-environment node
// History "Restore and upload" (ELECTRON-7R): the real card handlers, compiled
// with narrow dependencies (the approach of loginPage.twoFactorStep.test.js).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

const SOURCE = fs.readFileSync('src/components/RecordingHistoryCard.vue', 'utf8').replace(/\r\n/g, '\n');

function card(recording, { checkForChunks, restoreRetained } = {}) {
  const first = SOURCE.indexOf('    // A failed recording without an audio file may still have its originals');
  const last = SOURCE.indexOf('    // A known server ID enables the online actions.', first);
  if (first < 0 || last < first) throw new Error('Missing restore block');
  globalThis.window = { electronAPI: { recording: {
    checkForChunks: vi.fn(checkForChunks || (async () => ({ hasChunks: true }))),
    restoreRetained: vi.fn(restoreRetained || (async () => ({ success: true, queued: true }))),
  } } };
  const deps = {
    ref: value => ({ value }), watch: vi.fn(), props: { recording }, isDesktop: true,
    t: key => key, $q: { notify: vi.fn() }, captureMessage: vi.fn(),
    historyStore: { loadRecordings: vi.fn(async () => {}) },
  };
  const api = new Function(...Object.keys(deps), SOURCE.slice(first, last) + `
    return { retainedAudio, restoring, checkRetainedAudio, onRestore };`)(...Object.values(deps));
  return { ...api, deps, electron: globalThis.window.electronAPI.recording };
}
const failed = { id: 'rec-1', userId: 'owner-1', uploadStatus: 'failed', filePath: null, source: 'app' };
afterEach(() => { delete globalThis.window; });

describe('history card: restore and upload a recording whose saving failed', () => {
  it('offers the action only for a failed entry without a file whose originals are kept', async () => {
    let c = card(failed);
    await c.checkRetainedAudio();
    expect(c.electron.checkForChunks).toHaveBeenCalledWith('rec-1', '.webm');
    expect(c.retainedAudio.value).toBe(true);
    c = card(failed, { checkForChunks: async () => ({ hasChunks: false }) });
    await c.checkRetainedAudio();
    expect(c.retainedAudio.value).toBe(false);
    c = card(failed, { checkForChunks: async () => { throw new Error('ipc'); } });
    await c.checkRetainedAudio();
    expect(c.retainedAudio.value).toBe(false);
    for (const other of [{ ...failed, filePath: '/x/audio.webm' }, { ...failed, source: 'device' }, { ...failed, uploadStatus: 'uploaded' }]) {
      c = card(other);
      await c.checkRetainedAudio();
      expect(c.retainedAudio.value).toBe(false);
      expect(c.electron.checkForChunks).not.toHaveBeenCalled();
    }
    // Before the file picker, and the picker remains for entries without originals.
    const restore = SOURCE.indexOf('data-test="restore-and-upload"'), picker = SOURCE.indexOf('icon="upload_file"');
    expect(restore).toBeGreaterThan(0);
    expect(restore).toBeLessThan(picker);
    expect(SOURCE.slice(SOURCE.lastIndexOf('<q-btn', restore), restore)).toMatch(/uploadStatus === 'failed' && !recording\.filePath && recording\.source !== 'device' && retainedAudio/);
  });

  it('asks main to restore by recording id only, confirms, and refreshes the history', async () => {
    const c = card(failed);
    await c.onRestore();
    // No identity from the renderer: main checks the signed-in owner itself.
    expect(c.electron.restoreRetained).toHaveBeenCalledWith('rec-1');
    expect(c.deps.$q.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'positive', message: 'restoreAndUploadStarted' }));
    expect(c.deps.historyStore.loadRecordings).toHaveBeenCalled();
    expect(c.restoring.value).toBe(false);
  });

  it('shows the reason when restoring fails and keeps the action', async () => {
    const reason = 'Native source x sample-order replay failed; original native audio is retained';
    let c = card(failed, { restoreRetained: async () => ({ success: false, error: reason }) });
    await c.onRestore();
    expect(c.deps.$q.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative', message: 'restoreAndUploadFailed', caption: reason }));
    expect(c.deps.captureMessage).toHaveBeenCalled();
    for (const [code, message] of [['BUSY', 'restoreAndUploadBusy'], ['NOT_OWNER', 'restoreAndUploadOtherAccount'],
      ['SIGNED_OUT', 'restoreAndUploadSignIn'], ['OWNER_UNKNOWN', 'restoreAndUploadOwnerUnknown']]) {
      c = card(failed, { restoreRetained: async () => ({ success: false, code, error: 'technical' }) });
      await c.onRestore();
      expect(c.deps.$q.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'negative', message, caption: undefined }));
    }
    c = card(failed, { restoreRetained: async () => { throw new Error('Restore recording timed out'); } });
    await c.onRestore();
    expect(c.deps.$q.notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'restoreAndUploadFailed', caption: 'Restore recording timed out' }));
    expect(c.restoring.value).toBe(false);
  });

  it('points the recovery warning at the action in every language, never at support', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'de', 'fr', 'it']);
    for (const language of SUPPORTED_LOCALES) {
      const text = i18n.global.getLocaleMessage(language);
      for (const key of ['restoreAndUpload', 'restoreAndUploadTooltip', 'restoreAndUploadStarted', 'restoreAndUploadFailed', 'restoreAndUploadBusy',
        'restoreAndUploadOtherAccount', 'restoreAndUploadSignIn', 'restoreAndUploadOwnerUnknown', 'recoveredUploadHeldOtherAccount', 'recoveredUploadHeldOwnerUnknown']) {
        expect(typeof text[key], `${language}.${key}`).toBe('string');
      }
      expect(text.recordingRecoveryFailedWarning).toContain(text.restoreAndUpload);
      expect(text.recordingRecoveryFailedWarning).not.toMatch(/support/i);
    }
  });
});
