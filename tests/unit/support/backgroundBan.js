// Static ban list for src-electron/background/** (review round 9, council 3,
// required test 3). The background reaches effects only through its
// SessionScope, so a module there may require only `path` and its siblings,
// and may not name main's stores, window or IPC, the global object, the
// module system or an evaluator. Every alias, chain or dynamic form of
// those is a finding too (negative mutation tests in
// mainBackgroundStatic.test.js).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const espree = require('espree');

export const BANNED_MODULES = ['axios', 'tus-js-client', 'electron', 'electron-store', 'fs', 'node:fs', 'fs/promises',
  'node:fs/promises', 'original-fs', 'child_process', 'node:child_process', './durable-files', '../durable-files'];
export const ALLOWED_MODULES = ['path', 'node:path', './ended', './upload-direct', './queue-ops', './upload', './pending-uploads', './recovery'];
export const BANNED_IDENTIFIERS = ['historyStore', 'uploadQueueStore', 'activeRecordingStore', 'mainWindow', 'ipcMain',
  'globalThis', 'global', 'eval', 'Function', 'BrowserWindow', 'webContents', 'axios', 'durable'];
const PROCESS_BANNED = ['mainModule', 'binding', '_linkedBinding', 'dlopen'];

function walk(node, parent, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'range' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, node, visit);
    else if (value && typeof value.type === 'string') walk(value, node, visit);
  }
}

/** An Identifier that refers to a binding (not a property name or key). */
function isReference(node, parent) {
  if (!parent) return true;
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed && !parent.shorthand) return false;
  return true;
}

const literalString = (node) => (node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null);
const memberName = (node) => (node.computed ? literalString(node.property) : node.property?.name);

/** @returns {Array<{rule: string, detail: string, line: number}>} */
export function auditBackgroundSource(source) {
  const ast = espree.parse(source, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
  const findings = [];
  const add = (rule, detail, node) => findings.push({ rule, detail, line: node.loc?.start.line || 0 });
  walk(ast, null, (node, parent) => {
    if (node.type === 'ImportExpression') add('dynamic import', 'import()', node);
    if (node.type === 'Identifier' && node.name === 'require' && isReference(node, parent)) {
      // The only allowed form: require('<allowed literal>') as a direct call.
      if (!(parent?.type === 'CallExpression' && parent.callee === node)) { add('require alias', 'require used as a value', node); return; }
      const name = parent.arguments.length === 1 ? literalString(parent.arguments[0]) : null;
      if (name === null) add('non-literal require', 'require(<expression>)', node);
      else if (BANNED_MODULES.includes(name)) add('banned module', name, node);
      else if (!ALLOWED_MODULES.includes(name)) add('module not allowed', name, node);
    }
    if (node.type === 'Identifier' && BANNED_IDENTIFIERS.includes(node.name) && isReference(node, parent)) add('banned identifier', node.name, node);
    if (node.type === 'Identifier' && node.name === 'module' && isReference(node, parent)) {
      const exportsUse = parent?.type === 'MemberExpression' && parent.object === node && memberName(parent) === 'exports';
      if (!exportsUse) add('module system', `module.${parent?.type === 'MemberExpression' ? (memberName(parent) ?? '[expression]') : '(value)'}`, node);
    }
    if (node.type === 'MemberExpression' && node.object?.type === 'Identifier' && node.object.name === 'process') {
      const name = memberName(node);
      if (name === null || PROCESS_BANNED.includes(name)) add('process internals', `process.${name ?? '[expression]'}`, node);
    }
    if (node.type === 'Identifier' && node.name === 'process' && isReference(node, parent) && !(parent?.type === 'MemberExpression' && parent.object === node)) {
      add('process as a value', 'process', node);
    }
  });
  return findings;
}

/**
 * Main's calls into the background: the factory gets only the allowed keys
 * and no store, window, IPC or HTTP client; every call into `background`
 * passes a scope (or the registry) first.
 */
export function auditMainWiring(mainSource, { allowedKeys }) {
  const ast = espree.parse(mainSource, { ecmaVersion: 'latest', sourceType: 'script', loc: true });
  const findings = [];
  let factoryCalls = 0;
  let backgroundCalls = 0;
  walk(ast, null, (node) => {
    if (node.type !== 'CallExpression') return;
    if (node.callee.type === 'Identifier' && node.callee.name === 'createBackground') {
      factoryCalls++;
      const arg = node.arguments[0];
      if (arg?.type !== 'ObjectExpression') { findings.push('createBackground without an object literal'); return; }
      for (const prop of arg.properties) {
        const key = prop.type === 'Property' && !prop.computed ? prop.key.name : null;
        if (!key || !allowedKeys.includes(key)) findings.push(`factory key not allowed: ${key ?? prop.type}`);
      }
      walk(arg, null, (inner, parent) => {
        if (inner.type === 'Identifier' && ['historyStore', 'uploadQueueStore', 'activeRecordingStore', 'mainWindow', 'ipcMain', 'axios', 'scopes'].includes(inner.name) && isReference(inner, parent)) {
          findings.push(`factory argument names ${inner.name} (line ${inner.loc.start.line})`);
        }
      });
    }
    // background.x(...) or background.x.y(...)
    let callee = node.callee;
    const chain = [];
    while (callee?.type === 'MemberExpression') { chain.unshift(memberName(callee)); callee = callee.object; }
    if (callee?.type === 'Identifier' && callee.name === 'background' && chain.length) {
      if (chain.join('.') === 'recovery.isRunning') return;
      backgroundCalls++;
      const first = node.arguments[0];
      if (!(first?.type === 'Identifier' && /scope/i.test(first.name))) findings.push(`background.${chain.join('.')} without a scope first (line ${node.loc.start.line})`);
    }
  });
  if (factoryCalls !== 1) findings.push(`createBackground called ${factoryCalls} times`);
  return { findings, backgroundCalls };
}
