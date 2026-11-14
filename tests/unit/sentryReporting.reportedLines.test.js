// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REPORTED_LINES, scrub } from '../../src-electron/sentry-reporting.js';

// The list of reported log lines (REPORTED_LINES) names lines by their text.
// Nothing else ties a pattern to the code: reword a log line and it silently
// stops being reported. This test reads the main-process sources and holds
// every pattern to exactly one log.warn / log.error call.

const SOURCE_DIR = path.resolve('src-electron');
// The preload script runs in the renderer; everything else here is main.
const SOURCE_FILES = fs.readdirSync(SOURCE_DIR)
  .filter(name => name.endsWith('.js') && name !== 'electron-preload.js').sort();

const PLACEHOLDER = 'x'; // stands for every ${…} of a template literal

// The first argument of a log call when it is a string or template literal,
// as the text it logs. Returns null for anything else (a variable, a call).
function readLiteral(source, start) {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let text = '';
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') { text += source[i + 1]; i += 1; continue; }
    if (char === quote) return text;
    if (quote === '`' && char === '$' && source[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') depth -= 1;
        i += 1;
      }
      i -= 1; // on the closing brace
      text += PLACEHOLDER;
      continue;
    }
    text += char;
  }
  return null;
}

// Every log.warn( / log.error( call, also written log?.error?.(
function logCalls(source, file = '') {
  const calls = [];
  const call = /\blog\??\.(warn|error)\??\.?\(\s*/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    const text = readLiteral(source, match.index + match[0].length);
    const line = source.slice(0, match.index).split('\n').length;
    calls.push({ file, line, level: match[1], text });
  }
  return calls;
}

const CALLS = SOURCE_FILES.flatMap(file => logCalls(fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8'), file));
const LITERAL_CALLS = CALLS.filter(entry => entry.text !== null);

describe('the reader of log calls', () => {
  it('reads the constant text of a call in each way the sources write one', () => {
    const source = [
      "log.error('Failed to write crash metadata:', e);",
      'log.warn(`Could not recover recording ${dir}: ${result.error}`);',
      'log?.error?.(`${title}: ${JSON.stringify(extra || {})}`);',
      'log.warn(',
      '  `[upload] rejected ${recordId} ` +',
      "  'falling back'",
      ');',
      "x.catch(e => log.warn('recovery: enqueue failed:', e.message));",
      'log.warn(line);',
      "log.info('not a warning');",
      "catalog.warn('not the logger');",
    ].join('\n');
    expect(logCalls(source).map(entry => [entry.line, entry.level, entry.text])).toEqual([
      [1, 'error', 'Failed to write crash metadata:'],
      [2, 'warn', 'Could not recover recording x: x'],
      [3, 'error', 'x: x'],
      [4, 'warn', '[upload] rejected x '],
      [8, 'warn', 'recovery: enqueue failed:'],
      [9, 'warn', null],
    ]);
  });

  it('finds the log calls of the main process', () => {
    expect(SOURCE_FILES).toContain('electron-main.js');
    expect(SOURCE_FILES).toContain('upload-direct.js');
    expect(LITERAL_CALLS.length).toBeGreaterThan(100);
  });
});

describe('reported log lines', () => {
  it('lists every pattern once, anchored at the start of the line', () => {
    const sources = REPORTED_LINES.map(pattern => pattern.source);
    expect(new Set(sources).size).toBe(sources.length);
    for (const pattern of REPORTED_LINES) {
      expect(pattern.source.startsWith('^'), `${pattern} is not anchored`).toBe(true);
      expect(pattern.flags, `${pattern} must stay stateless and case-sensitive`).toBe('');
    }
  });

  it.each(REPORTED_LINES.map(pattern => [String(pattern), pattern]))(
    '%s is the text of exactly one log.warn/log.error call', (_name, pattern) => {
      const matches = LITERAL_CALLS
        .filter(entry => pattern.test(scrub(entry.text)))
        .map(entry => `${entry.file}:${entry.line} ${entry.text}`);
      // None: the line was reworded or removed, so it is no longer reported;
      // update the pattern or take it off the list. Several: the pattern is
      // too wide, or a second line now starts the same way; decide for each.
      expect(matches, `${pattern} matches ${matches.length} log calls: ${matches.join(' | ') || 'none'}`).toHaveLength(1);
    });
});
