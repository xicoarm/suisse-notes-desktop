// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// Review round 9 (council 3, R-S2): main's background work lives in
// src-electron/background/ and reaches effects only through its
// SessionScope. The ticket audit of round 8 (support/e7Audit.js, `// E7:`
// markers) is gone with the code it audited.

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
