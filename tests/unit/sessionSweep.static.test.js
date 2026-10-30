// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Static rules of the sinks (review round 10, F4; docs/security/pr50-senken.md).
// One checked sink per effect kind of main's background work; a further
// single path is a regression. What the sweep cannot see before it runs:
// - main installs its effect gate before it loads any other module (a module
//   loaded earlier could capture ungated functions; fluent-ffmpeg captures
//   `spawn` at load);
// - no module of main captures fs or child_process functions at load, and
//   none reaches the system past those modules (original-fs, bindings);
// - renderer events only through sendToRenderer, the registry's `send`.

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const walk = require('acorn-walk');
const SRC = 'src-electron';
const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const parse = (source) => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : files(p);
    return d.name.endsWith('.js') ? [p] : [];
  });
}
const MAIN_PROCESS = files(SRC).filter((f) => !/preload/.test(f));
const isRequire = (node, names) => node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'
  && node.arguments[0]?.type === 'Literal' && names.includes(node.arguments[0].value);
const SYSTEM = ['fs', 'fs/promises', 'child_process', 'node:fs', 'node:fs/promises', 'node:child_process'];

describe('static rules of the sinks (round 10)', () => {
  it('main installs its effect gate before it loads any other module', () => {
    const ast = parse(read(path.join(SRC, 'electron-main.js')));
    const install = ast.body.findIndex((n) => n.type === 'ExpressionStatement'
      && n.expression.type === 'CallExpression' && n.expression.callee.property?.name === 'installEffectGate'
      && isRequire(n.expression.callee.object, ['./effect-gate']));
    expect(install).toBeGreaterThan(-1);
    const before = ast.body.slice(0, install).flatMap((n) => {
      const found = [];
      walk.simple(n, { CallExpression(c) { if (c.callee.type === 'Identifier' && c.callee.name === 'require') found.push(c.arguments[0]?.value); } });
      return found;
    });
    expect(before.filter((m) => !['electron', 'path', 'fs'].includes(m))).toEqual([]);
  });

  it('no module of main captures fs or child_process functions at load', () => {
    const offenders = [];
    for (const file of MAIN_PROCESS) {
      const ast = parse(read(file));
      for (const node of ast.body) {
        if (node.type !== 'VariableDeclaration') continue;
        for (const d of node.declarations) {
          let init = d.init;
          const members = [];
          while (init?.type === 'MemberExpression') { members.unshift(init.property.name); init = init.object; }
          if (!isRequire(init, SYSTEM)) continue;
          // The module object or its `promises` object: looked up at call time.
          const captures = d.id.type === 'ObjectPattern'
            ? d.id.properties.some((p) => p.key?.name !== 'promises' && p.key?.name !== 'constants')
            : members.some((m) => m !== 'promises' && m !== 'constants');
          if (captures) offenders.push(`${file}:${node.loc?.start?.line ?? ''} ${read(file).slice(node.start, node.end).slice(0, 100)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing reaches the system past fs and child_process', () => {
    const offenders = MAIN_PROCESS.filter((file) => /require\(\s*['"]original-fs['"]\s*\)|process\.binding\s*\(|internalBinding\s*\(|require\(\s*['"](node:)?worker_threads['"]\s*\)/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it('renderer events only through sendToRenderer, the registry\'s send', () => {
    const uses = MAIN_PROCESS.flatMap((file) => read(file).split('\n')
      .map((line, i) => [file, i + 1, line]).filter(([, , line]) => /webContents\s*\.\s*send\s*\(/.test(line)));
    expect(uses.map(([f, l]) => `${f}:${l}`)).toHaveLength(1);
    const main = read(path.join(SRC, 'electron-main.js'));
    const sink = main.slice(main.indexOf('function sendToRenderer('), main.indexOf('\n}\n', main.indexOf('function sendToRenderer(')));
    expect(sink).toMatch(/^function sendToRenderer\(channel, payload\) \{\n {2}assertPublishAllowed\(\);\n/);
    expect(sink).toContain('webContents.send(channel, payload)');
    expect(main).toMatch(/createScopeRegistry\(\{[\s\S]*?\n {2}send: sendToRenderer,\n/);
  });
});
