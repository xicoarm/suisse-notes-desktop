'use strict';

const childProcess = require('child_process');
const { run, childEnvironment } = require('../lib/macos-packaged');

function parseProcesses(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/), [pid, ppid, pgid] = parts.splice(0, 3).map(Number);
    const state = parts.shift(), birth = parts.splice(0, 5).join(' ');
    if (pid === 0) return null; // macOS kernel_task is not a signal target.
    // Linux kernel threads and namespace init may legitimately have PGID 0.
    // Keep those rows in the snapshot; only positive PID=PGID leaders are owned.
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid < 0 ||
        !Number.isSafeInteger(ppid) || ppid < 0 || !state || !Number.isFinite(Date.parse(birth))) throw new Error('Invalid process ownership snapshot');
    return { pid, ppid, pgid, state, birth };
  }).filter(Boolean);
}

async function readProcesses() {
  return parseProcesses((await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    { env: { ...childEnvironment(), LC_ALL: 'C' }, timeout: 5000 })).stdout);
}

function claimGroup(rows, pid, parentPid, orphanedParentBirth = null) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process group identity');
  const leader = rows.find(row => row.pid === pid);
  const orphan = leader?.ppid === 1 && orphanedParentBirth && Date.parse(leader.birth) >= Date.parse(orphanedParentBirth);
  if (!leader || (!orphan && leader.ppid !== parentPid) || leader.pgid !== pid) throw new Error('Spawned process group ownership was not established');
  return { pid, birth: leader.birth };
}

function validateGroup(rows, claim) {
  if (!claim || !Number.isSafeInteger(claim.pid) || claim.pid <= 0 || !Number.isFinite(Date.parse(claim.birth))) throw new Error('Invalid owned process group identity');
  const leader = rows.find(row => row.pid === claim.pid);
  if (leader && (leader.pgid !== claim.pid || leader.birth !== claim.birth)) throw new Error('Owned process group leader identity changed');
  const members = rows.filter(row => row.pgid === claim.pid);
  if (members.some(row => Date.parse(row.birth) < Date.parse(claim.birth))) throw new Error('Owned process group contains an older unrelated process');
  return members;
}

function reportDetachedSpawns() {
  if (typeof process.send !== 'function') throw new Error('Packaged worker requires its owned IPC channel');
  const original = childProcess.spawn;
  childProcess.spawn = function (...args) {
    const child = Reflect.apply(original, this, args);
    const options = Array.isArray(args[1]) ? args[2] : args[1];
    if (options?.detached === true) child.once('spawn', () => {
      // This trusted worker reports actual native spawn results immediately,
      // before it waits for CDP/UI; the app does not receive this IPC channel.
      process.send?.({ type: 'packaged-owned-group', pid: child.pid, executable: args[0] });
    });
    return child;
  };
}

module.exports = { parseProcesses, readProcesses, claimGroup, validateGroup, reportDetachedSpawns };
