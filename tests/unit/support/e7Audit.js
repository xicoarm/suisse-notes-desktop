// E7 audit (security review round 8): static rules for main's background work.
//
// Audited: in electron-main.js every function whose body uses `ticket` (the
// session ticket of E2/E7) plus a fixed list of background functions; all of
// pending-uploads.js. Rules:
//  A  every `await` is followed by a ticket check (an `if` that tests
//     sessionEndedFor / isCurrent / current and leaves), or is returned
//     directly (the caller checks), or carries a `// E7: <reason>` marker on
//     its line;
//  B  a `catch` of a `try` with an await starts with a ticket check (or marker);
//  C  a callback inside audited code that awaits or writes/requests (sink)
//     starts with a ticket check (or marker on its first line);
//  D  refreshMainAuthToken is always called with the owner's ticket;
//  E  every axios request in upload-direct.js carries the abort signal (main
//     aborts it on every session change).
// The marker lines are the audited exceptions; each is listed in the round-8
// result table with its reason.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const espree = require('espree');

const CHECKS = new Set(['sessionEndedFor', 'isCurrent', 'current', 'isCurrentTicket']);
const SINKS = new Set([
  'writeFileAtomic', 'saveUploadOutcome', 'addToUploadQueue', 'removeFromUploadQueue', 'updateUploadQueueRetry',
  'refreshMainAuthToken', 'uploadViaPresignedSas', 'abortDirectUpload', 'verifyAcceptedUpload', 'pollServerStatus',
  'removeFromQueue', 'updateHistory', 'bumpRetry', 'saveOutcome', 'upload'
]);
const SINK_OBJECTS = new Set(['axios', 'historyStore', 'uploadQueueStore', 'activeRecordingStore']);

export function parse(text) {
  return espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script', range: true, loc: true, comment: true });
}

const isFunction = (n) => n && (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression');

/** Walk with parents; `enter(node, parent)` returns false to skip children. */
export function walk(node, enter, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (enter(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'range' || key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walk(child, enter, node));
    else if (value && typeof value.type === 'string') walk(value, enter, node);
  }
}

function linkParents(ast) {
  walk(ast, (node, parent) => { Object.defineProperty(node, 'parent', { value: parent, enumerable: false, configurable: true }); });
}

function calleeName(call) {
  const c = call.callee;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') return c.property.name;
  return null;
}

function contains(node, predicate, { intoFunctions = false } = {}) {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if (n !== node && isFunction(n) && !intoFunctions) return false;
    if (predicate(n)) { found = true; return false; }
    return undefined;
  });
  return found;
}

const isCheckCall = (n) => n.type === 'CallExpression' && CHECKS.has(calleeName(n));
const leaves = (n) => contains(n, (x) => ['ReturnStatement', 'ThrowStatement', 'ContinueStatement', 'BreakStatement'].includes(x.type));

/** `if (<ticket check>) <leave>` */
export function isTicketCheck(stmt) {
  return !!stmt && stmt.type === 'IfStatement' && contains(stmt.test, isCheckCall) && leaves(stmt.consequent);
}

function isSinkCall(n) {
  if (n.type !== 'CallExpression') return false;
  const c = n.callee;
  if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && SINK_OBJECTS.has(c.object.name)) {
    return c.object.name === 'axios' || calleeName(n) === 'set';
  }
  return SINKS.has(calleeName(n));
}

function enclosingStatement(node) {
  let n = node;
  while (n.parent && !(Array.isArray(n.parent.body) || Array.isArray(n.parent.consequent)) ) {
    if (isFunction(n.parent)) return null;
    n = n.parent;
  }
  return n;
}

function statementList(stmt) {
  const p = stmt.parent;
  if (!p) return null;
  if (Array.isArray(p.body)) return p.body;
  if (Array.isArray(p.consequent)) return p.consequent;
  return null;
}

/** The statement that runs next after `stmt` (walking out of blocks, ifs and trys). */
function nextStatement(stmt) {
  let s = stmt;
  for (;;) {
    const list = statementList(s);
    if (!list) return null;
    const i = list.indexOf(s);
    if (i >= 0 && i < list.length - 1) return list[i + 1];
    // Last in its block: step out of block / if / try (never out of a loop or function).
    let up = s.parent;
    if (up.type === 'BlockStatement') {
      const owner = up.parent;
      if (!owner) return null;
      if (owner.type === 'IfStatement' || owner.type === 'TryStatement' || owner.type === 'BlockStatement') s = owner;
      else if (owner.type === 'CatchClause') s = owner.parent;
      else return null;
      continue;
    }
    return null;
  }
}

function markerLines(ast) {
  const lines = new Set();
  for (const c of ast.comments || []) if (/^\s*E7:\s*\S/.test(c.value)) lines.add(c.loc.start.line);
  return lines;
}

function isAudited(fn, extraNames) {
  const name = fn.id?.name;
  if (name && extraNames.has(name)) return true;
  return contains(fn.body, (n) => n.type === 'Identifier' && n.name === 'ticket', { intoFunctions: false });
}

/**
 * @param {string} text - source
 * @param {object} opts
 * @param {string[]} [opts.functions] - names audited in any case
 * @param {boolean} [opts.all] - audit every function (pending-uploads.js)
 * @returns {{ findings: Array<{rule: string, line: number, text: string}>, audited: string[], markers: Array<{line: number, text: string}> }}
 */
export function auditSource(text, { functions = [], all = false } = {}) {
  const ast = parse(text);
  linkParents(ast);
  const extraNames = new Set(functions);
  const markers = markerLines(ast);
  const lines = text.split('\n');
  const audited = new Set();
  walk(ast, (n) => {
    if (isFunction(n) && (all || isAudited(n, extraNames))) {
      audited.add(n);
      return false; // nested functions belong to this audited function
    }
    return undefined;
  });
  const findings = [];
  const usedMarkers = [];
  const find = (rule, node) => findings.push({ rule, line: node.loc.start.line, text: lines[node.loc.start.line - 1].trim() });
  const marked = (node) => {
    if (markers.has(node.loc.start.line)) { usedMarkers.push({ line: node.loc.start.line, text: lines[node.loc.start.line - 1].trim() }); return true; }
    return false;
  };

  for (const fn of audited) {
    walk(fn.body, (n) => {
      // C: a callback inside audited code.
      if (isFunction(n) && n !== fn) {
        const awaitsOrWrites = contains(n.body, (x) => x.type === 'AwaitExpression' || isSinkCall(x));
        if (awaitsOrWrites && !marked(n)) {
          const first = n.body.type === 'BlockStatement' ? n.body.body[0] : null;
          if (!isTicketCheck(first)) find('C callback without a ticket check', n);
        }
        return undefined;
      }
      if (n.type === 'AwaitExpression') {
        const stmt = enclosingStatement(n);
        if (!stmt) return undefined;
        if (stmt.type === 'ReturnStatement' && stmt.argument === n) return undefined;
        if (marked(n)) return undefined;
        if (!isTicketCheck(nextStatement(stmt))) find('A await without a following ticket check', n);
      }
      if (n.type === 'TryStatement' && n.handler && contains(n.block, (x) => x.type === 'AwaitExpression')) {
        const first = n.handler.body.body[0];
        if (!isTicketCheck(first) && !marked(n.handler)) find('B catch without a ticket check', n.handler);
      }
      if (n.type === 'CallExpression' && calleeName(n) === 'refreshMainAuthToken' && n.arguments.length === 0) {
        find('D refresh without the owner ticket', n);
      }
      return undefined;
    });
  }
  const names = [...audited].map((f) => f.id?.name || (f.parent?.type === 'CallExpression' && f.parent.arguments[0]?.type === 'Literal' ? f.parent.arguments[0].value : `<anonymous:${f.loc.start.line}>`));
  return { findings, audited: names, markers: usedMarkers };
}

/** E: axios calls without the abort signal (upload-direct.js). */
export function axiosWithoutSignal(text) {
  const ast = parse(text);
  const lines = text.split('\n');
  const out = [];
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'axios') {
      const hasSignal = n.arguments.some((a) => a.type === 'ObjectExpression' && a.properties.some((p) => p.key && (p.key.name === 'signal' || p.key.value === 'signal')));
      if (!hasSignal) out.push({ line: n.loc.start.line, text: lines[n.loc.start.line - 1].trim() });
    }
  });
  return out;
}
