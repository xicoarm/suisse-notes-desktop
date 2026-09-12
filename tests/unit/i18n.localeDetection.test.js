import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectInitialLocale, SUPPORTED_LOCALES } from '../../src/boot/i18n';

describe('detectInitialLocale', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  const withNavigator = (languages, language) => {
    Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
    Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  };

  it('honours an explicit saved choice', () => {
    withNavigator(['en-US'], 'en-US');
    localStorage.setItem('lang', 'it');
    expect(detectInitialLocale()).toBe('it');
  });

  it('uses the device language when it is one we ship (a store reviewer on an English phone gets English)', () => {
    withNavigator(['en-US', 'de-CH'], 'en-US');
    expect(detectInitialLocale()).toBe('en');
    withNavigator(['fr-CH'], 'fr-CH');
    expect(detectInitialLocale()).toBe('fr');
    withNavigator([], 'de-CH');
    expect(detectInitialLocale()).toBe('de');
  });

  it('falls back to German for languages we do not ship', () => {
    withNavigator(['pt-BR'], 'pt-BR');
    expect(detectInitialLocale()).toBe('de');
  });

  it('ignores an unsupported saved value', () => {
    withNavigator(['it-IT'], 'it-IT');
    localStorage.setItem('lang', 'xx');
    expect(detectInitialLocale()).toBe('it');
    expect(SUPPORTED_LOCALES).toEqual(['en', 'de', 'fr', 'it']);
  });
});
