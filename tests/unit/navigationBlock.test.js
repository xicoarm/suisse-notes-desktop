// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { blockedNavigationTarget, createBlockedNotice } from '../../src/utils/navigationBlock';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

describe('navigation during a recording or upload', () => {
  it('keeps the user on Record/Upload while blocking, and nowhere else', () => {
    expect(blockedNavigationTarget({ name: 'history' }, { name: 'record' }, true)).toBe('record');
    expect(blockedNavigationTarget({ name: 'record' }, { name: 'record' }, true)).toBeNull();
    expect(blockedNavigationTarget({ name: 'about' }, { name: 'upload' }, true)).toBe('upload');
    expect(blockedNavigationTarget({ name: 'upload' }, { name: 'history' }, true)).toBe('record');
    expect(blockedNavigationTarget({ name: 'history' }, { name: 'record' }, false)).toBeNull();
    expect(blockedNavigationTarget({ name: 'settings' }, { name: 'history' }, true)).toBeNull();
  });

  it('says why at most once per interval', () => {
    let now = 0;
    const show = vi.fn();
    const notice = createBlockedNotice(show, { intervalMs: 3000, now: () => now });
    expect(notice()).toBe(true);
    now = 1000;
    expect(notice()).toBe(false);
    now = 3500;
    expect(notice()).toBe(true);
    expect(show).toHaveBeenCalledTimes(2);
    expect(createBlockedNotice(() => { throw new Error('no Notify'); })()).toBe(true);
  });

  it.each(SUPPORTED_LOCALES)('has the explanation in %s', (locale) => {
    expect(typeof i18n.global.getLocaleMessage(locale).navigationBlockedDuringRecording).toBe('string');
  });

  it('the router explains a refused navigation and the desktop menu keeps a tooltip', () => {
    const router = fs.readFileSync('src/router/index.js', 'utf8');
    expect(router).toMatch(/notifyNavigationBlocked\(\);\s*next\(\{ name: target \}\)/);
    const layout = fs.readFileSync('src/layouts/MainLayout.vue', 'utf8');
    expect(layout).toMatch(/<q-tooltip[\s\S]*?navigationBlockedDuringRecording/);
    expect(layout).not.toMatch(/:disabled="recordingStore\.isBlocking"/);
    expect(layout).not.toMatch(/nav-disabled \{[^}]*pointer-events: none/);
  });
});
