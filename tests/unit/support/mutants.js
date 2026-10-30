// Mutants of the sinks (review round 10, F4). A mutant is a set of source
// edits of src-electron, applied when a module is loaded (globalSinks.js
// hooks the CommonJS loader; mainSlice.js reads main through `mutate`). The
// mutation test (sweepMutation.main.test.js) runs the sweep probe in a child
// process per mutant (SWEEP_MUTANT=<name>) and expects it red; each sink kind
// (fs, child process, renderer event) has a «sink off» and a «bypass» mutant.
//
// «A new single path» (the lead decision of round 10): PATH_* insert one more
// effect into the merge of system audio, right after the merged file is
// published - through the sink (control: the sweep stays green), past a
// sink that is switched off, or past the sink (bypass: a function captured
// before main installed its gate, or webContents.send directly).

const MAIN = 'src-electron/electron-main.js';
const GATE = 'src-electron/effect-gate.js';
const SCOPE = 'src-electron/session-scope.js';
const APP_PORTS = 'src-electron/app-ports.js';

const PUBLISHED = '    await publishFile(mergedPath, micPath);\n';
const after = (line) => [PUBLISHED, `${PUBLISHED}${line}\n`];
const PATH_WRITE = "    fs.writeFileSync(path.join(recordPath, 'merge-note.txt'), 'merged');";
const PATH_WRITE_BYPASS = "    globalThis.__sweepPreGate.fs.writeFileSync(path.join(recordPath, 'merge-note.txt'), 'merged');";
const PATH_SPAWN = "    require('child_process').execFile(resolveBundledBinaryPaths().ffprobe, ['-version'], () => {});";
const PATH_SPAWN_BYPASS = "    globalThis.__sweepPreGate.cp.execFile(resolveBundledBinaryPaths().ffprobe, ['-version'], () => {});";
// Round 11 (F6/F7): numeric open flags. Through the sink: a new file opened
// with O_WRONLY|O_CREAT|O_TRUNC and written. Past it: O_TRUNC empties the
// existing metadata.json at the open (with O_CREAT: Windows refuses O_TRUNC
// without it, EINVAL); O_CREAT creates a file without a write.
// The descriptor is closed whatever the write does (Windows cannot remove a
// folder with an open file in it).
const PATH_OPEN = "    { const fd = fs.openSync(path.join(recordPath, 'merge-open.txt'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC); try { fs.writeSync(fd, 'merged'); } finally { fs.closeSync(fd); } }";
const PATH_OPEN_TRUNC_BYPASS = "    { const pre = globalThis.__sweepPreGate.fs; pre.closeSync(pre.openSync(path.join(recordPath, 'metadata.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC)); }";
const PATH_OPEN_CREAT_BYPASS = "    { const pre = globalThis.__sweepPreGate.fs; pre.closeSync(pre.openSync(path.join(recordPath, 'merge-created.txt'), fs.constants.O_WRONLY | fs.constants.O_CREAT)); }";
// Round 12 (F10): an attribute past the gate - the mtime of metadata.json
// set back (no byte changes); the oracle counts it and the snapshot sees it.
const PATH_ATTR_BYPASS = "    globalThis.__sweepPreGate.fs.utimesSync(path.join(recordPath, 'metadata.json'), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));";
// Round 13: an effect that lost its context after the change (P3), an effect past
// the gate on a file outside the recordings folder, an app service started lazily
// in the session's context (P4).
const PATH_CONTEXT_LOST = "    globalThis.__sweepNoContext.runInAsyncScope(() => fs.writeFileSync(path.join(recordPath, 'merge-lost.txt'), 'merged'));";
const PATH_EXTERNAL_BYPASS = "    globalThis.__sweepPreGate.fs.writeFileSync(path.join(globalThis.__sweepCanary(), 'app.log'), 'changed');";
const PATH_LAZY_SERVICE = '    setInterval(() => {}, 60000);';
const PATH_SEND = "    sendToRenderer('system:capture-warning', { kind: 'merged', recordId });";
const PATH_SEND_BYPASS = "    mainWindow.webContents.send('system:capture-warning', { kind: 'merged', recordId });";

const FS_GATE_OFF = [
  ['      const error = refusalFor(gate, base, args);\n      if (error) throw error;\n', ''],
  ['      const error = refusalFor(gate, name, args);\n      if (error) { process.nextTick(callback, error); return undefined; }\n', ''],
  ['        const error = refusalFor(gate, name, args);\n        if (error) return Promise.reject(error);\n', ''],
  ["        const error = refusalOf(gate) || (runsForeignCode(name, [null, args[0]]) ? foreignCodeError(name) : null);\n        if (error) return Promise.reject(error);\n", ''],
];
const SPAWN_GATE_OFF = [
  ['      const error = startRefusal();\n      if (error) return refusedChild(', '      const error = null;\n      if (error) return refusedChild('],
  ['      const error = startRefusal();\n      if (error) throw error;\n      return original.apply(this, args);', '      return original.apply(this, args);'],
];
// The gate of round 10: flags as a string only (a number is read as digits).
const OPEN_FLAGS_STRING_ONLY = [
  ['function writeFlags(flags) {\n', 'function writeFlags(flags) {\n  return /[wa+]/.test(String(flags ?? \'r\'));\n'],
];
// R-S7.7: temp by name pattern; temp more than once.
const TEMP_BY_PATTERN = [
  ["if (name === 'unlink' && forgetTemp(gate, args[0])) return null;", "if (name === 'unlink' && /\\.tmp$/.test(String(args[0]))) return null;"],
];
const TEMP_MANY = [
  ["if (name === 'unlink' && forgetTemp(gate, args[0])) return null;", "if (name === 'unlink' && hasTemp(gate, args[0])) return null;"],
  ["else if ((name === 'rename' || name === 'unlink') && hasTemp(gate, args[0])) forgetTemp(gate, args[0]);", "else if (name === 'rename' && hasTemp(gate, args[0])) forgetTemp(gate, args[0]);"],
];
const STAT_IN_FAST_PATH = [
  ['      const gate = publishGate.getStore();\n      if (!gate || admitted.getStore() || !isEffect(base, args)) return original.apply(this, args);\n',
    "      if (base === 'open' && typeof args[0] === 'string') fs.lstatSync(args[0], { throwIfNoEntry: false });\n      const gate = publishGate.getStore();\n      if (!gate || admitted.getStore() || !isEffect(base, args)) return original.apply(this, args);\n"],
];
const SEND_GATE_OFF = [
  ['function sendToRenderer(channel, payload) {\n  assertPublishAllowed();\n', 'function sendToRenderer(channel, payload) {\n'],
];

/**
 * name -> { kind, also, edits: { file: [[from, to], ...] }, cases } (cases: of support/chainEntries.js NAMED;
 * also: further violations the mutant must cause)
 */
export const MUTANTS = {
  // Controls: unmutated, and the three new paths through their sinks.
  control: { kind: null, edits: {}, cases: 'all' },
  'paths-through-sinks': { kind: null, edits: { [MAIN]: [after(PATH_WRITE), after(PATH_OPEN), after(PATH_SPAWN), after(PATH_SEND)] }, cases: ['PATH'] },
  // Files
  'fs-gate-off': { kind: 'fs', edits: { [GATE]: FS_GATE_OFF }, cases: ['F1 readdir', 'F1 rename', 'F1 mkdir'] },
  'fs-gate-not-installed': { kind: 'fs', edits: { [MAIN]: [["require('./effect-gate').installEffectGate();\n", '']] }, cases: ['F1 readdir', 'F1 rename', 'F1 mkdir'] },
  'fs-path-bypass': { kind: 'fs', edits: { [MAIN]: [after(PATH_WRITE_BYPASS)] }, cases: ['PATH'] },
  // Round 11: numeric open flags. The gate classifying only flag strings
  // again (F6), and opens past the gate that the oracle must count on its
  // own (F7) - the content check before the resumption must see them too.
  'fs-open-flags-string-only': { kind: 'fs', edits: { [GATE]: OPEN_FLAGS_STRING_ONLY, [MAIN]: [after(PATH_OPEN)] }, cases: ['PATH'] },
  'fs-open-trunc-bypass': { kind: 'fs', also: [/content changed after the change: .*c1\/metadata\.json/], edits: { [MAIN]: [after(PATH_OPEN_TRUNC_BYPASS)] }, cases: ['PATH'] },
  'fs-attr-bypass': { kind: 'fs', also: [/attributes changed after the change: .*c1\/metadata\.json/], edits: { [MAIN]: [after(PATH_ATTR_BYPASS)] }, cases: ['PATH'] },
  'fs-open-creat-bypass': { kind: 'fs', also: [/files created after the change: .*c1\/merge-created\.txt/], edits: { [MAIN]: [after(PATH_OPEN_CREAT_BYPASS)] }, cases: ['PATH'] },
  // Child processes
  'spawn-gate-off': { kind: 'spawn', edits: { [GATE]: SPAWN_GATE_OFF }, cases: ['F3 ffprobe', 'F3 read'] },
  'spawn-path-bypass': { kind: 'spawn', edits: { [MAIN]: [after(PATH_SPAWN_BYPASS)] }, cases: ['PATH'] },
  // Round 13: the scope without alive(), without its context; a context lost; a
  // file outside the folder; an app service in the session's context.
  'alive-removed': { kind: 'fs', edits: { [SCOPE]: [['const alive = () => !over && authority.isCurrent(ticket) && authority.tokenAllowed();', 'const alive = () => true;']] }, cases: ['F1 rename'] },
  'gated-removed': { kind: 'fs', edits: { [SCOPE]: [['return runInSession({ assertAlive }, fn);', 'return fn();']] }, cases: ['F1 rename'] },
  'fs-context-lost': { kind: 'fs', also: [/files created after the change: .*merge-lost\.txt/], edits: { [MAIN]: [after(PATH_CONTEXT_LOST)] }, cases: ['PATH'] },
  'fs-external-bypass': { kind: 'fs', also: [/content changed after the change: .*app\.log/], edits: { [MAIN]: [after(PATH_EXTERNAL_BYPASS)] }, cases: ['PATH'] },
  'lazy-app-service': { kind: 'service', edits: { [MAIN]: [after(PATH_LAZY_SERVICE)] }, cases: ['PATH'] },
  // Round 13: the contract itself (effectGate.contract.test.js in a child
  // process): `red` must be among its failing tests.
  'bind-removed': { probe: 'contract', red: /P2: a listener of session A/, edits: { [GATE]: [['function bindSession(fn, fail = null) {\n  if (!publishGate.getStore()) return fn;', 'function bindSession(fn, fail = null) {\n  return fn;']] } },
  'free-exit': { probe: 'contract', red: /the context is not exported/, edits: { [GATE]: [['module.exports = { runInSession,', 'module.exports = { publishGate, runInSession,']] } },
  'port-with-path': { probe: 'contract', red: /a path is only text/, edits: { [APP_PORTS]: [["sealPort('appLog', (level, text) => logData(text, { level }))", "sealPort('appLog', (level, text) => require('fs').writeFileSync(text, 'X'))"]] } },
  'cp-admitted': { probe: 'contract', red: /cp with a delayed filter \(living session\)/, edits: { [GATE]: [["  if (name === 'cp') return true;\n", '']] } },
  'temp-by-pattern': { probe: 'contract', red: /the name pattern alone earns nothing/, edits: { [GATE]: TEMP_BY_PATTERN } },
  'temp-many': { probe: 'contract', red: /earns one unlink of its exact string/, edits: { [GATE]: TEMP_MANY } },
  'stat-in-fast-path': { probe: 'contract', red: /no extra system call per open/, edits: { [GATE]: STAT_IN_FAST_PATH } },
  // Renderer events
  'send-gate-off': { kind: 'send', edits: { [MAIN]: [after(PATH_SEND), ...SEND_GATE_OFF] }, cases: ['PATH'] },
  'send-path-bypass': { kind: 'send', edits: { [MAIN]: [after(PATH_SEND_BYPASS)] }, cases: ['PATH'] },
};

/** The violation text of each kind (support/sweep.js afterChange). */
export const KIND_PATTERN = { fs: /effects after the change/, spawn: /child processes after the change/, send: /events after the change/, service: /an app service started in the session context/ };

/**
 * The source of `file` (repo-relative, forward slashes) under the mutant
 * `name`; unchanged without one. An edit that does not apply throws: a
 * mutant that changes nothing would pass vacuously.
 */
export function mutate(file, source, name = process.env.SWEEP_MUTANT) {
  if (!name) return source;
  const mutant = MUTANTS[name];
  if (!mutant) throw new Error(`unknown mutant ${name}`);
  let out = source;
  for (const [from, to] of mutant.edits[file] || []) {
    if (!out.includes(from)) throw new Error(`mutant ${name}: edit not found in ${file}: ${from.slice(0, 80)}`);
    out = out.replace(from, to);
  }
  return out;
}
