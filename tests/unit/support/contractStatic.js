// Static rules of the context contract (round 13, R-S7.5, R-S7.8), as functions
// of the sources so the negative cases can feed them a changed source.

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { compileMainChain } from './mainSlice.js';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const walk = require('acorn-walk');
const parse = (source) => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
const GATE = 'src-electron/effect-gate.js';

// The packages the port chain may reach. fluent-ffmpeg starts its processes
// through the gated child_process module; its own dependencies are plain code.
export const ALLOWED_PACKAGES = ['fluent-ffmpeg'];

/** R-S7.5: every way into or out of a context outside the gate; a gate that exports its context. */
export function auditContextExit(sources) {
  const out = [];
  for (const [file, source] of sources) {
    const own = file.endsWith(GATE);
    walk.full(parse(source), (n) => {
      if (own) return;
      if (n.type === 'MemberExpression' && !n.computed && ['exit', 'enterWith', 'disable'].includes(n.property.name)
        && !(n.property.name === 'exit' && n.object.type === 'Identifier' && ['process', 'app'].includes(n.object.name))) out.push(`${file}: .${n.property.name}`);
      if (n.type === 'Identifier' && ['AsyncLocalStorage', 'publishGate', 'AsyncResource'].includes(n.name)) out.push(`${file}: ${n.name}`);
      // R-S7.4: a context is created in the scope's gated() only.
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'runInSession' && !file.endsWith('src-electron/session-scope.js')) out.push(`${file}: runInSession`);
    });
    if (own) {
      const exported = /module\.exports\s*=\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
      if (/\b(publishGate|admitted)\b/.test(exported)) out.push(`${file}: exports its context`);
    }
  }
  return out;
}

const PORT_PARAMS = { appLog: ['level', 'text'], telemetry: ['event'], authorityPersist: ['op', 'value'] };

/** R-S7.5: sealPort is called exactly three times, with its name and its data parameters. */
export function auditPorts(sources) {
  const out = [];
  const seen = [];
  for (const [file, source] of sources) {
    if (file.endsWith(GATE)) continue;
    walk.full(parse(source), (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'sealPort') return;
      const name = n.arguments[0]?.value;
      seen.push(name);
      const params = n.arguments[1]?.params?.map((p) => p.name);
      if (JSON.stringify(params) !== JSON.stringify(PORT_PARAMS[name])) out.push(`${file}: port ${name} with (${params})`);
    });
  }
  if (JSON.stringify([...seen].sort()) !== JSON.stringify(Object.keys(PORT_PARAMS).sort())) out.push(`ports: ${seen.join(', ')}`);
  return out;
}

const BUILTIN = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Every module the port chain requires, transitively from main's chain and the local modules. */
export function chainModules() {
  const builtins = new Set();
  const packages = new Set();
  const offenders = [];
  const visited = new Set();
  const main = path.resolve('src-electron/electron-main.js');
  const requires = (source) => {
    const names = [];
    walk.full(parse(source), (n) => {
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments[0]?.type === 'Literal') names.push(n.arguments[0].value);
    });
    return names;
  };
  function visit(from, name) {
    if (BUILTIN.has(name)) { builtins.add(name); return; }
    if (name === 'electron') { offenders.push(`${path.relative('.', from)}: electron`); return; }
    if (!name.startsWith('.')) { packages.add(name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')); return; }
    const file = createRequire(from).resolve(name);
    if (visited.has(file)) return;
    visited.add(file);
    for (const inner of requires(fs.readFileSync(file, 'utf8'))) visit(file, inner);
  }
  // The chain's own statements: what its closure declares with require().
  const { code } = compileMainChain();
  for (const name of requires(code)) visit(main, name);
  // `ffmpeg` is an edge of the slice; main's is this package.
  if (/\bffmpeg\s*[.(]/.test(code)) packages.add('fluent-ffmpeg');
  return { builtins, packages, offenders };
}

/** The allowed packages and everything they depend on: an install script, a native part, a worker. */
export function lockfileFindings() {
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8')).packages;
  const out = [];
  const seen = new Set();
  const visit = (name) => {
    const key = `node_modules/${name}`;
    const entry = lock[key];
    if (seen.has(key) || !entry) return;
    seen.add(key);
    if (entry.hasInstallScript) out.push(`${name}: install script`);
    const files = [];
    const list = (dir) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory() && d.name !== 'node_modules') list(p);
        else if (d.isFile()) files.push(p);
      }
    };
    if (fs.existsSync(key)) list(key);
    for (const p of files) {
      if (p.endsWith('.node') || path.basename(p) === 'binding.gyp') out.push(`${name}: native part ${p}`);
      if (p.endsWith('.js') && /require\(\s*['"](node:)?worker_threads['"]\s*\)/.test(fs.readFileSync(p, 'utf8'))) out.push(`${name}: worker ${p}`);
    }
    for (const dep of Object.keys(entry.dependencies || {})) visit(dep);
  };
  for (const name of ALLOWED_PACKAGES) visit(name);
  return out;
}
