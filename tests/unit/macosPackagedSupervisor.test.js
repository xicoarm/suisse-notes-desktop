// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { supervise, parseArguments, assertEvidenceDirectory } = require('../e2e-harness/ci/macos-packaged-supervisor');
const { quasarCli } = require('../e2e-harness/ci/build-macos-packaged');
const temporary = [];
function directory() {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'macos-packaged-supervisor-unit-')));
  temporary.push(value); return value;
}
afterEach(() => {
  for (const value of temporary.splice(0)) {
    const resolved = path.resolve(value);
    if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('macos-packaged-supervisor-unit-')) throw new Error('Unsafe test cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe('packaged supervisor ownership and failure evidence', () => {
  it('resolves the actual locked Quasar CLI through its exported manifest without building', () => {
    expect(fs.statSync(quasarCli()).isFile()).toBe(true);
    expect(path.basename(quasarCli())).toBe('quasar.js');
  });
  it('accepts only named complete arguments and preserves worker mode', () => {
    expect(parseArguments(['--arch', 'arm64', '--worker'], ['arch'])).toEqual({ arch: 'arm64', worker: true });
    for (const args of [['--arch'], ['arch', 'arm64'], ['--app', '/tmp'], ['--arch', 'arm64', '--arch', 'x64']]) {
      expect(() => parseArguments(args, ['arch'])).toThrow();
    }
  });
  it('rejects sibling and wrong-prefix evidence directories before writing', () => {
    const root = directory(), owned = path.join(root, 'build-owned'); fs.mkdirSync(owned);
    expect(() => assertEvidenceDirectory(owned, 'build-', root)).not.toThrow();
    expect(() => assertEvidenceDirectory(root, 'build-', root)).toThrow();
    expect(() => assertEvidenceDirectory(owned, 'run-', root)).toThrow();
    expect(() => assertEvidenceDirectory(path.join(root, '..', 'outside'), 'build-', root)).toThrow();
  });
  it.skipIf(process.platform === 'win32')('runs a real owned child and retains its nonzero exit and emitted evidence', async () => {
    const root = directory(), script = path.join(root, 'worker.cjs');
    fs.writeFileSync(script, "process.once('message',()=>{ console.log('synthetic-worker-evidence'); process.disconnect(); process.exitCode=7; });");
    const result = await supervise(script, [], { root, directory: root, timeoutMs: 4000 });
    expect(result).toMatchObject({ code: 7, timedOut: false, cleanupError: null, cleanupVerified: true });
    expect(fs.readFileSync(path.join(root, 'stdout.log'), 'utf8')).toContain('synthetic-worker-evidence');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'exit.json'))).code).toBe(7);
  });
  it.skipIf(process.platform === 'win32')('terminates a real owned nested child on deadline and keeps the partial evidence', async () => {
    const root = directory(), script = path.join(root, 'worker.cjs');
    fs.writeFileSync(script, `process.once('message',()=>{ const {spawn}=require('child_process'); const fs=require('fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
      fs.writeFileSync(${JSON.stringify(path.join(root, 'owned-pid.json'))},JSON.stringify({pid:child.pid}));
      setInterval(()=>{},1000); });`);
    const result = await supervise(script, [], { root, directory: root, timeoutMs: 750 });
    expect(result.timedOut).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'owned-pid.json'))).pid).toBeGreaterThan(0);
    const cleanup = JSON.parse(fs.readFileSync(path.join(root, 'process-cleanup.json')));
    expect(cleanup.signalled).toContain(cleanup.claims[0].pid);
    expect(cleanup.liveProcesses).toBe(0);
    expect(result.cleanupVerified).toBe(true);
  });
});

describe('packaged pre-record attestation hook', () => {
  it('fails before startRecording and still closes the mock and preserves the profile', async () => {
    const root = directory(), calls = [];
    class Driver {
      async launch() { calls.push('launch'); }
      async login() { calls.push('login'); }
      async evalTimed() { return 'http://localhost:3000'; }
      async startRecording() { throw new Error('should never capture'); }
      async close(options) { calls.push(['close', options]); }
    }
    const module = { exports: {} }, nativeRequire = require;
    const fakeRequire = name => {
      if (name === './lib/app-driver') return { AppDriver: Driver };
      if (name === './lib/mock-backend') return { startMockBackend: async () => ({ url: 'http://localhost:3000', close: async () => calls.push('mock-close') }) };
      if (name === './lib/audio') return { WORK_DIR: root, buildCodedScenario: () => ({ wavPath: 'fake.wav', metaPath: 'fake.json' }) };
      if (['./lib/coded-audio', './lib/native-recorder-evidence', './lib/native-timestamps',
        '../../src-electron/native-source-persistence', '../../src-electron/durable-files'].includes(name)) return {};
      return nativeRequire(name);
    };
    vm.runInNewContext(fs.readFileSync(path.resolve('tests/e2e-harness/qualification.js'), 'utf8'), { require: fakeRequire, module, console, process: { env: {} } });
    const result = await module.exports.captureCase('baseline', 45, { beforeRecording: async () => { calls.push('attest'); throw new Error('wrong packaged identity'); } });
    expect(result.pass).toBe(false);
    expect(result.problems.join(' ')).toContain('wrong packaged identity');
    expect(calls).toEqual(['launch', 'login', 'attest', ['close', { keepProfile: true }], 'mock-close']);
  });
});
