import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createPinia, setActivePinia } from 'pinia';

vi.mock('uuid', () => ({ v4: () => 'test-uuid' }));
vi.stubGlobal('window', { electronAPI: { recording: {} } });
import { useRecordingStore } from '../../src/stores/recording';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

// The Record page renders one top-level view per phase. A phase without one
// shows only the mode tabs on an empty page: after stop, 4.7.0 finalization
// held such a phase for 73 s on a 62-minute recording.
const pageSource = fs.readFileSync('src/pages/RecordPage.vue', 'utf8').replace(/\r\n/g, '\n');
const template = pageSource.slice(0, pageSource.indexOf('<script'));
const VIEWS = ['idle-layout', 'recording-starting-card', 'recording-card', 'error-card', 'recording-pipeline-overlay', 'upload-success-card'];

function viewCondition(className) {
  return new RegExp(`v-if="([^"]+)"\\s+class="${className}[" ]`).exec(template)?.[1] ?? null;
}

// Compile the page's own computed declarations with the real store getters.
function pageState(store) {
  const start = pageSource.indexOf('const isFromFileUpload = computed');
  const end = pageSource.indexOf('const uploadIcon = computed', start);
  if (start < 0 || end < start) throw new Error('Missing Record page view state declarations');
  const computed = read => ({ get value() { return read(); } });
  return new Function('computed', 'recordingStore', 'isProcessing', 'isAutoUploading',
    `${pageSource.slice(start, end)}\nreturn { isUploadedFromRecording, showUploadSection, isRecordingActive };`)(
    computed, store, computed(() => store.isProcessing), computed(() => store.isUploading));
}

function renderedViews(store) {
  const page = pageState(store);
  const scope = { recordingStore: store, isUploadedFromRecording: page.isUploadedFromRecording.value, showUploadSection: page.showUploadSection.value };
  return VIEWS.filter(view => viewCondition(view) !== null &&
    new Function('scope', `with (scope) { return (${viewCondition(view)}); }`)(scope));
}

// Every phase literal the store or the page assigns.
function assignedPhases() {
  const phases = new Set();
  for (const file of ['src/stores/recording.js', 'src/pages/RecordPage.vue']) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!/\.phase\s*=(?!=)/.test(line)) continue;
      for (const match of line.matchAll(/'([a-z]+)'/g)) phases.add(match[1]);
    }
  }
  return [...phases];
}

// Reached only when a stop outside the Record page's upload flow (emergency
// stop, safety net) has saved the recording; finalization itself runs in
// 'processing'.
const OUTSIDE_PAGE_FLOW = new Set(['stopped']);

describe('Record page views per recording phase', () => {
  let store;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = useRecordingStore();
    store.recordId = 'rec-1';
  });

  it('finds every top-level view with its render condition', () => {
    expect(VIEWS.filter(view => viewCondition(view) === null)).toEqual([]);
  });

  it('finds the phases the store and page assign', () => {
    expect(assignedPhases()).toEqual(expect.arrayContaining(['idle', 'preparing', 'recording', 'paused', 'processing', 'uploading', 'uploaded', 'error']));
  });

  it.each(assignedPhases().filter(phase => !OUTSIDE_PAGE_FLOW.has(phase)))('renders a view in phase %s', phase => {
    for (const uploadError of [null, 'Upload failed']) {
      store.phase = phase;
      store.uploadError = uploadError;
      expect(renderedViews(store), `phase ${phase}, uploadError ${uploadError}`).not.toEqual([]);
    }
  });

  it.each(['preparing', 'recording', 'paused', 'processing', 'uploading'])('hides the mode tabs in phase %s', phase => {
    store.phase = phase;
    expect(pageState(store).isRecordingActive.value).toBe(true);
  });

  it('shows the processing screen, not an empty page, while finalization runs after stop', () => {
    store.phase = 'processing';
    expect(renderedViews(store)).toEqual(['recording-pipeline-overlay']);
    expect(template).toMatch(/v-if="isProcessing"\s+class="upload-content"/);
  });

  it.each(SUPPORTED_LOCALES)('translates the pipeline texts in %s', locale => {
    const messages = i18n.global.getLocaleMessage(locale);
    for (const key of ['startingRecording', 'pipelinePreparingTitle', 'pipelinePreparingMessage', 'pipelinePreparingHint',
      'pipelineUploadingTitle', 'uploadFailed', 'uploadComplete']) {
      expect(typeof messages[key] === 'string' && messages[key].trim(), `${locale}.${key}`).toBeTruthy();
    }
  });
});
