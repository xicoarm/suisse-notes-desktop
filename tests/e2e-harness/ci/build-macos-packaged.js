'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { BUILD_MS, SCOPE, assertHosted, assertArch, makeBuilderConfig, inspectBinary, inspectPackage,
  writeJson, run, resources, assertSameManifest, inside, regularFile } = require('../lib/macos-packaged');
const { sourceManifest, toolchainManifest, assertEvidenceDirectory, supervise, waitForSupervisor, archive, parseArguments } = require('./macos-packaged-supervisor');
const { reportDetachedSpawns } = require('./macos-packaged-groups');
const ROOT = path.resolve(__dirname, '../../..');
const WORK = path.join(ROOT, 'tests/e2e-harness/work/macos-packaged');

function quasarCli() {
  const manifest = require.resolve('@quasar/app-vite/package.json');
  const directory = path.dirname(manifest), cli = path.resolve(directory, require(manifest).bin.quasar);
  if (!inside(directory, cli)) throw new Error('Unexpected Quasar executable path');
  regularFile(cli); return cli;
}

async function worker({ arch, directory }) {
  reportDetachedSpawns();
  assertEvidenceDirectory(directory, 'build-', WORK);
  const configPath = path.join(directory, 'context.json');
  const context = JSON.parse(fs.readFileSync(configPath));
  assertHosted(); assertArch(arch, process.platform, process.arch, (await run('/usr/bin/uname', ['-m'])).stdout);
  const result = { pass: false, scope: SCOPE, problems: [] };
  const invoke = async (label, file, args, options = {}) => {
    const child = spawn(file, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    const log = path.join(directory, label + '.log');
    // Persist while the command runs; a supervisor deadline must not erase the
    // final npm/Quasar output merely because execFile never returned its buffer.
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => fs.appendFileSync(log, bytes));
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (exit.code !== 0) throw new Error(label + ' failed: ' + JSON.stringify(exit));
  };
  try {
    for (const kind of ['ffmpeg', 'ffprobe']) {
      const info = await inspectBinary(path.join(ROOT, 'resources/ffmpeg', 'mac-' + arch, kind), arch);
      writeJson(path.join(directory, kind + '-source.json'), info);
    }
    await invoke('quasar-build', process.execPath, [quasarCli(), 'build', '-m', 'electron', '--skip-pkg']);
    // Matches Quasar's generated production npm install, which may resolve a
    // changed lock. Save its exact inventory; never claim release-byte parity.
    const appDir = path.join(ROOT, 'dist/electron/UnPackaged');
    await invoke('production-install', 'npm', ['install'], { cwd: appDir, env: { ...process.env, NODE_ENV: 'production' } });
    fs.copyFileSync(path.join(appDir, 'package.json'), path.join(directory, 'production-package.json'));
    fs.copyFileSync(path.join(appDir, 'package-lock.json'), path.join(directory, 'production-package-lock.json'));
    await invoke('production-dependencies', 'npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: appDir });
    const { default: makeConfig } = await import(pathToFileURL(path.join(ROOT, 'quasar.config.js')).href);
    const raw = makeConfig({ mode: { electron: true }, dev: false, prod: true }).electron.builder;
    const config = makeBuilderConfig(raw, { root: ROOT, output: path.join(directory, 'package'), electronVersion: context.electron });
    writeJson(path.join(directory, 'requested-builder-config.json'), config);
    const { build, Platform, archFromString } = require('electron-builder');
    await build({ projectDir: ROOT, config, targets: Platform.MAC.createTarget(['dir'], archFromString(arch)), publish: 'never' });
    const products = [];
    for (const output of fs.readdirSync(config.directories.output, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const base = path.join(config.directories.output, output.name);
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) if (entry.isDirectory() && entry.name.endsWith('.app')) products.push(path.join(base, entry.name));
    }
    if (products.length !== 1) throw new Error('Expected exactly one generated native product .app');
    const info = await inspectPackage(products[0], arch, { root: ROOT, expectedVersion: context.version });
    writeJson(path.join(directory, 'package-info.json'), info);
    result.app = info.app; result.pass = true;
  } catch (error) { result.problems.push(error.stack || error.message); }
  finally { writeJson(path.join(directory, 'build-result.json'), result); }
  if (!result.pass) process.exitCode = 1;
}

async function main(args) {
  const deadlineAt = Date.now() + BUILD_MS;
  assertHosted(); assertArch(args.arch, process.platform, process.arch, (await run('/usr/bin/uname', ['-m'])).stdout);
  if ((await run('git', ['status', '--porcelain'], { cwd: ROOT })).stdout.trim()) throw new Error('Package build requires a clean checkout');
  fs.mkdirSync(WORK, { recursive: true });
  const directory = fs.mkdtempSync(path.join(WORK, 'build-'));
  const context = { startedAt: new Date().toISOString(), scope: SCOPE, timeoutMs: BUILD_MS, architecture: args.arch,
    budgetScope: 'Worker receives remaining15-minute budget minus30-second evidence reserve. Archive commands have30-second deadlines; outer16-minute workflow step additionally bounds preflight, hashing and finally work.',
    resourcePolicy: 'Available/free/total memory and disk are measurements, not minimum-headroom admission gates.',
    commit: (await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim(),
    node: process.version, npm: (await run('npm', ['--version'])).stdout.trim(),
    electron: require('electron/package.json').version, builder: require('electron-builder/package.json').version,
    quasar: require('@quasar/app-vite/package.json').version, version: require(path.join(ROOT, 'package.json')).version,
    dependencyLimit: 'Generated production npm install can change resolution; preserve lock/inventory. Release CI Node20 differs from diagnostic Node24. No identical released-artifact claim.',
    resources: resources(WORK), sourceBefore: await sourceManifest(ROOT), toolchainBefore: await toolchainManifest() };
  writeJson(path.join(directory, 'context.json'), context);
  let failure;
  try {
    const exit = await supervise(__filename, ['--arch', args.arch, '--directory', directory],
      { root: ROOT, directory, timeoutMs: Math.max(1, deadlineAt - Date.now() - 30000) });
    const sourceAfter = await sourceManifest(ROOT); writeJson(path.join(directory, 'source-after.json'), sourceAfter);
    assertSameManifest(context.sourceBefore, sourceAfter, 'Build source');
    const toolchainAfter = await toolchainManifest(); writeJson(path.join(directory, 'toolchain-after.json'), toolchainAfter);
    assertSameManifest(context.toolchainBefore, toolchainAfter, 'Build toolchain');
    if (exit.timedOut || exit.code !== 0 || exit.cleanupError || exit.failure || !exit.cleanupVerified) throw new Error('Packaged build worker failed or exceeded deadline');
    const result = JSON.parse(fs.readFileSync(path.join(directory, 'build-result.json')));
    if (!result.pass || !result.app) throw new Error('Missing successful package verification');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `app=${result.app}\n`);
  } catch (error) { failure = error; }
  finally {
    try {
      const packageDir = path.join(directory, 'package');
      if (fs.existsSync(packageDir)) writeJson(path.join(directory, 'package-archive.json'), await archive(packageDir, path.join(directory, 'package-not-for-release.tar')));
    } catch (error) { failure ||= error; writeJson(path.join(directory, 'archive-error.json'), { error: error.message }); }
    writeJson(path.join(directory, 'summary.json'), { pass: !failure, error: failure?.message || null, scope: SCOPE, finishedAt: new Date().toISOString() });
  }
  if (failure) throw failure;
}

if (require.main === module) {
  const args = parseArguments(process.argv.slice(2), ['arch', 'directory']);
  (args.worker ? waitForSupervisor().then(() => worker(args)).finally(() => { if (process.connected) process.disconnect(); }) : main(args))
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { main, worker, quasarCli };
