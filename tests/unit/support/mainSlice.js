// The REAL code of main's finalization chain and its background ports
// (review round 10, F4). electron-main.js cannot load outside Electron; this
// parses it (acorn) and evaluates, in this realm, exactly the top-level
// declarations the ports reach: the `ports` and `send` of the scope registry,
// the effect-gate installation (if main has one) and every top-level function
// or constant they use, transitively. What stays outside is PROVIDED by the
// caller (Electron, stores, window, Sentry, log, binary paths): the edges.
// The local modules (durable-files, recording-persistence, ...) are the real
// ones, loaded with a require relative to src-electron/.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mutate } from './mutants.js';

const require = createRequire(import.meta.url);
const acorn = require('acorn');
const walk = require('acorn-walk');

export const MAIN_FILE = path.resolve('src-electron/electron-main.js');

/** Names main gets from outside (Electron, stores, state of other parts): the caller provides them. */
export const PROVIDED = [
  'app', 'BrowserWindow', 'ipcMain', 'safeStorage', 'protocol', 'shell', 'dialog', 'Menu', 'Tray', 'nativeImage',
  'desktopCapturer', 'systemPreferences', 'powerMonitor', 'powerSaveBlocker', 'clipboard', 'net', 'session', 'screen',
  'Store', 'ffmpeg', 'log', 'Sentry', 'mainWindow', 'historyStore', 'uploadQueueStore', 'activeRecordingStore',
  'sessionAuthority', 'scopes', 'background', 'inFlightUploads', 'resolveBundledBinaryPaths', 'getRecordingsPath',
  'isExportRecoveryBusy', 'stopSystemAudio', 'activeAudioTee', 'isRecordingInProgress', 'isProcessingRecording',
  'unsavedRecordingId', 'reportBinaryHealthOnce', 'updateRecordingPowerBlocker',
];

function parse(source) {
  return acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
}

function declaredNames(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return [node.id.name];
  if (node.type !== 'VariableDeclaration') return [];
  const names = [];
  for (const d of node.declarations) {
    if (d.id.type === 'Identifier') names.push(d.id.name);
    else if (d.id.type === 'ObjectPattern') for (const p of d.id.properties) if (p.value?.type === 'Identifier') names.push(p.value.name);
  }
  return names;
}

function identifiers(node) {
  const names = new Set();
  walk.full(node, (n) => { if (n.type === 'Identifier') names.add(n.name); });
  return names;
}

/** The object argument property `name` of the createScopeRegistry(...) call. */
function registryProperty(ast, name) {
  let found = null;
  walk.full(ast, (n) => {
    if (found || n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== 'createScopeRegistry') return;
    const arg = n.arguments[0];
    if (arg?.type !== 'ObjectExpression') return;
    found = arg.properties.find((p) => p.key?.type === 'Identifier' && p.key.name === name)?.value || null;
  });
  return found;
}

/**
 * @param {object} opts
 * @param {(source: string) => string} [opts.transform] - a mutation of main's source (mutation tests)
 * @param {string[]} [opts.extra] - further top-level names to return
 * @returns {{ code: string, names: string[], provided: string[] }}
 */
export function compileMainChain({ transform = (s) => s, extra = [] } = {}) {
  const source = transform(mutate('src-electron/electron-main.js', fs.readFileSync(MAIN_FILE, 'utf8').replace(/\r\n/g, '\n')));
  const ast = parse(source);
  const decl = new Map();
  for (const node of ast.body) for (const name of declaredNames(node)) decl.set(name, node);
  const provided = new Set(PROVIDED);
  const ports = registryProperty(ast, 'ports');
  const send = registryProperty(ast, 'send');
  if (!ports || !send) throw new Error('main: createScopeRegistry({ ports, send }) not found');
  // The effect gate of main (if any): a top-level statement that installs it.
  const installs = ast.body.filter((n) => n.type === 'ExpressionStatement' && /\binstallEffectGate\s*\(/.test(source.slice(n.start, n.end)));
  const roots = [ports, send, ...installs];
  const included = new Set();
  const queue = [...extra];
  for (const root of roots) queue.push(...identifiers(root));
  while (queue.length) {
    const name = queue.shift();
    if (provided.has(name)) continue;
    const node = decl.get(name);
    if (!node || included.has(node)) continue;
    included.add(node);
    queue.push(...identifiers(node));
  }
  const statements = ast.body.filter((n) => included.has(n) || installs.includes(n));
  const names = [...new Set(statements.flatMap(declaredNames))];
  const code = [
    ...statements.map((n) => source.slice(n.start, n.end)),
    `return { ports: (${source.slice(ports.start, ports.end)}), send: (${source.slice(send.start, send.end)}), ${names.join(', ')} };`,
  ].join('\n');
  return { code, names, provided: [...provided] };
}

/**
 * Runs only main's own top-level statements that install its effect gate,
 * as main does before it loads any other module (fluent-ffmpeg captures
 * `spawn` when it is loaded). The test rig calls this before it loads
 * fluent-ffmpeg; each rig's chain then installs again with its own folder.
 * @param {object} [opts]
 * @param {(source: string) => string} [opts.transform]
 * @returns {number} the number of install statements of main
 */
export function installMainGate({ transform = (s) => s } = {}) {
  const source = transform(mutate('src-electron/electron-main.js', fs.readFileSync(MAIN_FILE, 'utf8').replace(/\r\n/g, '\n')));
  const installs = parse(source).body.filter((n) => n.type === 'ExpressionStatement' && /\binstallEffectGate\s*\(/.test(source.slice(n.start, n.end)));
  const mainRequire = createRequire(MAIN_FILE);
  // eslint-disable-next-line no-new-func
  new Function('require', `'use strict';\n${installs.map((n) => source.slice(n.start, n.end)).join('\n')}`)(mainRequire);
  return installs.length;
}

/**
 * Evaluates the compiled chain with the provided edges.
 * @param {{ code: string, provided: string[] }} compiled
 * @param {object} edges - a value for each PROVIDED name (missing: undefined)
 */
export function loadMainChain(compiled, edges) {
  const mainRequire = createRequire(MAIN_FILE);
  const params = [...compiled.provided, 'require', '__dirname', '__filename'];
  // eslint-disable-next-line no-new-func
  const factory = new Function(...params, `'use strict';\n${compiled.code}`);
  return factory(...compiled.provided.map((name) => edges[name]), mainRequire, path.dirname(MAIN_FILE), MAIN_FILE);
}
