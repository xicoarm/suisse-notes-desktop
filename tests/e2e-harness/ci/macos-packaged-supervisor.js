'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, writeJson, sha256, childEnvironment } = require('../lib/macos-packaged');
const { readProcesses, claimGroup, validateGroup } = require('./macos-packaged-groups');

async function sourceManifest(root) {
  const result = await run('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1024 ** 2 });
  const entries = [];
  for (const relative of result.stdout.split('\0').filter(Boolean).sort()) entries.push({ path: relative, sha256: await sha256(path.join(root, relative)) });
  return entries;
}

async function toolchainManifest() {
  const files = [process.execPath, require('@ffmpeg-installer/ffmpeg').path, require('@ffprobe-installer/ffprobe').path];
  return Promise.all(files.map(async file => ({ path: file, sha256: await sha256(file) })));
}

function assertEvidenceDirectory(directory, prefix, work) {
  if (!directory || path.dirname(path.resolve(directory)) !== path.resolve(work) || !path.basename(directory).startsWith(prefix) ||
      fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Invalid owned qualification evidence directory');
}

async function stopGroups(claims, { readTable = readProcesses, kill = process.kill } = {}) {
  if (new Set(claims.map(claim => claim.pid)).size !== claims.length) throw new Error('Duplicate owned process group identity');
  const before = await readTable(), signalled = [];
  for (const claim of claims) validateGroup(before, claim);
  for (const claim of [...claims].reverse()) {
    if (!validateGroup(before, claim).some(row => !row.state.startsWith('Z'))) continue;
    try { kill(-claim.pid, 'SIGKILL'); signalled.push(claim.pid); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    const after = await readTable();
    const remaining = claims.flatMap(claim => validateGroup(after, claim));
    if (remaining.every(row => row.state.startsWith('Z'))) return { signalled, remaining, liveProcesses: 0 };
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Owned process groups remain alive after bounded cleanup');
}

async function supervise(script, args, { root, directory, timeoutMs, env = childEnvironment(), expectedDetachedExecutable = null,
  spawnProcess = spawn, readTable = readProcesses, stopTree = stopGroups } = {}) {
  const child = spawnProcess(process.execPath, [script, '--worker', ...args], { cwd: root, env,
    detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let timedOut = false, failure = null, cleanupError = null, cleanupPromise = null, terminal = false;
  let finishExit, finishClose, finishIpc;
  const claims = [], registrations = [], pendingIds = new Set();
  const exitPromise = new Promise(resolve => { finishExit = resolve; });
  const closePromise = new Promise(resolve => { finishClose = resolve; });
  const ipcPromise = new Promise(resolve => { finishIpc = resolve; });
  const save = (file, value) => {
    try { writeJson(path.join(directory, file), value); }
    catch (error) { failure ||= 'Diagnostic persistence failed: ' + error.message; }
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      // Stop the exact worker first: it must not spawn another detached group
      // while ownership messages and their bounded ps snapshots are draining.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      let ipcTimer;
      await Promise.race([ipcPromise, new Promise(resolve => { ipcTimer = setTimeout(() => {
        cleanupError ||= 'Worker IPC did not drain before cleanup'; resolve();
      }, 500); })]).finally(() => clearTimeout(ipcTimer));
      let consumed = 0;
      while (consumed < registrations.length) {
        const batch = registrations.slice(consumed); consumed = registrations.length;
        await Promise.allSettled(batch);
      }
      if (expectedDetachedExecutable && claims.filter(claim => claim.pid !== child.pid).length !== 1) {
        cleanupError ||= 'Exactly one owned packaged app group was not registered';
      }
      try { save('process-cleanup.json', { claims, ...await stopTree(claims, { readTable }) }); }
      catch (error) { cleanupError ||= error.message; save('process-cleanup.json', { claims, error: cleanupError }); }
    })();
    return cleanupPromise;
  };
  const stop = reason => {
    failure ||= reason;
    if (terminal) return;
    terminal = true;
    void cleanup().finally(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      finishExit({ code: child.exitCode, signal: child.signalCode, forcedCompletion: true });
    });
  };
  child.once('spawn', () => {
    // Hold the worker until its process group birth is recorded. Its descendants
    // can retain pipes after exit, so completion below waits on exit, not close.
    const task = (async () => {
      try {
        claims.push(claimGroup(await readTable(), child.pid, process.pid));
        save('process-groups.json', { claims });
        if (!failure) child.send({ type: 'packaged-supervisor-ready' }); else stop(failure);
      } catch (error) { cleanupError ||= error.message; stop('Worker process ownership was not established'); }
    })();
    registrations.push(task);
  });
  child.on('message', message => {
    if (message?.type !== 'packaged-owned-group') return;
    const task = (async () => {
      if (!Number.isSafeInteger(message.pid) || message.pid <= 0 || pendingIds.has(message.pid) || claims.some(claim => claim.pid === message.pid)) throw new Error('Unexpected detached child registration');
      pendingIds.add(message.pid);
      const rows = await readTable();
      const workerBirth = child.exitCode !== null || child.signalCode !== null ? claims.find(claim => claim.pid === child.pid)?.birth : null;
      claims.push(claimGroup(rows, message.pid, child.pid, workerBirth));
      save('process-groups.json', { claims });
      if (message.executable !== expectedDetachedExecutable) throw new Error('Unexpected detached executable');
      if (failure) stop(failure);
    })().catch(error => { cleanupError ||= error.message; stop('Detached process ownership was not established'); });
    registrations.push(task);
  });
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream.on('data', bytes => {
      try { fs.appendFileSync(path.join(directory, name + '.log'), bytes); }
      catch (error) { stop('Diagnostic log write failed: ' + error.message); }
      // Keep draining even if diagnostic storage failed; cleanup must still run.
    });
  }
  child.once('error', error => { failure ||= error.message; finishExit({ code: null, signal: null, spawnError: error.message }); });
  child.once('exit', (code, signal) => finishExit({ code, signal }));
  child.once('close', () => finishClose());
  child.once('disconnect', () => finishIpc());
  const timer = setTimeout(() => { timedOut = true; stop('Packaged worker exceeded its deadline'); }, timeoutMs);
  const exit = await exitPromise;
  clearTimeout(timer); terminal = true;
  await cleanup();
  let pipeTimer;
  await Promise.race([closePromise, new Promise(resolve => { pipeTimer = setTimeout(() => {
    failure ||= 'Owned worker pipes did not close after process cleanup';
    child.stdout.destroy(); child.stderr.destroy();
    if (child.connected) child.disconnect();
    resolve();
  }, 2000); })]).finally(() => clearTimeout(pipeTimer));
  const result = { ...exit, timedOut, cleanupError, failure, claims, cleanupVerified: !cleanupError && claims.length > 0, finishedAt: new Date().toISOString() };
  save('exit.json', result); result.failure = failure;
  return result;
}

function waitForSupervisor() {
  if (typeof process.send !== 'function') return Promise.reject(new Error('Worker requires owned supervisor IPC'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Supervisor ownership handshake timed out')), 10000);
    process.once('message', message => {
      clearTimeout(timeout);
      if (message?.type !== 'packaged-supervisor-ready') reject(new Error('Invalid supervisor ownership handshake'));
      else resolve();
    });
  });
}

async function archive(directory, output) {
  await run('/usr/bin/tar', ['-cf', output, '-C', path.dirname(directory), path.basename(directory)], { timeout: 30000 });
  return { file: output, sha256: await sha256(output), bytes: fs.statSync(output).size };
}

function parseArguments(args, names) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--worker') { result.worker = true; continue; }
    const name = args[i].slice(2);
    if (!args[i].startsWith('--') || !names.includes(name) || Object.hasOwn(result, name) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid qualification arguments');
    result[name] = args[++i];
  }
  return result;
}

module.exports = { sourceManifest, toolchainManifest, assertEvidenceDirectory, stopGroups, supervise, waitForSupervisor, archive, parseArguments };
