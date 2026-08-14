/**
 * Build the Windows system-audio loopback helper (resources/sysloopback).
 *
 * Compiles with the IN-BOX .NET Framework compiler that ships with every
 * Windows 10/11 and with GitHub's windows-latest runners — no Visual Studio,
 * no MSVC, no .NET SDK, nothing to install on a dev machine or in CI.
 *
 * That compiler is the legacy C# 5 one, so SysLoopback.cs deliberately avoids
 * C# 6+ syntax (no string interpolation, no digit separators, no `?.`).
 *
 * No-ops on non-Windows so `npm run build` stays portable; the committed exe is
 * used as-is when the compiler is unavailable.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'resources', 'sysloopback', 'src', 'SysLoopback.cs');
const OUT_DIR = path.join(ROOT, 'resources', 'sysloopback', 'win-x64');
const OUT_EXE = path.join(OUT_DIR, 'sysloopback.exe');

function findCsc() {
  const base = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64');
  if (!fs.existsSync(base)) return null;
  // Highest vN.N.N directory that actually contains csc.exe.
  const candidates = fs.readdirSync(base)
    .filter(d => /^v\d/.test(d))
    .sort()
    .reverse()
    .map(d => path.join(base, d, 'csc.exe'))
    .filter(p => fs.existsSync(p));
  return candidates[0] || null;
}

function main() {
  if (process.platform !== 'win32') {
    console.log('[sysloopback] not Windows — skipping (committed exe is used as-is)');
    return;
  }
  const csc = findCsc();
  if (!csc) {
    if (fs.existsSync(OUT_EXE)) {
      console.log('[sysloopback] no in-box csc.exe found — keeping the committed exe');
      return;
    }
    throw new Error('[sysloopback] no csc.exe and no prebuilt exe — cannot produce the helper');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[sysloopback] compiling with ${csc}`);
  execFileSync(csc, [
    '-nologo', '-optimize+', '-unsafe+', '-platform:x64', '-target:exe',
    `-out:${OUT_EXE}`,
    SRC,
  ], { stdio: 'inherit' });

  const size = fs.statSync(OUT_EXE).size;
  console.log(`[sysloopback] built ${path.relative(ROOT, OUT_EXE)} (${size} bytes)`);

  // Smoke-test the produced binary. NOT fatal: CI runners are headless and have
  // no audio endpoints at all, so "no default endpoint" is expected there and
  // must never break a release build. On a real machine it is a useful signal.
  try {
    const out = execFileSync(OUT_EXE, ['--list'], { encoding: 'utf8', timeout: 20000 });
    if (/"event":"default"/.test(out)) console.log('[sysloopback] smoke test OK');
    else console.log('[sysloopback] smoke test: binary ran but found no endpoints (expected on headless CI)');
  } catch (e) {
    console.log(`[sysloopback] smoke test could not run (${e.message}) — continuing`);
  }
}

main();
