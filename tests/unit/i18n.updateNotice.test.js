import { afterEach, describe, expect, it } from 'vitest';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

const keysOf = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) =>
  item && typeof item === 'object' ? keysOf(item, `${prefix}${key}.`) : [`${prefix}${key}`]);

describe('update texts in every language', () => {
  const original = i18n.global.locale.value;
  afterEach(() => { i18n.global.locale.value = original; });

  it('ships the same message keys in all four languages', () => {
    const [reference, ...others] = SUPPORTED_LOCALES.map(locale => keysOf(i18n.global.messages.value[locale]).sort());
    for (const keys of others) expect(keys).toEqual(reference);
  });

  it('renders the download notice with version and progress, the percent never wrapping away', () => {
    for (const locale of SUPPORTED_LOCALES) {
      i18n.global.locale.value = locale;
      const title = i18n.global.t('updateDownloadingTitle');
      const message = i18n.global.t('updateDownloadingMessage', { version: '4.7.12', percent: 57 });
      expect(title).not.toBe('updateDownloadingTitle');
      expect(message).toContain('4.7.12');
      expect(message).toMatch(/57(\u00A0)?%/);
      expect(message).not.toMatch(/57 %/);
    }
  });
});
