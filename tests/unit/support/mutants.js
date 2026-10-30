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

const PUBLISHED = '    await publishFile(mergedPath, micPath);\n';
const after = (line) => [PUBLISHED, `${PUBLISHED}${line}\n`];
const PATH_WRITE = "    fs.writeFileSync(path.join(recordPath, 'merge-note.txt'), 'merged');";
const PATH_WRITE_BYPASS = "    globalThis.__sweepPreGate.fs.writeFileSync(path.join(recordPath, 'merge-note.txt'), 'merged');";
const PATH_SPAWN = "    require('child_process').execFile(resolveBundledBinaryPaths().ffprobe, ['-version'], () => {});";
const PATH_SPAWN_BYPASS = "    globalThis.__sweepPreGate.cp.execFile(resolveBundledBinaryPaths().ffprobe, ['-version'], () => {});";
// Round 11 (F6/F7): numeric open flags. Through the sink: a new file opened
// with O_WRONLY|O_CREAT|O_TRUNC and written. Past it: O_TRUNC empties the
// existing metadata.json at the open; O_CREAT creates a file without a write.
const PATH_OPEN = "    { const fd = fs.openSync(path.join(recordPath, 'merge-open.txt'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC); fs.writeSync(fd, 'merged'); fs.closeSync(fd); }";
const PATH_OPEN_TRUNC_BYPASS = "    { const pre = globalThis.__sweepPreGate.fs; pre.closeSync(pre.openSync(path.join(recordPath, 'metadata.json'), fs.constants.O_WRONLY | fs.constants.O_TRUNC)); }";
const PATH_OPEN_CREAT_BYPASS = "    { const pre = globalThis.__sweepPreGate.fs; pre.closeSync(pre.openSync(path.join(recordPath, 'merge-created.txt'), fs.constants.O_WRONLY | fs.constants.O_CREAT)); }";
const PATH_SEND = "    sendToRenderer('system:capture-warning', { kind: 'merged', recordId });";
const PATH_SEND_BYPASS = "    mainWindow.webContents.send('system:capture-warning', { kind: 'merged', recordId });";

const FS_GATE_OFF = [
  ['      if (concerns(base, args)) { const error = refusal(); if (error) throw error; }\n', ''],
  ['      if (concerns(name, args)) {\n        const error = refusal();\n        if (error) { process.nextTick(callback, error); return undefined; }\n      }\n', ''],
  ['      if (concerns(name, args)) { const error = refusal(); if (error) return Promise.reject(error); }\n', ''],
  ['          const error = refusal();\n          if (error) return Promise.reject(error);\n', ''],
];
const SPAWN_GATE_OFF = [
  ['      const error = refusal();\n      if (error) return refusedChild(', '      const error = null;\n      if (error) return refusedChild('],
  ['      const error = refusal();\n      if (error) throw error;\n      return original.apply(this, args);', '      return original.apply(this, args);'],
];
// The gate of round 10: flags as a string only (a number is read as digits).
const OPEN_FLAGS_STRING_ONLY = [
  ['function writeFlags(flags) {\n', 'function writeFlags(flags) {\n  return /[wa+]/.test(String(flags ?? \'r\'));\n'],
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
  'fs-gate-not-installed': { kind: 'fs', edits: { [MAIN]: [["require('./effect-gate').installEffectGate({ roots: () => [getRecordingsPath()] });\n", '']] }, cases: ['F1 readdir', 'F1 rename', 'F1 mkdir'] },
  'fs-path-bypass': { kind: 'fs', edits: { [MAIN]: [after(PATH_WRITE_BYPASS)] }, cases: ['PATH'] },
  // Round 11: numeric open flags. The gate classifying only flag strings
  // again (F6), and opens past the gate that the oracle must count on its
  // own (F7) - the content check before the resumption must see them too.
  'fs-open-flags-string-only': { kind: 'fs', edits: { [GATE]: OPEN_FLAGS_STRING_ONLY, [MAIN]: [after(PATH_OPEN)] }, cases: ['PATH'] },
  'fs-open-trunc-bypass': { kind: 'fs', also: [/content changed after the change: .*c1\/metadata\.json/], edits: { [MAIN]: [after(PATH_OPEN_TRUNC_BYPASS)] }, cases: ['PATH'] },
  'fs-open-creat-bypass': { kind: 'fs', also: [/files created after the change: .*c1\/merge-created\.txt/], edits: { [MAIN]: [after(PATH_OPEN_CREAT_BYPASS)] }, cases: ['PATH'] },
  // Child processes
  'spawn-gate-off': { kind: 'spawn', edits: { [GATE]: SPAWN_GATE_OFF }, cases: ['F3 ffprobe', 'F3 read'] },
  'spawn-path-bypass': { kind: 'spawn', edits: { [MAIN]: [after(PATH_SPAWN_BYPASS)] }, cases: ['PATH'] },
  // Renderer events
  'send-gate-off': { kind: 'send', edits: { [MAIN]: [after(PATH_SEND), ...SEND_GATE_OFF] }, cases: ['PATH'] },
  'send-path-bypass': { kind: 'send', edits: { [MAIN]: [after(PATH_SEND_BYPASS)] }, cases: ['PATH'] },
};

/** The violation text of each kind (support/sweep.js afterChange). */
export const KIND_PATTERN = { fs: /effects after the change/, spawn: /child processes after the change/, send: /events after the change/ };

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
