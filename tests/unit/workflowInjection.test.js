// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// SECURITY: user-controllable values (workflow inputs, event payload, ref
// names) must never be interpolated into a run: script — they are passed via
// env and quoted. Workflows touching secrets declare least-privilege
// permissions; none use pull_request_target / workflow_run.

const DIR = path.resolve(__dirname, '../../.github/workflows');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

const UNTRUSTED = /\$\{\{[^}]*\b(inputs\.|github\.event\.|github\.head_ref|github\.ref_name|steps\.[^}]*outputs\.(?!EXE_PATH))/;

/** Lines of every `run:` block (inline and literal block scalar). */
function runBlocks(source) {
  const lines = source.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const indent = lines[i].search(/\S/);
    const body = [m[2]];
    if (/^[|>]/.test(m[2].trim())) {
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
        body.push(lines[j]);
      }
    }
    blocks.push({ line: i + 1, text: body.join('\n') });
  }
  return blocks;
}

describe('workflow hardening', () => {
  it.each(files)('%s: no untrusted expression inside run:', (file) => {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    const offending = runBlocks(src).filter(b => UNTRUSTED.test(b.text)).map(b => `line ${b.line}`);
    expect(offending).toEqual([]);
  });

  it.each(files)('%s: no pull_request_target / workflow_run trigger', (file) => {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    expect(src).not.toMatch(/^\s*(pull_request_target|workflow_run)\s*:/m);
  });

  it.each(files)('%s: declares permissions', (file) => {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    expect(src).toMatch(/^permissions:/m);
  });
});
