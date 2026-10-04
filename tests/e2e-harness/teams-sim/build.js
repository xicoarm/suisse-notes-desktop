/**
 * Build the Teams stand-in (TeamsSim.cs) into work/teams-sim/ms-teams-sim.exe.
 *
 * Same in-box .NET Framework compiler as scripts/build-sysloopback.js: nothing to
 * install on a dev machine or a hosted runner. The exe name matters — the desktop
 * app recognises Teams by a process name starting with "ms-teams".
 * Rebuilt only when the source changed; the binary is never committed.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, 'TeamsSim.cs');
const OUT_DIR = path.join(__dirname, '..', 'work', 'teams-sim');
const OUT_EXE = path.join(OUT_DIR, 'ms-teams-sim.exe');
const STAMP = path.join(OUT_DIR, 'source.sha256');

function findCsc() {
  const base = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
  if (!fs.existsSync(base)) return null;
  return fs.readdirSync(base)
    .filter(d => /^v\d/.test(d))
    .sort()
    .reverse()
    .map(d => path.join(base, d, 'csc.exe'))
    .find(p => fs.existsSync(p)) || null;
}

function buildTeamsSim() {
  if (process.platform !== 'win32') throw new Error('The Teams stand-in is Windows-only');
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(SRC)).digest('hex');
  if (fs.existsSync(OUT_EXE) && fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8') === sourceHash) return OUT_EXE;
  const csc = findCsc();
  if (!csc) throw new Error('No in-box csc.exe found (.NET Framework 4.x)');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execFileSync(csc, ['-nologo', '-optimize+', '-platform:x64', '-target:exe', `-out:${OUT_EXE}`, SRC],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  fs.writeFileSync(STAMP, sourceHash);
  return OUT_EXE;
}

module.exports = { buildTeamsSim, OUT_EXE };

if (require.main === module) console.log(buildTeamsSim());
