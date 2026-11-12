// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';
import { buildMeetingReportUrl, buildReportAiContentUrl, withReportAiFlag } from '../../src/utils/reportAiContent';

const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

describe('report AI content URLs', () => {
  it('builds the general report form URL, optionally for one recording', () => {
    expect(buildReportAiContentUrl()).toBe('https://app.suisse-meets.ch/report-ai-content');
    expect(buildReportAiContentUrl('abc 1')).toBe('https://app.suisse-meets.ch/report-ai-content?audioFileId=abc%201');
  });

  it('builds the meeting URL that opens the report dialog', () => {
    expect(buildMeetingReportUrl('f1')).toBe('https://app.suisse-meets.ch/meeting/audio/f1?reportAi=1');
    expect(buildMeetingReportUrl('')).toBe('');
  });

  it('keeps an existing session token when adding the flag', () => {
    const url = withReportAiFlag('https://app.suisse-meets.ch/meeting/audio/f1?session=tok%2B1');
    expect(new URL(url).searchParams.get('session')).toBe('tok+1');
    expect(new URL(url).searchParams.get('reportAi')).toBe('1');
    expect(withReportAiFlag('')).toBe('');
  });

  it('stays inside the main-process external-URL allow-list', () => {
    const main = read('src-electron/electron-main.js');
    expect(main).toContain("'app.suisse-meets.ch'");
    for (const url of [buildReportAiContentUrl(), buildMeetingReportUrl('f1')]) {
      expect(new URL(url).protocol).toBe('https:');
      expect(new URL(url).hostname).toBe('app.suisse-meets.ch');
    }
  });
});

describe('report AI content labels and wiring', () => {
  it('has the labels in every shipped language', () => {
    const expected = { en: 'Report AI content', de: 'KI-Inhalt melden', fr: 'Signaler un contenu IA', it: 'Segnala contenuto IA' };
    for (const locale of SUPPORTED_LOCALES) {
      const m = i18n.global.getLocaleMessage(locale);
      expect(m.reportAiContent).toBe(expected[locale]);
      expect(m.aboutReportAiContent).toBeTruthy();
      expect(m.aboutReportAiContentHint).toBeTruthy();
    }
  });

  it('adds the entry to the About page and to uploaded history cards', () => {
    const about = read('src/pages/AboutPage.vue');
    expect(about).toContain("$t('aboutReportAiContent')");
    expect(about).toContain('buildReportAiContentUrl()');
    const card = read('src/components/RecordingHistoryCard.vue');
    expect(card).toMatch(/v-if="isUploaded && !linkLoading"[\s\S]{0,200}icon="flag"/);
    expect(card).toContain("openInBrowser(props.recording.audioFileId, { reportAi: true })");
    expect(read('src/composables/useShareLink.js')).toContain('withReportAiFlag(url)');
  });
});
