// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compileMainChain } from './support/mainSlice.js';
import { auditContextExit, auditPorts, chainModules, ALLOWED_PACKAGES, lockfileFindings } from './support/contractStatic.js';

// Static rules of the sinks (review round 10, F4; docs/security/pr50-senken.md).
// One checked sink per effect kind of main's background work; a further
// single path is a regression. What the sweep cannot see before it runs:
// - main installs its effect gate before it loads any other module (a module
//   loaded earlier could capture ungated functions; fluent-ffmpeg captures
//   `spawn` at load);
// - no module of main captures fs or child_process functions at load, and
//   none reaches the system past those modules (original-fs, bindings);
// - renderer events only through sendToRenderer, the registry's `send`;
// - round 13 (R-S7.5, R-S7.8): the way out of a context exists only in the gate,
//   exactly three ports, and the port chain's closed list of modules.

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

describe('static rules of the context contract (round 13)', () => {
  const sources = () => MAIN_PROCESS.map((file) => [file.split(path.sep).join('/'), read(file)]);

  it('R-S7.5: the context objects, .exit, .enterWith and .disable exist only in effect-gate.js', () => {
    expect(auditContextExit(sources())).toEqual([]);
  });

  it('R-S7.5, negative: a free .exit, a second AsyncLocalStorage, an exported context are findings', () => {
    const add = (extra) => [...sources(), ['src-electron/x.js', extra]];
    expect(auditContextExit(add('const g = require("./effect-gate"); g.publishGate.exit(() => {});'))).not.toEqual([]);
    expect(auditContextExit(add('const { AsyncLocalStorage } = require("async_hooks");'))).not.toEqual([]);
    expect(auditContextExit(add('thing.enterWith(1);'))).not.toEqual([]);
    expect(auditContextExit(add('runInSession({}, () => {});'))).not.toEqual([]);
    expect(auditContextExit(sources().map(([f, s]) => [f, f.endsWith('effect-gate.js') ? s.replace('module.exports = { runInSession,', 'module.exports = { publishGate, runInSession,') : s]))).not.toEqual([]);
  });

  it('R-S7.5: exactly three ports, each with its fixed data parameters', () => {
    expect(auditPorts(sources())).toEqual([]);
  });

  it('R-S7.5, negative: a fourth port, a port with a path parameter, a port with a callback are findings', () => {
    const edit = (from, to) => sources().map(([f, s]) => [f, s.replace(from, to)]);
    expect(auditPorts([...sources(), ['src-electron/x.js', "sealPort('settings', (key) => key);"]])).not.toEqual([]);
    expect(auditPorts(edit("sealPort('appLog', (level, text) =>", "sealPort('appLog', (level, filePath) =>"))).not.toEqual([]);
    expect(auditPorts(edit("sealPort('telemetry', (event) =>", "sealPort('telemetry', (event, done) =>"))).not.toEqual([]);
  });

  it('R-S7.5: settings, updates, crash markers and the Sentry object are no part of the port chain', () => {
    const chain = compileMainChain();
    expect(chain.code).not.toMatch(/\bSentry\s*\./);
    expect(chain.code).not.toMatch(/\b(autoUpdater|settingsStore|configStore|updateChecks|createUpdateChecks)\b/);
    expect(chain.code).not.toMatch(/\b(crash-metadata|crashMarker|writeCrash)/i);
  });

  it('R-S7.8: the closed list of modules of the port chain, transitively', () => {
    const { builtins, packages, offenders } = chainModules();
    expect(offenders).toEqual([]);
    expect([...packages].sort()).toEqual([...ALLOWED_PACKAGES].sort());
    expect([...builtins].filter((m) => ['http', 'https', 'net', 'tls', 'dgram', 'worker_threads', 'cluster', 'vm', 'original-fs', 'electron'].includes(m.replace(/^node:/, '')))).toEqual([]);
  });

  it('R-S7.8: no new process kinds, addons or raw transports in the port chain and background/', () => {
    const chain = compileMainChain();
    const banned = /\b(utilityProcess|process\.dlopen|process\.binding|internalBinding|new Worker|shell\.)/;
    expect(chain.code).not.toMatch(banned);
    const background = files(path.join(SRC, 'background')).filter((f) => banned.test(read(f)));
    expect(background).toEqual([]);
  });

  it('R-S7.8: the lockfile: the allowed packages of the chain carry no native part or worker', () => {
    expect(lockfileFindings()).toEqual([]);
  });
});

// P9: the TUS timeout fallback (src/services/upload.js, `uploadFileMobile`) keeps
// the bearer of its start. Unreachable today: nothing calls it. A caller is a
// finding: it needs the epoch check or the abort first.
describe('mobile: the TUS fallback has no caller', () => {
  it('uploadFileMobile is only declared', () => {
    const source = read('src/services/upload.js');
    expect(source.match(/\buploadFileMobile\b/g)).toHaveLength(1);
  });
});
