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
// Every script below src-electron, subfolders included. The preload script
// runs in the renderer; everything else here is main.
function scriptsIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return scriptsIn(file);
    return entry.name.endsWith('.js') && entry.name !== 'electron-preload.js' ? [file] : [];
  });
}
const SOURCE_FILES = scriptsIn(SOURCE_DIR).map(file => path.relative(SOURCE_DIR, file).split(path.sep).join('/')).sort();

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

// A call that stands in a comment logs nothing.
function isCommentedOut(source, index) {
  const before = source.slice(source.lastIndexOf('\n', index - 1) + 1, index);
  return /(^|\s)\/\/|^\s*\/?\*/.test(before);
}

// Every log.warn( / log.error( call, also written log?.error?.( , and every
// call whose level is computed: log[condition ? 'info' : 'warn']( .
function logCalls(source, file = '') {
  const calls = [];
  const call = /\blog(?:\??\.(warn|error)\??\.?|\[[^\]\n]+\])\(\s*/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    if (isCommentedOut(source, match.index)) continue;
    const text = readLiteral(source, match.index + match[0].length);
    const line = source.slice(0, match.index).split('\n').length;
    const written = source.slice(match.index, source.indexOf('\n', match.index)).replace(/\s+$/, '');
    calls.push({ file, line, level: match[1] || 'computed', text, written });
  }
  return calls;
}

const CALLS = SOURCE_FILES.flatMap(file => logCalls(fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8'), file));
const LITERAL_CALLS = CALLS.filter(entry => entry.text !== null);
const matchesOf = pattern => LITERAL_CALLS.filter(entry => pattern.test(scrub(entry.text, '')));

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
      "log[rounding ? 'info' : 'warn'](`Finalization rebuilt ${recordId}`);",
      "// log.warn('commented out');",
      "  // then log.error('also commented out') was removed",
      " * log.error('in a block comment');",
      "/* log.error('in a block comment') */",
      "fetch('https://example.invalid/a'); log.warn('after a link, not a comment');",
    ].join('\n');
    expect(logCalls(source).map(entry => [entry.line, entry.level, entry.text])).toEqual([
      [1, 'error', 'Failed to write crash metadata:'],
      [2, 'warn', 'Could not recover recording x: x'],
      [3, 'error', 'x: x'],
      [4, 'warn', '[upload] rejected x '],
      [8, 'warn', 'recovery: enqueue failed:'],
      [9, 'warn', null],
      [12, 'computed', 'Finalization rebuilt x'],
      [17, 'warn', 'after a link, not a comment'],
    ]);
  });

  it('finds the log calls of the main process', () => {
    expect(SOURCE_FILES).toContain('electron-main.js');
    expect(SOURCE_FILES).toContain('upload-direct.js');
    expect(SOURCE_FILES).not.toContain('electron-preload.js');
    expect(LITERAL_CALLS.length).toBeGreaterThan(100);
  });

  // A call that logs a variable has no text to hold a pattern to, so it can
  // never be on the list. These are the five known ones: the failures of
  // auth:verifyTwoFactor, auth:resendTwoFactorEmail and auth:register (three
  // warnings), and systemAudio:diag, which logs the renderer's text as an
  // error or a warning. A new one shows up here and gets a decision: write
  // its text into the call, or add it to this list.
  it('knows every call whose text is not written in the call', () => {
    const unread = CALLS.filter(entry => entry.text === null).map(entry => `${entry.file}: ${entry.written}`).sort();
    expect(unread).toEqual([
      'electron-main.js: log.error(line);',
      'electron-main.js: log.warn(line);',
      'electron-main.js: log.warn(line);',
      'electron-main.js: log.warn(line);',
      'electron-main.js: log.warn(line);',
    ]);
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
      const matches = matchesOf(pattern);
      const where = matches.map(entry => `${entry.file}:${entry.line} ${entry.text}`);
      // None: the line was reworded or removed, so it is no longer reported;
      // update the pattern or take it off the list. Several: the pattern is
      // too wide, or a second line now starts the same way; decide for each.
      expect(where, `${pattern} matches ${where.length} log calls: ${where.join(' | ') || 'none'}`).toHaveLength(1);
      // A call that is a warning only sometimes cannot be a reported line.
      expect(['warn', 'error']).toContain(matches[0].level);
    });

  // Start-up recovery and "Restore and upload" report a failed attempt with a
  // line of their own. The finalization inside them says why, under another
  // text that must stay off the list: otherwise one failure files two events.
  it('keeps the finalization failure of a recovery off the list: its caller reports the failure', () => {
    const text = 'Recording finalization failed during recovery; all source batches retained:';
    const written = LITERAL_CALLS.filter(entry => entry.text === text);
    expect(written.map(entry => [entry.file, entry.level])).toEqual([['electron-main.js', 'warn']]);
    expect(REPORTED_LINES.filter(pattern => pattern.test(scrub(`${text} Error: ENOSPC`, '')))).toEqual([]);

    const main = fs.readFileSync(path.join(SOURCE_DIR, 'electron-main.js'), 'utf8').replace(/\r\n/g, '\n');
    // Only the helper both of those callers use asks for it …
    expect(main.match(/failureReportedByCaller: true/g)).toHaveLength(1);
    expect(main).toMatch(/async function combineChunksForRecovery\(recordId\) \{\n[\s\S]{0,300}?failureReportedByCaller: true \}\)\);\n\}/);
    expect(main.match(/combineChunksForRecovery\(/g)).toHaveLength(3); // itself, start-up recovery, restore
    // … and each of them logs its reported line when the attempt fails.
    for (const reported of [/^Could not recover recording .+: /, /^Restore of .+ failed; originals retained:/]) {
      expect(REPORTED_LINES.map(String)).toContain(String(reported));
      expect(matchesOf(reported).map(entry => entry.file)).toEqual(['electron-main.js']);
    }
  });

  it('is given the store of the daily budget by the main process', () => {
    const main = fs.readFileSync(path.join(SOURCE_DIR, 'electron-main.js'), 'utf8');
    expect(main).toMatch(/installLogReporting\(\{[^;]*budgetStore: \{[^;]*read: [^;]*write: [^;]*\}\);/);
    expect(main).toMatch(/app\.getPath\('userData'\), 'main-log-reporting\.json'/);
  });
});
