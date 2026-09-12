'use strict';

// Test-only packaged-app evidence. Never imports Electron or starts capture.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execute = promisify(execFile);
const API_URL = 'http://localhost:3000';
const APP_ID = 'com.suisse-notes.desktop';
const CAPTURE_SECONDS = 45;
const BUILD_MS = 15 * 60 * 1000;
const CAPTURE_MS = 10 * 60 * 1000;
const SCOPE = 'Unsigned packaged path and 45-second synthetic native capture/finalization/local mock upload only. Does not qualify signing, notarization, Gatekeeper, TCC, AudioTee, hardware, production backend, production AudioServiceSandbox, or endurance; historical failures remain open.';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}

function assertArch(arch, platform = process.platform, runtimeArch = process.arch, machine) {
  if (platform !== 'darwin' || !['x64', 'arm64'].includes(arch) || runtimeArch !== arch ||
      (machine !== undefined && machine.trim() !== (arch === 'x64' ? 'x86_64' : 'arm64'))) {
    throw new Error('Packaged qualification requires matching native macOS/Node architecture');
  }
  return arch === 'x64' ? 'x86_64' : 'arm64';
}

function childEnvironment(input = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (/(^|_)(TOKEN|SECRET|PASSWORD|API_KEY)(_|$)/i.test(key) || /^(APPLE_|CSC_)/i.test(key) ||
        /^(SUISSE_|VITE_)/.test(key) || /^GITHUB_(OUTPUT|ENV|PATH|STATE|STEP_SUMMARY)$/.test(key) ||
        ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'API_BASE_URL', 'APP_ENV'].includes(key)) continue;
    env[key] = value;
  }
  return { ...env, API_BASE_URL: API_URL, VITE_API_URL: API_URL, SUISSE_E2E_HOOKS: '1',
    SUISSE_TEST_NETWORK_ISOLATION: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false', HUSKY: '0' };
}

function assertHosted(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || !/^\d+$/.test(env.GITHUB_RUN_ID || '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '')) {
    throw new Error('Packaged qualification is restricted to a disposable GitHub Actions runner');
  }
  if (env.SUISSE_E2E_HOOKS !== '1' || env.SUISSE_TEST_NETWORK_ISOLATION !== '1' ||
      env.API_BASE_URL !== API_URL || env.VITE_API_URL !== API_URL || env.SUISSE_E2E_APP_DIR || env.SUISSE_E2E_PACKAGED_EXE) {
    throw new Error('Packaged qualification requires explicit loopback isolation and no competing app override');
  }
}

function makeBuilderConfig(raw, { root, output, electronVersion }) {
  if (raw?.appId !== APP_ID || !Array.isArray(raw.extraResources) ||
      !raw.extraResources.some(item => item.from === 'resources/ffmpeg/${os}-${arch}' && item.to === 'ffmpeg') ||
      !raw.extraResources.some(item => item.from === 'resources/audiotee' && item.to === 'audiotee')) {
    throw new Error('Unexpected release app identity or resource mapping');
  }
  return { ...raw, electronVersion,
    directories: { buildResources: path.join(root, 'src-electron'), app: path.join(root, 'dist/electron/UnPackaged'), output },
    mac: { ...raw.mac, identity: null, forceCodeSigning: false, notarize: false } };
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a regular non-symlink file: ' + file);
  return stat;
}

async function treeManifest(directory) {
  const root = fs.realpathSync(directory), entries = [];
  const walk = async current => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name), stat = fs.lstatSync(file);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file), real = fs.realpathSync(file);
        if (!inside(root, real)) throw new Error('Bundle symlink escapes package: ' + relative);
        entries.push({ path: relative, type: 'link', target });
      } else if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) entries.push({ path: relative, type: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: await sha256(file) });
      else throw new Error('Unsupported package entry: ' + relative);
    }
  };
  await walk(root);
  return entries;
}

function assertSameManifest(before, after, label = 'Bundle') {
  if (!Array.isArray(before) || !before.length || JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(label + ' changed; qualification provenance is invalid');
  }
}

async function run(file, args, options = {}) {
  return execute(file, args, { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 65536, env: childEnvironment(), ...options });
}

function assertMachO(fileDescription, architectures, arch) {
  const wanted = arch === 'x64' ? 'x86_64' : 'arm64';
  if (!['x64', 'arm64'].includes(arch) || !/Mach-O/.test(fileDescription) || architectures.trim() !== wanted) {
    throw new Error('Expected a native single-architecture Mach-O for ' + arch);
  }
}

async function inspectBinary(file, arch, { source, version = true, executeFile = run } = {}) {
  const stat = regularFile(file);
  if (!(stat.mode & 0o111)) throw new Error('Packaged binary is not executable: ' + file);
  fs.accessSync(file, fs.constants.X_OK);
  if (version && stat.size <= 1024 ** 2) throw new Error('Packaged media binary is too small (possible LFS pointer): ' + file);
  const info = { path: file, bytes: stat.size, mode: stat.mode & 0o777, sha256: await sha256(file) };
  if (source) {
    regularFile(source);
    info.source = { path: source, sha256: await sha256(source) };
    if (info.sha256 !== info.source.sha256) throw new Error('Packaged media resource differs from checked-out LFS source');
  }
  info.file = (await executeFile('/usr/bin/file', ['-b', file])).stdout.trim();
  info.architectures = (await executeFile('/usr/bin/lipo', ['-archs', file])).stdout.trim();
  assertMachO(info.file, info.architectures, arch);
  if (version) {
    const result = await executeFile(file, ['-version']);
    info.version = { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    info.versionLine = result.stdout.split(/\r?\n/)[0];
    if (!/^(ffmpeg|ffprobe) version\s/.test(info.versionLine)) throw new Error('Missing media binary version line');
  }
  return info;
}

async function inspectPackage(app, arch, { root, expectedVersion, executeFile = run } = {}) {
  const absolute = path.resolve(app), stat = fs.lstatSync(absolute);
  if (!absolute.endsWith('.app') || !stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) {
    throw new Error('Expected a real package directory');
  }
  const plist = path.join(absolute, 'Contents/Info.plist'); regularFile(plist);
  const readPlist = async key => (await executeFile('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist])).stdout.trim();
  const identity = { bundleId: await readPlist('CFBundleIdentifier'), version: await readPlist('CFBundleShortVersionString'), executable: await readPlist('CFBundleExecutable') };
  if (identity.bundleId !== APP_ID || identity.version !== expectedVersion || !identity.executable ||
      identity.executable === '.' || identity.executable === '..' || /[\\/\r\n\0]/.test(identity.executable)) throw new Error('Unexpected packaged application identity');
  const resources = path.join(absolute, 'Contents/Resources'), executable = path.join(absolute, 'Contents/MacOS', identity.executable);
  regularFile(path.join(resources, 'app.asar'));
  const binaryOptions = { executeFile };
  const binaries = { executable: await inspectBinary(executable, arch, { ...binaryOptions, version: false }) };
  const framework = fs.realpathSync(path.join(absolute, 'Contents/Frameworks/Electron Framework.framework/Electron Framework'));
  if (!inside(absolute, framework)) throw new Error('Electron Framework escapes package');
  binaries.framework = await inspectBinary(framework, arch, { ...binaryOptions, version: false });
  for (const kind of ['ffmpeg', 'ffprobe']) binaries[kind] = await inspectBinary(path.join(resources, 'ffmpeg', kind), arch,
    { ...binaryOptions, source: path.join(root, 'resources/ffmpeg', 'mac-' + arch, kind) });
  const tee = path.join(resources, 'audiotee/audiotee'); regularFile(tee);
  const audioTee = { path: tee, sha256: await sha256(tee), sourceSha256: await sha256(path.join(root, 'resources/audiotee/audiotee')), executed: false };
  if (audioTee.sha256 !== audioTee.sourceSha256) throw new Error('AudioTee package inventory differs from source');
  const manifest = await treeManifest(absolute);
  // Helpers can be nested .apps; inspect each actual Mach-O executable, never launch one.
  binaries.helpers = [];
  for (const item of manifest.filter(item => item.type === 'file' && /Contents\/Frameworks\/.*\.app\/Contents\/MacOS\//.test(item.path))) {
    binaries.helpers.push(await inspectBinary(path.join(absolute, item.path), arch, { ...binaryOptions, version: false }));
  }
  if (!binaries.helpers.length) throw new Error('Packaged Electron helpers are missing');
  return { app: absolute, identity, executable, resources, binaries, audioTee, manifest };
}

function stagingPath({ runId, attempt, arch }, applications = '/Applications') {
  if (!/^\d+$/.test(runId || '') || !/^\d+$/.test(attempt || '') || !['x64', 'arm64'].includes(arch)) throw new Error('Invalid staging identity');
  return path.join(applications, `SuisseMeets-Qualification-${runId}-${attempt}-${arch}.app`);
}

function claimStage(app, identity, applications = '/Applications') {
  if (path.resolve(app) !== path.resolve(stagingPath(identity, applications)) || fs.realpathSync(applications) !== path.resolve(applications)) throw new Error('Unexpected Applications staging target');
  const stat = fs.lstatSync(app);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(app) !== path.resolve(app)) throw new Error('Staged app must be an owned real directory');
  return { path: path.resolve(app), identity, dev: stat.dev, ino: stat.ino, createdBySupervisor: true };
}

function assertStageCleanup(claim, applications = '/Applications') {
  if (!claim || claim.createdBySupervisor !== true || !Number.isSafeInteger(claim.dev) || !Number.isSafeInteger(claim.ino)) throw new Error('Missing staged-app ownership');
  const current = claimStage(claim.path, claim.identity, applications);
  if (current.dev !== claim.dev || current.ino !== claim.ino) throw new Error('Staged app identity changed; refusing cleanup');
  return current.path;
}

// Node's electron-log console transport prints object inspection, not JSON.
// Read bounded known fields; never evaluate a log as JavaScript.
function objectAfter(text, label) {
  const first = text.indexOf(label);
  if (first < 0) return null;
  if (text.indexOf(label, first + label.length) >= 0) throw new Error('Ambiguous owned main log: ' + label);
  const start = text.indexOf('{', first + label.length);
  if (start < 0) return null;
  let depth = 0, quote = null, escaped = false;
  for (let i = start; i < Math.min(text.length, start + 16384); i++) {
    const char = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
    } else if (['"', "'", '`'].includes(char)) quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function assertMainLogs(text, packageInfo) {
  if (text.includes('FFmpeg path (dev):')) throw new Error('App selected the development media binaries');
  const environment = objectAfter(text, 'Environment:');
  const health = objectAfter(text, 'Binary health probe result:');
  if (!environment || !health) return null; // Caller has a strict startup deadline.
  const parsedEnvironment = parseInspectedObject(environment), parsedHealth = parseInspectedObject(health);
  if (parsedEnvironment.isPackaged !== true) throw new Error('Main process did not attest app.isPackaged=true');
  const paths = [...text.matchAll(/FFmpeg path \(production\):\s*([^\r\n]+)/g)];
  if (paths.length !== 1 || paths[0][1].trim() !== packageInfo.binaries.ffmpeg.path) throw new Error('Main selected the wrong packaged FFmpeg path');
  for (const kind of ['ffmpeg', 'ffprobe']) {
    const entry = parsedHealth[kind];
    if (!entry || entry.available !== true || entry.versionLine !== packageInfo.binaries[kind].versionLine) {
      throw new Error('Packaged startup health did not confirm ' + kind);
    }
  }
  return { isPackaged: true, selectedFfmpegPath: paths[0][1].trim(), environmentLog: environment, healthLog: health };
}

function parseInspectedObject(text) {
  let at = 0;
  const fail = () => { throw new Error('Malformed owned main object log'); };
  const space = () => { while (/\s/.test(text[at] || '') && at < text.length) at++; };
  const quoted = () => {
    const quote = text[at++]; let value = '';
    while (at < text.length) {
      const char = text[at++];
      if (char === quote) return value;
      if (char !== '\\') { value += char; continue; }
      const escaped = text[at++], escapes = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '`': '`' };
      if (!Object.hasOwn(escapes, escaped)) fail();
      value += escapes[escaped];
    }
    fail();
  };
  const value = depth => {
    if (depth > 3) fail(); space();
    if (['"', "'", '`'].includes(text[at])) return quoted();
    if (text[at] === '{') {
      at++; space(); const object = Object.create(null);
      while (text[at] !== '}') {
        const match = /^[A-Za-z_][\w]*/.exec(text.slice(at));
        if (!match) fail(); const key = match[0]; at += key.length; space();
        if (text[at++] !== ':' || Object.hasOwn(object, key)) fail();
        object[key] = value(depth + 1); space();
        if (text[at] === ',') { at++; space(); } else if (text[at] !== '}') fail();
      }
      at++; return object;
    }
    const literal = /^(true|false|null)(?=[\s,}])/.exec(text.slice(at));
    if (!literal) fail(); at += literal[0].length;
    return literal[0] === 'null' ? null : literal[0] === 'true';
  };
  const result = value(0); space(); if (at !== text.length || !result || typeof result !== 'object') fail(); return result;
}

function assertCaptureResult(result, finalized, receipt) {
  if (result?.pass !== true || !Array.isArray(result.problems) || result.problems.length || result.phase !== 'uploaded' ||
      result.nativeArchiveExpected !== true || !result.nativeSource || !Number.isSafeInteger(result.nativeSource.chunkCount) || result.nativeSource.chunkCount < 1 ||
      typeof result.nativeSource.sourceId !== 'string' || !result.nativeSource.sourceId ||
      typeof result.output !== 'string' || !path.isAbsolute(result.output) ||
      result.uploadAttempts !== 1 || !/^[a-f0-9]{64}$/.test(result.localSha256 || '') ||
      finalized?.success !== true || finalized.outputPath !== result.output || receipt?.version !== 3 ||
      receipt.sourceMode !== 'native' || receipt.sha256 !== result.localSha256 || receipt.systemPcmIncluded !== false ||
      !Array.isArray(receipt.sourceIds) || receipt.sourceIds.length !== 1 || receipt.sourceIds[0] !== result.nativeSource.sourceId) {
    throw new Error('Packaged synthetic finalization/custody gates failed');
  }
  return true;
}

function resources(directory) {
  const stat = fs.statfsSync(directory);
  const value = { at: new Date().toISOString(), availableDiskBytes: Number(stat.bavail) * Number(stat.bsize),
    availableMemoryBytes: process.availableMemory?.(), freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem() };
  if (!Object.entries(value).filter(([key]) => key !== 'at').every(([, bytes]) => Number.isSafeInteger(bytes) && bytes >= 0)) throw new Error('Resource measurement unavailable');
  return value;
}

function descendants(rows, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned supervisor PID');
  const owned = [pid];
  for (let i = 0; i < owned.length; i++) {
    for (const row of rows) if (row.ppid === owned[i] && Number.isSafeInteger(row.pid) && row.pid > 0 && !owned.includes(row.pid)) owned.push(row.pid);
  }
  return owned.reverse();
}

module.exports = { API_URL, APP_ID, CAPTURE_SECONDS, BUILD_MS, CAPTURE_MS, SCOPE, writeJson, sha256, assertArch, childEnvironment,
  assertHosted, makeBuilderConfig, inside, regularFile, treeManifest, assertSameManifest, run, assertMachO, inspectBinary,
  inspectPackage, stagingPath, claimStage, assertStageCleanup, objectAfter, parseInspectedObject, assertMainLogs, assertCaptureResult, resources, descendants };
