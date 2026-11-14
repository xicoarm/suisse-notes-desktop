import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { i18n, SUPPORTED_LOCALES } from '../../src/boot/i18n';

// Desktop: a stalled live mix whose recording is still being saved from its
// separate sources. The stall banner used to tell the user to stop and save
// within a minute, which is the one action that loses the rest of the meeting.
// In that state the banner now shows a calm notice without that advice.
//
// Like the other Record page checks, these compile the real declarations and
// read the real template instead of mounting the page.
const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const composable = read('src/composables/useRecorder.js');
const page = read('src/pages/RecordPage.vue');

function declaration(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  if (first < 0 || last < first) throw new Error(`Missing declaration: ${start}`);
  return source.slice(first, last);
}

describe('stall banner while the recording is still being saved', () => {
  it('mirrors the service state: on when the sources save, off when they stop or the episode ends', () => {
    const source = declaration(composable, 'const handleCaptureStallLanes =', 'const handleCaptureRecovered =');
    const saving = { value: false };
    const handler = new Function('captureStalledSaving', source + '\nreturn handleCaptureStallLanes;')(saving);
    handler({ lanesSaving: true });
    expect(saving.value).toBe(true);
    handler({ lanesSaving: false });
    expect(saving.value).toBe(false);
    handler({ lanesSaving: true });
    handler(undefined); // anything but an explicit "saving" brings the warning back
    expect(saving.value).toBe(false);
  });

  it('listens for the state with the other stall events, starts every recording without it, and hands it to the page', () => {
    expect(composable).toContain("recordingService.addEventListener('captureStallLanes', handleCaptureStallLanes);");
    expect(composable).toContain("recordingService.removeEventListener('captureStallLanes', handleCaptureStallLanes);");
    expect(composable).toMatch(/captureStalled\.value = null;\n\s+captureStalledSaving\.value = false;\n\s+captureRecoveredInfo\.value = null;/);
    expect(composable).toMatch(/\n\s+captureStalled,\n\s+captureStalledSaving,\n\s+captureRecoveredInfo,/);
    expect(page).toMatch(/\n\s+captureStalled,\n\s+captureStalledSaving,\n/);
  });

  it('shows the calm notice instead of the warning, and no "recover now" button beside it', () => {
    const banner = declaration(page, '<!-- Capture-stall watchdog', '<!-- Error Display -->');
    expect(banner).toContain('v-if="captureStalled"'); // still one banner, shown by the watchdog
    expect(banner).toMatch(/captureStalledSaving\s*\?\s*\$t\('captureStalledSavingNotice'\)\s*:\s*\$t\('captureStalledWarning'/);
    expect(banner).toMatch(/<template\s+v-if="!captureStalledSaving"\s+#action\s*>/);
    expect(banner).toContain(":name=\"captureStalledSaving ? 'info_outline' : 'warning'\"");
  });

  it('has the notice in every shipped language, without any advice to stop', () => {
    const stopAdvice = /\bstop|stopp|beenden|abbrechen|arrêt|interromp|arresta/i;
    for (const locale of SUPPORTED_LOCALES) {
      const messages = i18n.global.getLocaleMessage(locale);
      expect(messages.captureStalledSavingNotice, locale).toEqual(expect.any(String));
      expect(messages.captureStalledSavingNotice, locale).not.toMatch(stopAdvice);
      expect(messages.captureStalledSavingNotice, locale).not.toBe(messages.captureStalledWarning);
      // The check itself must be able to see the advice: the warning has it.
      expect(messages.captureStalledWarning, locale).toMatch(stopAdvice);
    }
    expect(new Set(SUPPORTED_LOCALES.map(locale => i18n.global.getLocaleMessage(locale).captureStalledSavingNotice)).size)
      .toBe(SUPPORTED_LOCALES.length);
  });

  it('says in German that the recording continues, is saved and needs nothing, in formal address and Swiss spelling', () => {
    const text = i18n.global.getLocaleMessage('de').captureStalledSavingNotice;
    expect(text).toContain('Die Aufnahme läuft weiter und wird gespeichert.');
    expect(text).toContain('Sie müssen nichts tun.');
    expect(text).toContain('Die angezeigte Zeit kann stehen bleiben.');
    expect(text).not.toContain('ß');
  });
});
