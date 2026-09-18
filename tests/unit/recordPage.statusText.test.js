import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

// The status line under "Meeting-Rekorder" was hard-coded English, so a German
// user saw "Recording in progress" while recording (visible in the Microsoft
// Store screenshots). Every phase must come from the translations instead.
const page = fs.readFileSync('src/pages/RecordPage.vue', 'utf8');
const block = page.slice(page.indexOf('const statusText = computed('), page.indexOf('const statusClass = computed('));
const keys = [...new Set([...block.matchAll(/\bt\('([A-Za-z]+)'/g)].map(match => match[1]))];

describe('Record page status line', () => {
  it('returns no hard-coded English text', () => {
    expect(block).not.toMatch(/return\s+['`][A-Z]/);
    expect(block).not.toMatch(/\?\s*`[A-Z]/);
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  it('has every status text in every shipped language', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale);
      for (const key of keys) {
        expect(messages[key], `${locale}.${key}`).toEqual(expect.any(String));
      }
    }
  });

  it('shows the recording phase in German as German', () => {
    const messages = i18n.global.getLocaleMessage('de');
    expect(messages.recordingInProgress).toBe('Aufnahme läuft');
    expect(messages.recordingUploadRetry).toContain('{attempt}');
  });
});
