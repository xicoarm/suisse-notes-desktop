// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Review round 9 (council 3, P1): the main-process TUS upload had no caller
// (the preload never exposed `startTUS`; the renderer calls only
// upload.start/cancel) and kept running after a sign-out (r8 HIGH: its
// requests sat outside every abort). It is deleted, with pause/resume.
// Failed at 7c121955.

const read = (file) => fs.readFileSync(path.resolve(file), 'utf8');

describe('P1: no TUS upload in the main process', () => {
  it('main registers no upload:startTUS, upload:pause or upload:resume handler and has no TUS client', () => {
    const main = read('src-electron/electron-main.js');
    for (const channel of ['upload:startTUS', 'upload:pause', 'upload:resume']) expect(main, channel).not.toContain(`'${channel}'`);
    expect(main).not.toMatch(/tus-js-client/);
    expect(main).not.toMatch(/\bactiveUploads\b/);
  });

  it('the preload exposes no TUS start, pause or resume', () => {
    const preload = read('src-electron/electron-preload.js');
    expect(preload).not.toMatch(/upload:(startTUS|pause|resume)/);
    expect(preload).not.toMatch(/\bstartTUS\b/);
  });

  it('nothing under src-electron or src mentions startTUS', () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); }
        else if (/\.(js|vue|ts)$/.test(entry.name) && fs.readFileSync(file, 'utf8').includes('startTUS')) hits.push(file);
      }
    };
    walk(path.resolve('src-electron'));
    walk(path.resolve('src'));
    expect(hits).toEqual([]);
  });
});
