// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { auditBackgroundSource, auditMainWiring, BANNED_MODULES } from './support/backgroundBan.js';

// Review round 9 (council 3, R-S2, required test 3): main's background work
// lives in src-electron/background/ and reaches effects only through its
// SessionScope. Static ban list (support/backgroundBan.js) with negative
// mutation tests: each form (direct, alias, chained, dynamic) inserted into
// a copy is a finding. The ticket walker of round 8 (support/e7Audit.js,
// `// E7:` markers) is deleted; its bypasses are among the mutations.

const require = createRequire(import.meta.url);
const espree = require('espree');
const MAIN = fs.readFileSync(path.resolve('src-electron/electron-main.js'), 'utf8');
const AST = espree.parse(MAIN, { ecmaVersion: 'latest', sourceType: 'script' });

const MOVED = ['saveUploadOutcome', 'sessionEndedVerification', 'verifyAcceptedUpload', 'updateUploadQueueRetry',
  'recoverOrphanedRecordings', 'combineChunksForRecovery', 'cleanupOldOrphanedDirectories', 'refreshMainAuthToken',
  'tokenFor', 'sessionEndedResult', 'pollServerStatus', 'pollMeetingTranscriptionStatus', 'uploadWithRetry',
  'tryDirectUpload', 'uploadWithRetryLegacy', 'rmDirSafeBestEffort', 'processPendingUploadsRun'];

function topLevelNames(ast) {
  const names = new Set();
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration') names.add(node.id.name);
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) if (d.id.type === 'Identifier') names.add(d.id.name);
  }
  return names;
}

describe('main background moved into src-electron/background (round 9, P3)', () => {
  it('main defines none of the moved background functions', () => {
    const names = topLevelNames(AST);
    expect(MOVED.filter((n) => names.has(n))).toEqual([]);
  });

  it('main no longer requires the direct upload module or tus-js-client', () => {
    expect(MAIN).not.toMatch(/require\(['"]\.\/upload-direct['"]\)/);
    expect(MAIN).not.toMatch(/tus-js-client/);
  });

  it('control: the walker finds a top-level function', () => {
    const ast = espree.parse('function uploadWithRetry() {}\nconst tokenFor = () => 1;', { ecmaVersion: 'latest' });
    expect(MOVED.filter((n) => topLevelNames(ast).has(n))).toEqual(['tokenFor', 'uploadWithRetry']);
  });
});

const BACKGROUND_DIR = path.resolve('src-electron/background');
const FILES = fs.readdirSync(BACKGROUND_DIR).filter((f) => f.endsWith('.js'));

describe('IPC channels after the move (round 9)', () => {
  // The move must not drop a channel the preload still exposes (CI caught
  // recording:isRecoveryRunning missing: the renderer could not start a
  // recording). Only the TUS channels are deleted on purpose (P1).
  const channels = (src) => new Set([...src.matchAll(/ipcMain\.(?:handle|on|once)\(['"]([^'"]+)['"]/g)].map((m) => m[1]));
  const invoked = (src) => new Set([...src.matchAll(/ipcRenderer\.(?:invoke|send|sendSync)\(['"]([^'"]+)['"]/g)].map((m) => m[1]));

  it('every channel the preload invokes or sends has a handler in main', () => {
    const preload = fs.readFileSync(path.resolve('src-electron/electron-preload.js'), 'utf8');
    const handled = new Set();
    for (const f of fs.readdirSync(path.resolve('src-electron'), { recursive: true })) {
      if (String(f).endsWith('.js')) for (const c of channels(fs.readFileSync(path.resolve('src-electron', String(f)), 'utf8'))) handled.add(c);
    }
    // Registered in a loop: for (const operation of [...]) ipcMain.handle(`recording:${operation}`, ...)
    for (const m of MAIN.matchAll(/for \(const operation of \[([^\]]+)\]\) \{\s*ipcMain\.handle\(`recording:\$\{operation\}`/g)) {
      for (const name of m[1].matchAll(/'([^']+)'/g)) handled.add(`recording:${name[1]}`);
    }
    expect([...invoked(preload)].filter((c) => !handled.has(c))).toEqual([]);
  });
});

describe('ban list for src-electron/background/** (R-S2)', () => {
  it('the folder holds the moved modules', () => {
    expect(FILES.sort()).toEqual(['ended.js', 'index.js', 'pending-uploads.js', 'queue-ops.js', 'recovery.js', 'upload-direct.js', 'upload.js']);
  });

  it.each(FILES)('%s: no banned module, identifier, module-system or evaluator use', (file) => {
    expect(auditBackgroundSource(fs.readFileSync(path.join(BACKGROUND_DIR, file), 'utf8'))).toEqual([]);
  });

  it('main: the factory gets only allowed keys and no store, window, IPC or HTTP client; every background call passes a scope', () => {
    const { findings, backgroundCalls } = auditMainWiring(MAIN, { allowedKeys: ['config', 'read', 'pure', 'report', 'hooks', 'log'] });
    expect(findings).toEqual([]);
    expect(backgroundCalls).toBeGreaterThanOrEqual(6);
  });

  it('no other file outside background/ requires the moved modules (only the factory and the pure queue mutators)', () => {
    const offenders = [];
    for (const dir of ['src-electron', 'src']) {
      const stack = [path.resolve(dir)];
      while (stack.length) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) { if (full !== BACKGROUND_DIR && entry.name !== 'node_modules') stack.push(full); continue; }
          if (!/\.(js|cjs|mjs|ts|vue)$/.test(entry.name)) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (/require\(['"]\.\/background\/(?!index|queue-ops)/.test(text)) offenders.push(path.relative(process.cwd(), full));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ban list: negative mutation tests (each form inserted into a copy is red)', () => {
  const original = fs.readFileSync(path.join(BACKGROUND_DIR, 'upload.js'), 'utf8');
  const insert = (snippet) => original.replace("const queueOps = require('./queue-ops');", `const queueOps = require('./queue-ops');\n${snippet}\n`);
  const FORMS = {
    direct: [
      ...BANNED_MODULES.map((m) => `require('${m}');`),
      "require('os');",
      'historyStore.set("recordings", []);', 'uploadQueueStore.set("pendingUploads", []);', 'activeRecordingStore.delete("activeSession");',
      "mainWindow.webContents.send('x');", "ipcMain.handle('x', () => {});", "axios.post('u');",
    ],
    alias: [
      'const r = require; r("fs");', 'const { require: q } = module; q("fs");', 'const m = module; m.require("fs");',
      'const g = globalThis; g.fetch("u");', 'const p = process; p.mainModule;', 'const send = mainWindow;',
      'function f(cb = require) { return cb("fs"); }', 'const store = { h: historyStore };',
    ],
    chained: [
      "require('fs').promises.writeFile('x', 'y');", "module.require('fs');", "process.mainModule.require('fs');",
      "require.main.require('fs');", "require.cache;", "module.constructor._load('fs');", "global.process.exit();",
      "require('electron').ipcMain;",
    ],
    dynamic: [
      "require('f' + 's');", 'require(`fs`);', "const n = 'fs'; require(n);", "import('fs');",
      "module['req' + 'uire']('fs');", "module['require']('fs');", "globalThis['require'];", "process['main' + 'Module'];",
      "eval(\"require('fs')\");", "new Function('return require')();", "require(...['fs']);",
    ],
  };

  it('the unmutated copy is clean (control)', () => {
    expect(auditBackgroundSource(insert(''))).toEqual([]);
  });

  for (const [form, snippets] of Object.entries(FORMS)) {
    it.each(snippets)(`${form}: %s`, (snippet) => {
      expect(auditBackgroundSource(insert(snippet)).length, snippet).toBeGreaterThan(0);
    });
  }

  it('main wiring: a store, the window or a disallowed key in the factory call is red', () => {
    const base = MAIN;
    const anchor = '  hooks: { onBusyChange: () => updateRecordingPowerBlocker() },';
    expect(base.includes(anchor)).toBe(true);
    for (const extra of ['  store: historyStore,', '  win: () => mainWindow,', '  http: axios,', '  registry: scopes,']) {
      expect(auditMainWiring(base.replace(anchor, `${anchor}\n${extra}`), { allowedKeys: ['config', 'read', 'pure', 'report', 'hooks', 'log'] }).findings.length, extra).toBeGreaterThan(0);
    }
    const unscoped = base.replace('background.recovery.isRunning()', 'background.uploads.pollServerStatus(audioFileId)');
    expect(auditMainWiring(unscoped, { allowedKeys: ['config', 'read', 'pure', 'report', 'hooks', 'log'] }).findings.length).toBeGreaterThan(0);
  });
});
