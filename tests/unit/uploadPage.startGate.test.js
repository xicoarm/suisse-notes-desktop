// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

// The real upload-start handler of the Upload page, compiled with narrow
// dependencies (the approach of recordPage.startGate.test.js).
function uploadStart({ knownOutOfMinutes = false, balanceKnown = true } = {}) {
  const source = fs.readFileSync('src/pages/UploadPage.vue', 'utf8').replace(/\r\n/g, '\n');
  const first = source.indexOf('const startUploadBusy = ref(false);');
  const last = source.indexOf('const startUpload = async', first);
  if (first < 0 || last < first) throw new Error('Missing upload start handler');
  let answer;
  const deps = {
    ref: value => ({ value }),
    hasSelectedFile: { value: true },
    selectedFile: { value: null },
    currentFilePath: { value: 'C:/talk.m4a' },
    currentRecordId: { value: 'file_1' },
    currentFileSize: { value: 10 },
    currentFilename: { value: 'talk.m4a' },
    currentDuration: { value: 60 },
    prepStore: { uploadingCount: 0 },
    $q: { notify: vi.fn() },
    t: key => key,
    minutesStore: {
      syncWithServer: vi.fn(() => new Promise((resolve) => { answer = resolve; })),
      knownOutOfMinutes, balanceKnown, remainingMinutes: 100
    },
    authStore: { token: 'tok' },
    isCapacitor: () => false,
    contactSalesReason: { value: null },
    showContactSalesDialog: { value: false },
    startMobileUpload: vi.fn(async () => {}),
    startUpload: vi.fn(async () => {})
  };
  const compiled = new Function(...Object.keys(deps),
    source.slice(first, last) + '\nreturn { start: confirmAndStartUpload, unmount: () => { pageUnmounted = true; } };')(
    ...Object.values(deps));
  return { ...compiled, deps, answer: () => answer() };
}

describe('upload start waits for the minutes balance, then re-checks the page', () => {
  it('starts the upload when nothing changed', async () => {
    const u = uploadStart();
    const run = u.start();
    u.answer();
    await run;
    expect(u.deps.startUpload).toHaveBeenCalledTimes(1);
  });

  it('does not start when the page was left during the wait', async () => {
    const u = uploadStart();
    const run = u.start();
    u.unmount();
    u.answer();
    await run;
    expect(u.deps.startUpload).not.toHaveBeenCalled();
  });

  it('does not start when the file was cleared or changed during the wait', async () => {
    const cleared = uploadStart();
    const runCleared = cleared.start();
    cleared.deps.hasSelectedFile.value = false;
    cleared.answer();
    await runCleared;
    expect(cleared.deps.startUpload).not.toHaveBeenCalled();

    const changed = uploadStart();
    const runChanged = changed.start();
    changed.deps.currentFilePath.value = 'C:/other.m4a';
    changed.deps.currentRecordId.value = 'file_2';
    changed.answer();
    await runChanged;
    expect(changed.deps.startUpload).not.toHaveBeenCalled();
  });

  it('ignores a second click while the first start is pending', async () => {
    const u = uploadStart();
    const first = u.start();
    const second = u.start();
    u.answer();
    await Promise.all([first, second]);
    expect(u.deps.minutesStore.syncWithServer).toHaveBeenCalledTimes(1);
    expect(u.deps.startUpload).toHaveBeenCalledTimes(1);
  });

  it('refuses only a server-confirmed empty balance', async () => {
    const u = uploadStart({ knownOutOfMinutes: true });
    const run = u.start();
    u.answer();
    await run;
    expect(u.deps.startUpload).not.toHaveBeenCalled();
    expect(u.deps.showContactSalesDialog.value).toBe(true);
  });
});
