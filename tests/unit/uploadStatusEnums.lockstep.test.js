/**
 * The two-phase upload verification polls the server's RecordingStatus enum in
 * TWO independent copies: the renderer poller (src/services/upload.js) and the
 * Electron main-process poller (src-electron/electron-main.js). They cannot
 * share code across the process boundary, so drift is prevented by this test:
 * it extracts both PERSISTED_STATES / FAILED_STATES literals from the sources
 * and asserts they are identical. If you add a server state, add it to BOTH
 * files — this test tells you when you forgot one.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

function extractSet(source, constName, file) {
  // Matches: const PERSISTED_STATES = new Set([ ... ]);  (multiline)
  const re = new RegExp(`${constName}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`, 'm');
  const match = source.match(re);
  if (!match) throw new Error(`${constName} not found in ${file}`);
  return match[1]
    .split(',')
    .map(s => s.replace(/\/\/.*$/gm, '').trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => s.length > 0)
    .sort();
}

describe('upload status enum lockstep (renderer vs main process)', () => {
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'src/services/upload.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src-electron/electron-main.js'), 'utf8');

  it('PERSISTED_STATES are identical', () => {
    const renderer = extractSet(rendererSrc, 'PERSISTED_STATES', 'src/services/upload.js');
    const main = extractSet(mainSrc, 'PERSISTED_STATES', 'src-electron/electron-main.js');
    expect(main).toEqual(renderer);
  });

  it('FAILED_STATES are identical', () => {
    const renderer = extractSet(rendererSrc, 'FAILED_STATES', 'src/services/upload.js');
    const main = extractSet(mainSrc, 'FAILED_STATES', 'src-electron/electron-main.js');
    expect(main).toEqual(renderer);
  });
});
