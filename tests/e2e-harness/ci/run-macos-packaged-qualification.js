'use strict';

const fs = require('fs');
const path = require('path');
const { API_URL, CAPTURE_SECONDS, CAPTURE_MS, SCOPE, assertHosted, assertArch, inspectPackage, treeManifest,
  assertSameManifest, stagingPath, claimStage, assertStageCleanup, assertMainLogs, assertCaptureResult,
  writeJson, sha256, regularFile, inside, run, resources } = require('../lib/macos-packaged');
const { sourceManifest, toolchainManifest, assertEvidenceDirectory, supervise, waitForSupervisor, archive, parseArguments } = require('./macos-packaged-supervisor');
const { reportDetachedSpawns } = require('./macos-packaged-groups');
const ROOT = path.resolve(__dirname, '../../..');
const WORK = path.join(ROOT, 'tests/e2e-harness/work/macos-packaged');

function assertDirectory(directory, prefix) {
  return assertEvidenceDirectory(directory, prefix, WORK);
}

async function worker(args) {
  reportDetachedSpawns();
  assertHosted(); assertDirectory(args.directory, 'run-');
  const context = JSON.parse(fs.readFileSync(path.join(args.directory, 'context.json')));
  assertArch(args.arch, process.platform, process.arch, (await run('/usr/bin/uname', ['-m'])).stdout);
  if (context.architecture !== args.arch || Number(args.seconds) !== CAPTURE_SECONDS) throw new Error('Unexpected packaged capture duration or architecture');
  const staged = assertStageCleanup(context.claim);
  const packageInfo = await inspectPackage(staged, args.arch, { root: ROOT, expectedVersion: context.version });
  assertSameManifest(context.package.manifest, packageInfo.manifest, 'Staged package before capture');
  process.env.SUISSE_E2E_PACKAGED_EXE = packageInfo.executable;
  process.env.SUISSE_E2E_BUNDLE_SHA = context.commit;
  // assertHosted rejected APP_DIR before the driver can prefer npm Electron.
  const { captureCase } = require('../qualification');
  const { readFinalizedRecording } = require('../../../src-electron/recording-persistence');
  let mockBackend, attestation;
  const result = await captureCase('baseline', CAPTURE_SECONDS, {
    beforeRecording: async (app, { reference, mock }) => {
      mockBackend = mock;
      if (app.appDir || !app.proc || app.proc.exitCode !== null || app.proc.signalCode !== null ||
          app.proc.spawnfile !== packageInfo.executable) throw new Error('Driver did not launch the owned packaged executable');
      if (!inside(path.join(ROOT, 'tests/e2e-harness/work'), reference.wavPath)) throw new Error('Fake input is outside the synthetic evidence directory');
      if (regularFile(reference.wavPath).size !== (CAPTURE_SECONDS + 25) * 96000 + 44) throw new Error('Unexpected bounded synthetic input size');
      const deadline = Date.now() + 35000;
      while (Date.now() < deadline) {
        if (app.proc.exitCode !== null || app.proc.signalCode !== null) throw new Error('Owned packaged application exited before attestation');
        attestation = assertMainLogs(app.log.join(''), packageInfo);
        if (attestation) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!attestation) throw new Error('Packaged startup evidence did not arrive before deadline');
      const ipc = await app.evalTimed(async () => ({ apiUrl: await window.electronAPI.config.getApiUrl(),
        systemAudioEnabled: await window.electronAPI.systemAudio.getEnabled(), isE2E: window.electronAPI.isE2E }));
      if (ipc.apiUrl !== API_URL || mock.url !== API_URL || ipc.systemAudioEnabled !== false || ipc.isE2E !== true) throw new Error('Packaged runtime isolation/system-audio checks failed');
      const session = await app.browser.target().createCDPSession();
      let browserVersion;
      try { browserVersion = await session.send('Browser.getVersion'); } finally { await session.detach(); }
      if (!browserVersion.userAgent?.includes('Electron/' + context.electron)) throw new Error('Owned runtime Electron version differs from packaged build');
      const expectedSwitch = '--disable-features=AudioServiceSandbox';
      if (!app.proc.spawnargs.includes(expectedSwitch)) throw new Error('Missing explicit macOS fake-WAV audio-service exception');
      attestation = { ...attestation, ipc, browserVersion, pid: app.proc.pid, executable: app.proc.spawnfile,
        arguments: app.proc.spawnargs, profile: app.userDataDir,
        reference: { path: reference.wavPath, sha256: await sha256(reference.wavPath), metadata: reference.metaPath,
          metadataSha256: await sha256(reference.metaPath), seconds: CAPTURE_SECONDS + 25 } };
      writeJson(path.join(args.directory, 'attestation.json'), attestation);
    },
  });
  const evidence = { pass: false, scope: SCOPE, captureSeconds: CAPTURE_SECONDS, result, attestation, problems: [] };
  try {
    if (!attestation || !result.output || !inside(path.join(ROOT, 'tests/e2e-harness/work/userdata'), result.output)) throw new Error('Missing attested synthetic capture output');
    const recordPath = path.dirname(result.output);
    const receipt = JSON.parse(fs.readFileSync(path.join(recordPath, 'finalized.json')));
    const finalized = await readFinalizedRecording(recordPath);
    assertCaptureResult(result, finalized, receipt);
    const upload = JSON.parse(fs.readFileSync(path.join(recordPath, 'upload-receipt.json')));
    const remote = mockBackend.state.uploads.get(upload.audioFileId);
    if (upload.canDelete !== false || remote?.sha256 !== result.localSha256 || await sha256(result.output) !== result.localSha256) throw new Error('Packaged local/remote byte custody mismatch');
    evidence.finalized = finalized; evidence.receipt = receipt; evidence.upload = upload;
    evidence.mock = { requests: mockBackend.state.requests, uploads: [...mockBackend.state.uploads.entries()] };
    evidence.pass = true;
  } catch (error) { evidence.problems.push(error.stack || error.message); }
  finally { writeJson(path.join(args.directory, 'capture-result.json'), evidence); }
  if (!evidence.pass) process.exitCode = 1;
}

async function main(args) {
  const deadlineAt = Date.now() + CAPTURE_MS;
  assertHosted(); assertArch(args.arch, process.platform, process.arch, (await run('/usr/bin/uname', ['-m'])).stdout);
  if (args.seconds !== String(CAPTURE_SECONDS) || !args.app || !inside(WORK, args.app)) throw new Error('Expected a bounded generated packaged app and exactly45 seconds');
  const app = path.resolve(args.app);
  const buildDir = path.resolve(app, '../../..');
  assertDirectory(buildDir, 'build-');
  const built = JSON.parse(fs.readFileSync(path.join(buildDir, 'context.json')));
  const buildResult = JSON.parse(fs.readFileSync(path.join(buildDir, 'build-result.json')));
  const buildSummary = JSON.parse(fs.readFileSync(path.join(buildDir, 'summary.json')));
  const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim();
  if (!buildResult.pass || !buildSummary.pass || buildResult.app !== app || built.commit !== commit || built.architecture !== args.arch) throw new Error('App build provenance does not match this candidate');
  const packageInfo = await inspectPackage(app, args.arch, { root: ROOT, expectedVersion: built.version });
  const original = JSON.parse(fs.readFileSync(path.join(buildDir, 'package-info.json')));
  assertSameManifest(original.manifest, packageInfo.manifest, 'Built package');
  assertSameManifest(built.sourceBefore, await sourceManifest(ROOT), 'Current source versus packaged source');
  const directory = fs.mkdtempSync(path.join(WORK, 'run-'));
  const identity = { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, arch: args.arch };
  const staged = stagingPath(identity);
  const context = { startedAt: new Date().toISOString(), scope: SCOPE, timeoutMs: CAPTURE_MS, commit,
    budgetScope: 'Worker receives remaining10-minute budget minus30-second evidence reserve. Staging/archive commands have30-second deadlines; outer11-minute workflow step additionally bounds preflight, hashing and finally work.',
    resourcePolicy: 'Resource measurements do not enforce new minima. Application production disk checks remain active.',
    architecture: args.arch, version: built.version, electron: built.electron, resources: resources(WORK),
    sourceBefore: await sourceManifest(ROOT), toolchainBefore: await toolchainManifest(), package: packageInfo, staged, claim: null };
  writeJson(path.join(directory, 'context.json'), context);
  let failure, cleanupVerified = false;
  try {
    // mkdir fails if the unique app already exists. Claim its inode before
    // copying, so a failed/partial ditto is still ours to preserve and clean.
    await run('/usr/bin/sudo', ['-n', '/bin/mkdir', staged]);
    context.claim = claimStage(staged, identity);
    writeJson(path.join(directory, 'context.json'), context);
    await run('/usr/bin/sudo', ['-n', '/usr/bin/ditto', app, staged]);
    assertStageCleanup(context.claim);
    assertSameManifest(packageInfo.manifest, await treeManifest(staged), 'Applications copy');
    const exit = await supervise(__filename, ['--arch', args.arch, '--seconds', args.seconds, '--directory', directory],
      { root: ROOT, directory, timeoutMs: Math.max(1, deadlineAt - Date.now() - 30000),
        expectedDetachedExecutable: path.join(staged, 'Contents/MacOS', packageInfo.identity.executable) });
    cleanupVerified = exit.cleanupVerified === true;
    if (exit.timedOut || exit.code !== 0 || exit.cleanupError || exit.failure || !cleanupVerified) throw new Error('Packaged capture worker failed or exceeded deadline');
    const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'capture-result.json')));
    if (!evidence.pass || evidence.captureSeconds !== CAPTURE_SECONDS || evidence.attestation?.isPackaged !== true) throw new Error('Missing packaged synthetic success evidence');
    if (exit.claims.filter(claim => claim.pid === evidence.attestation.pid).length !== 1) throw new Error('Captured app PID was not a registered owned process group');
  } catch (error) { failure = error; }
  finally {
    try {
      const after = await sourceManifest(ROOT); writeJson(path.join(directory, 'source-after.json'), after);
      assertSameManifest(context.sourceBefore, after, 'Qualification source');
      const toolchainAfter = await toolchainManifest(); writeJson(path.join(directory, 'toolchain-after.json'), toolchainAfter);
      assertSameManifest(context.toolchainBefore, toolchainAfter, 'Verifier toolchain');
      if (context.claim) {
        const afterPackage = await treeManifest(assertStageCleanup(context.claim));
        writeJson(path.join(directory, 'package-after.json'), afterPackage);
        assertSameManifest(packageInfo.manifest, afterPackage, 'Package after capture');
      }
    } catch (error) { failure ||= error; writeJson(path.join(directory, 'provenance-error.json'), { error: error.message }); }
    if (context.claim) {
      try {
        const owned = assertStageCleanup(context.claim);
        writeJson(path.join(directory, 'staged-archive.json'), await archive(owned, path.join(directory, 'staged-not-for-release.tar')));
        if (cleanupVerified) {
          await run('/usr/bin/sudo', ['-n', '/bin/rm', '-rf', '--', assertStageCleanup(context.claim)]);
          if (fs.existsSync(staged)) failure ||= new Error('Owned staged app remains after cleanup');
        }
        writeJson(path.join(directory, 'staging-cleanup.json'), { removed: !fs.existsSync(staged), path: staged,
          retainedReason: cleanupVerified ? null : 'Process cleanup was not verified; leave app for disposable runner teardown' });
      } catch (error) { failure ||= error; writeJson(path.join(directory, 'cleanup-error.json'), { error: error.message }); }
    }
    writeJson(path.join(directory, 'summary.json'), { pass: !failure, scope: SCOPE, captureSeconds: CAPTURE_SECONDS,
      error: failure?.message || null, signedArtifactQualified: false, fiveHourQualificationPassed: false, finishedAt: new Date().toISOString() });
  }
  if (failure) throw failure;
}

if (require.main === module) {
  const args = parseArguments(process.argv.slice(2), ['app', 'arch', 'seconds', 'directory']);
  (args.worker ? waitForSupervisor().then(() => worker(args)).finally(() => { if (process.connected) process.disconnect(); }) : main(args))
    .catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
module.exports = { main, worker, assertDirectory };
