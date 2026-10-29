// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { auditSource, axiosWithoutSignal } from './support/e7Audit';

// Review round 8, E7 audit as a static rule (tests/unit/support/e7Audit.js):
// a new await, catch or callback in main's background work without a ticket
// check fails here. Exceptions carry a `// E7: <reason>` marker on their line
// and are listed in the round-8 result table. Failed at 82ab3187.

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');

// Background work of main that is audited even without a `ticket` in its body.
const MAIN_BACKGROUND = ['refreshMainAuthToken', 'pollServerStatus', 'pollMeetingTranscriptionStatus', 'verifyAcceptedUpload',
  'uploadWithRetry', 'tryDirectUpload', 'uploadWithRetryLegacy', 'recoverOrphanedRecordings'];

describe('E7 static audit', () => {
  it('electron-main.js: every await, catch and callback of ticketed or background work checks the ticket', () => {
    const { findings, audited } = auditSource(read('src-electron/electron-main.js'), { functions: MAIN_BACKGROUND });
    for (const name of [...MAIN_BACKGROUND, 'upload:start', 'upload:startTUS', 'upload:cancel']) expect(audited, name).toContain(name);
    expect(findings).toEqual([]);
  });

  it('pending-uploads.js: the whole queue run', () => {
    expect(auditSource(read('src-electron/pending-uploads.js'), { all: true }).findings).toEqual([]);
  });

  it('upload-direct.js: every request carries the abort signal (aborted on every session change)', () => {
    expect(axiosWithoutSignal(read('src-electron/upload-direct.js'))).toEqual([]);
  });

  it('control: the rules find an unchecked await, catch, callback and refresh', () => {
    const src = `
      async function work(ticket) {
        await sleep(1);
        writeFileAtomic('x');
        try { await axios.get('u'); if (sessionEndedFor(ticket)) return; } catch (e) { saveUploadOutcome('r', e); }
        later(() => removeFromUploadQueue('r'));
        await refreshMainAuthToken();
        if (sessionEndedFor(ticket)) return;
        await sleep(2); // E7: test marker
        await sleep(3);
        if (sessionEndedFor(ticket)) return null;
        return await sleep(4);
      }`;
    const rules = auditSource(src).findings.map((f) => f.rule[0]).sort();
    expect(rules).toEqual(['A', 'B', 'C', 'D']);
    expect(axiosWithoutSignal('axios.post(u, b, { timeout: 1 }); axios.get(u, { signal });')).toHaveLength(1);
  });
});
