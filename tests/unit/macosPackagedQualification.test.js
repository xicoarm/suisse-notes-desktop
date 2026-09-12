// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import makeQuasarConfig from '../../quasar.config.js';

const require = createRequire(import.meta.url);
const {
  API_URL, APP_ID, assertArch, childEnvironment, assertHosted, makeBuilderConfig,
  inside, regularFile, treeManifest, assertSameManifest, assertMachO, inspectBinary,
  inspectPackage, stagingPath, claimStage, assertStageCleanup, objectAfter,
  parseInspectedObject, assertMainLogs, assertCaptureResult, descendants
} = require('../e2e-harness/lib/macos-packaged');
let root;

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'macos-packaged-unit-'))); });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) ||
      !path.basename(resolved).startsWith('macos-packaged-unit-') || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error('Unsafe packaged fixture cleanup');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

function write(file, bytes = 'fixture bytes', mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, mode);
  return file;
}
function linkDirectory(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}
function hosted(overrides = {}) {
  return { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    SUISSE_E2E_HOOKS: '1', SUISSE_TEST_NETWORK_ISOLATION: '1', API_BASE_URL: API_URL, VITE_API_URL: API_URL, ...overrides };
}
function builder() {
  vi.stubEnv('SUISSE_E2E_HOOKS', '0');
  return makeQuasarConfig({ mode: { electron: true }, dev: false, prod: true }).electron.builder;
}

describe('packaged build and host boundaries', () => {
  it('preserves the real release resource/ASAR/entitlement config without mutating it, and overrides signing', () => {
    const raw = builder();
    raw.mac = { ...raw.mac, identity: 'Developer ID: unit fixture', forceCodeSigning: true, notarize: true };
    const before = structuredClone(raw);
    const config = makeBuilderConfig(raw, { root, output: path.join(root, 'package'), electronVersion: '28.3.3' });
    expect(raw).toEqual(before);
    expect(config).toEqual({ ...before, electronVersion: '28.3.3', directories: {
      buildResources: path.join(root, 'src-electron'), app: path.join(root, 'dist/electron/UnPackaged'), output: path.join(root, 'package')
    }, mac: { ...before.mac, identity: null, forceCodeSigning: false, notarize: false } });
    expect(config.extraResources).toBe(raw.extraResources);
    expect(config.asarUnpack).toBe(raw.asarUnpack);
    expect(config.mac.entitlements).toBe('build/entitlements.mac.plist');
  });

  it.each(['identity', 'ffmpeg', 'audiotee'])('rejects unexpected release %s mapping', kind => {
    const raw = builder();
    if (kind === 'identity') raw.appId = 'unrelated.product';
    else raw.extraResources = raw.extraResources.filter(item => item.to !== kind);
    expect(() => makeBuilderConfig(raw, { root, output: root, electronVersion: '28.3.3' })).toThrow('identity or resource mapping');
  });

  it('removes inherited credentials and app overrides while retaining required runner utilities', () => {
    const input = {
      PATH: '/usr/bin', HOME: '/Users/runner', RUNNER_TEMP: '/tmp/runner', GITHUB_RUN_ID: '123',
      GH_TOKEN: 'private', GITHUB_TOKEN: 'private', SENTRY_AUTH_TOKEN: 'private', my_secret: 'private',
      API_KEY: 'private', DATABASE_PASSWORD: 'private', APPLE_ID: 'private', APPLE_API_ISSUER: 'private',
      CSC_LINK: 'private', CSC_IDENTITY_AUTO_DISCOVERY: 'true',
      API_BASE_URL: 'https://production.invalid', VITE_API_URL: 'https://production.invalid',
      SUISSE_E2E_APP_DIR: '/old-app', SUISSE_E2E_PACKAGED_EXE: '/other-app', SUISSE_TEST_FAKE_AUDIO: '/old.wav',
      SUISSE_E2E_BUNDLE_SHA: 'old', VITE_FEATURE_OVERRIDE: '1', NODE_OPTIONS: '--require unsafe.js',
      ELECTRON_RUN_AS_NODE: '1', APP_ENV: 'production', HUSKY: '1'
    };
    const actual = childEnvironment(input);
    expect(actual).toEqual({ PATH: '/usr/bin', HOME: '/Users/runner', RUNNER_TEMP: '/tmp/runner', GITHUB_RUN_ID: '123',
      API_BASE_URL: API_URL, VITE_API_URL: API_URL, SUISSE_E2E_HOOKS: '1', SUISSE_TEST_NETWORK_ISOLATION: '1',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false', HUSKY: '0' });
    expect(input.SUISSE_E2E_PACKAGED_EXE).toBe('/other-app');
  });

  it.each([
    { GITHUB_ACTIONS: 'false' }, { GITHUB_RUN_ID: '../123' }, { GITHUB_RUN_ATTEMPT: '' },
    { API_BASE_URL: 'https://production.invalid' }, { VITE_API_URL: 'http://localhost:3001' },
    { SUISSE_E2E_HOOKS: '0' }, { SUISSE_TEST_NETWORK_ISOLATION: '0' },
    { SUISSE_E2E_APP_DIR: '/unpackaged' }, { SUISSE_E2E_PACKAGED_EXE: '/wrong.app' }
  ])('rejects a host without explicit disposable isolation: %j', patch => {
    expect(() => assertHosted(hosted())).not.toThrow();
    expect(() => assertHosted(hosted(patch))).toThrow();
  });

  it.each([
    ['x64', 'darwin', 'arm64', 'arm64'], ['arm64', 'darwin', 'x64', 'x86_64'],
    ['x64', 'darwin', 'x64', 'arm64'], ['x64', 'win32', 'x64', 'x86_64'],
    ['universal', 'darwin', 'arm64', 'arm64']
  ])('rejects a foreign, translated, or mismatched runtime (%s, %s, %s, %s)', (...args) => {
    expect(() => assertArch(...args)).toThrow('matching native');
  });

  it('accepts only the exact native Mach-O architecture', () => {
    for (const [arch, machine] of [['x64', 'x86_64'], ['arm64', 'arm64']]) {
      expect(assertArch(arch, 'darwin', arch, machine + '\n')).toBe(machine);
      expect(() => assertMachO('Mach-O 64-bit executable ' + machine, machine, arch)).not.toThrow();
      expect(() => assertMachO('Mach-O universal binary', 'x86_64 arm64', arch)).toThrow();
      expect(() => assertMachO('ELF 64-bit executable', machine, arch)).toThrow();
    }
  });
});

function packageFixture(arch = 'arm64') {
  const app = path.join(root, 'Fixture.app');
  const sourceRoot = path.join(root, 'source');
  const contents = path.join(app, 'Contents');
  const executable = write(path.join(contents, 'MacOS/Suisse Meets'));
  const framework = write(path.join(contents, 'Frameworks/Electron Framework.framework/Electron Framework'));
  const helper = write(path.join(contents, 'Frameworks/Suisse Meets Helper.app/Contents/MacOS/Suisse Meets Helper'));
  write(path.join(contents, 'Info.plist'), '<plist>values supplied by injected PlistBuddy</plist>');
  write(path.join(contents, 'Resources/app.asar'));
  const media = {};
  for (const [index, kind] of ['ffmpeg', 'ffprobe'].entries()) {
    const bytes = Buffer.alloc(1024 ** 2 + 1, 0x61 + index);
    media[kind] = write(path.join(contents, 'Resources/ffmpeg', kind), bytes);
    write(path.join(sourceRoot, 'resources/ffmpeg', 'mac-' + arch, kind), bytes);
  }
  const tee = write(path.join(contents, 'Resources/audiotee/audiotee'), 'unexecuted AudioTee fixture');
  write(path.join(sourceRoot, 'resources/audiotee/audiotee'), 'unexecuted AudioTee fixture');
  const plist = { CFBundleIdentifier: APP_ID, CFBundleShortVersionString: '4.6.0', CFBundleExecutable: 'Suisse Meets' };
  const architectureOverrides = new Map();
  const executeFile = vi.fn(async (file, args) => {
    if (file === '/usr/libexec/PlistBuddy') return { stdout: plist[args[1].slice('Print :'.length)] + '\n', stderr: '' };
    if (file === '/usr/bin/file') return { stdout: 'Mach-O 64-bit executable\n', stderr: '' };
    if (file === '/usr/bin/lipo') return { stdout: (architectureOverrides.get(args[1]) || (arch === 'x64' ? 'x86_64' : 'arm64')) + '\n', stderr: '' };
    if (Object.values(media).includes(file) && args.length === 1 && args[0] === '-version') {
      return { stdout: path.basename(file) + ' version 6.1 fixture\nconfiguration: unit fixture\n', stderr: '' };
    }
    throw new Error('Unexpected external execution: ' + file);
  });
  return { app, sourceRoot, executable, framework, helper, media, tee, plist, architectureOverrides, executeFile,
    options: { root: sourceRoot, expectedVersion: '4.6.0', executeFile } };
}

// Windows reports no executable mode bits, even for node.exe. Do not spoof its
// filesystem metadata to turn a POSIX package check into a false local pass.
describe.skipIf(process.platform === 'win32')('real POSIX package resource metadata (macOS commands injected)', () => {
  it.each(['x64', 'arm64'])('checks actual source hashes and every %s binary without executing AudioTee or helpers', async arch => {
    const fixture = packageFixture(arch);
    const info = await inspectPackage(fixture.app, arch, fixture.options);
    expect(info.identity).toEqual({ bundleId: APP_ID, version: '4.6.0', executable: 'Suisse Meets' });
    expect(info.binaries.helpers.map(item => item.path)).toEqual([fixture.helper]);
    for (const kind of ['ffmpeg', 'ffprobe']) {
      expect(info.binaries[kind].sha256).toBe(createHash('sha256').update(fs.readFileSync(fixture.media[kind])).digest('hex'));
      expect(info.binaries[kind].sha256).toBe(info.binaries[kind].source.sha256);
      expect(info.binaries[kind].mode & 0o111).not.toBe(0);
      expect(info.binaries[kind].version.exitCode).toBe(0);
    }
    expect(info.audioTee.executed).toBe(false);
    const actualExecutions = fixture.executeFile.mock.calls.filter(([file]) => !file.startsWith('/usr/')).map(([file]) => file);
    expect(actualExecutions.sort()).toEqual(Object.values(fixture.media).sort());
  });

  it.each(['ffmpeg', 'ffprobe'])('rejects a checked-out LFS pointer for %s before any command', async kind => {
    const fixture = packageFixture();
    const bytes = 'version https://git-lfs.github.com/spec/v1\noid sha256:fixture\nsize 60000000\n';
    write(fixture.media[kind], bytes);
    write(path.join(fixture.sourceRoot, 'resources/ffmpeg/mac-arm64', kind), bytes);
    await expect(inspectBinary(fixture.media[kind], 'arm64', { executeFile: fixture.executeFile })).rejects.toThrow('too small');
    expect(fixture.executeFile).not.toHaveBeenCalled();
  });

  it('rejects missing executable modes without executing the file', async () => {
    const fixture = packageFixture();
    fs.chmodSync(fixture.media.ffmpeg, 0o644);
    await expect(inspectBinary(fixture.media.ffmpeg, 'arm64', { executeFile: fixture.executeFile })).rejects.toThrow('not executable');
    expect(fixture.executeFile).not.toHaveBeenCalled();
  });

  it('rejects same-size media corruption relative to the source', async () => {
    const fixture = packageFixture();
    write(fixture.media.ffmpeg, Buffer.alloc(1024 ** 2 + 1, 0x63));
    await expect(inspectPackage(fixture.app, 'arm64', fixture.options)).rejects.toThrow('differs from checked-out');
  });

  it.each(['executable', 'framework', 'helper'])('rejects the wrong native architecture in %s', async key => {
    const fixture = packageFixture();
    fixture.architectureOverrides.set(fixture[key], 'x86_64');
    await expect(inspectPackage(fixture.app, 'arm64', fixture.options)).rejects.toThrow('single-architecture');
  });

  it('rejects missing helpers, and missing ASAR before any binary execution', async () => {
    const fixture = packageFixture();
    fs.renameSync(fixture.helper, path.join(root, 'retained-helper'));
    await expect(inspectPackage(fixture.app, 'arm64', fixture.options)).rejects.toThrow('helpers are missing');
    fs.renameSync(path.join(fixture.app, 'Contents/Resources/app.asar'), path.join(root, 'retained.asar'));
    fixture.executeFile.mockClear();
    await expect(inspectPackage(fixture.app, 'arm64', fixture.options)).rejects.toThrow();
    expect(fixture.executeFile.mock.calls.every(([file]) => file === '/usr/libexec/PlistBuddy')).toBe(true);
  });

  it('rejects a substituted AudioTee resource without executing it', async () => {
    const fixture = packageFixture();
    write(fixture.tee, 'modified AudioTee bytes');
    await expect(inspectPackage(fixture.app, 'arm64', fixture.options)).rejects.toThrow('AudioTee package inventory');
    expect(fixture.executeFile.mock.calls.some(([file]) => file === fixture.tee)).toBe(false);
  });

  it('propagates media execution timeout and invalid version output', async () => {
    const fixture = packageFixture();
    const original = fixture.executeFile.getMockImplementation();
    fixture.executeFile.mockImplementation((file, args) => {
      if (file === fixture.media.ffmpeg) throw Object.assign(new Error('SIGKILL timeout'), { killed: true });
      return original(file, args);
    });
    await expect(inspectBinary(fixture.media.ffmpeg, 'arm64', { executeFile: fixture.executeFile })).rejects.toThrow('timeout');
    fixture.executeFile.mockImplementation((file, args) => file === fixture.media.ffmpeg
      ? { stdout: 'unrelated tool version\n', stderr: '' } : original(file, args));
    await expect(inspectBinary(fixture.media.ffmpeg, 'arm64', { executeFile: fixture.executeFile })).rejects.toThrow('version line');
  });

  it('rejects a linked media binary or source instead of qualifying the target bytes', async () => {
    const fixture = packageFixture();
    const stored = path.join(root, 'retained-ffmpeg');
    fs.renameSync(fixture.media.ffmpeg, stored);
    fs.symlinkSync(stored, fixture.media.ffmpeg);
    await expect(inspectBinary(fixture.media.ffmpeg, 'arm64', { executeFile: fixture.executeFile })).rejects.toThrow('regular non-symlink');
    expect(fixture.executeFile).not.toHaveBeenCalled();
    const source = path.join(fixture.sourceRoot, 'resources/ffmpeg/mac-arm64/ffprobe');
    fs.renameSync(source, path.join(root, 'retained-ffprobe'));
    fs.symlinkSync(path.join(root, 'retained-ffprobe'), source);
    await expect(inspectBinary(fixture.media.ffprobe, 'arm64', { source, executeFile: fixture.executeFile })).rejects.toThrow('regular non-symlink');
    expect(fixture.executeFile).not.toHaveBeenCalled();
  });

  it('rejects a framework symlink resolving outside the package', async () => {
    const fixture = packageFixture();
    const outside = path.join(root, 'outside-framework');
    fs.renameSync(fixture.framework, outside);
    fs.symlinkSync(outside, fixture.framework);
    await expect(inspectPackage(fixture.app, 'arm64', fixture.options)).rejects.toThrow('Framework escapes');
  });
});

describe('bundle hash and link provenance', () => {
  it.each([
    ['CFBundleIdentifier', 'other.product'], ['CFBundleShortVersionString', 'old'],
    ['CFBundleExecutable', '../outside'], ['CFBundleExecutable', '.'], ['CFBundleExecutable', 'bad\nname']
  ])('rejects unexpected plist %s=%s before executing any bundled file', async (key, value) => {
    const fixture = packageFixture();
    fixture.plist[key] = value;
    await expect(inspectPackage(fixture.app, 'arm64', fixture.options)).rejects.toThrow('application identity');
    expect(fixture.executeFile.mock.calls.every(([file]) => file === '/usr/libexec/PlistBuddy')).toBe(true);
  });

  it('records actual bytes/modes deterministically and rejects a same-size mutation or missing entry', async () => {
    const bundle = path.join(root, 'bundle');
    const file = write(path.join(bundle, 'z/file'), 'before');
    write(path.join(bundle, 'a'), 'first');
    const before = await treeManifest(bundle);
    expect(before.map(item => item.path)).toEqual(['a', 'z/file']);
    expect(before[1]).toMatchObject({ type: 'file', bytes: 6, mode: fs.statSync(file).mode & 0o777,
      sha256: createHash('sha256').update('before').digest('hex') });
    expect(() => assertSameManifest(before, before)).not.toThrow();
    write(file, 'AFTER!');
    expect(() => assertSameManifest(before, before.slice(1))).toThrow('provenance');
    expect(() => assertSameManifest(before, [])).toThrow('provenance');
    expect(() => assertSameManifest([], [])).toThrow('provenance');
    const after = await treeManifest(bundle);
    expect(() => assertSameManifest(before, after)).toThrow('provenance');
  });

  it('records internal link targets but refuses a link outside the package', async () => {
    const bundle = path.join(root, 'bundle');
    write(path.join(bundle, 'real/file'));
    linkDirectory(path.join(bundle, 'real'), path.join(bundle, 'alias'));
    const manifest = await treeManifest(bundle);
    expect(manifest.find(item => item.path === 'alias')).toEqual({ path: 'alias', type: 'link', target: fs.readlinkSync(path.join(bundle, 'alias')) });
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    linkDirectory(outside, path.join(bundle, 'escape'));
    await expect(treeManifest(bundle)).rejects.toThrow('symlink escapes');
    expect(() => regularFile(path.join(bundle, 'alias'))).toThrow('regular non-symlink');
  });

  it('rejects a package root alias and confines child paths lexically', async () => {
    fs.mkdirSync(path.join(root, 'real.app'));
    linkDirectory(path.join(root, 'real.app'), path.join(root, 'alias.app'));
    await expect(inspectPackage(path.join(root, 'alias.app'), 'arm64', {})).rejects.toThrow('real package directory');
    expect(inside(root, path.join(root, 'child'))).toBe(true);
    expect(inside(root, root)).toBe(false);
    expect(inside(root, root + '-sibling')).toBe(false);
    expect(inside(root, path.join(root, '..', 'outside'))).toBe(false);
  });
});

describe('staged application and process ownership', () => {
  const identity = { runId: '123', attempt: '2', arch: 'arm64' };
  it('requires a safely representable, unchanged directory identity before authorizing cleanup', () => {
    const applications = path.join(root, 'Applications');
    fs.mkdirSync(applications);
    const staged = stagingPath(identity, applications);
    fs.mkdirSync(staged);
    const claim = claimStage(staged, identity, applications);
    if (!Number.isSafeInteger(claim.dev) || !Number.isSafeInteger(claim.ino)) {
      // Some NTFS file IDs exceed JS safe integers; the real check must refuse
      // them, rather than the test replacing the inode with invented metadata.
      expect(() => assertStageCleanup(claim, applications)).toThrow('ownership');
      return;
    }
    expect(assertStageCleanup(claim, applications)).toBe(staged);
    expect(() => assertStageCleanup({ ...claim, createdBySupervisor: false }, applications)).toThrow('ownership');
    expect(() => assertStageCleanup({ ...claim, ino: claim.ino + 1 }, applications)).toThrow('identity changed');
    fs.renameSync(staged, path.join(applications, 'retained-original.app'));
    fs.mkdirSync(staged);
    expect(() => assertStageCleanup(claim, applications)).toThrow('identity changed');
  });

  it('rejects another application, traversal identities and linked staging parents', () => {
    const applications = path.join(root, 'Applications');
    fs.mkdirSync(applications);
    const other = path.join(applications, 'Installed Customer App.app');
    fs.mkdirSync(other);
    expect(() => claimStage(other, identity, applications)).toThrow('staging target');
    for (const patch of [{ runId: '../123' }, { attempt: '' }, { arch: 'universal' }]) {
      expect(() => stagingPath({ ...identity, ...patch }, applications)).toThrow('staging identity');
    }
    const alias = path.join(root, 'ApplicationsAlias');
    linkDirectory(applications, alias);
    expect(() => claimStage(stagingPath(identity, alias), identity, alias)).toThrow('staging target');
    expect(() => assertStageCleanup(null, applications)).toThrow('ownership');
  });

  it('selects only descendants of the owned PID, children first, despite reordered rows and cycles', () => {
    const rows = [{ pid: 30, ppid: 20 }, { pid: 200, ppid: 999 }, { pid: 20, ppid: 10 },
      { pid: 10, ppid: 30 }, { pid: 40, ppid: 10 }, { pid: -1, ppid: 10 }, { pid: '50', ppid: 10 }];
    expect(descendants(rows, 10)).toEqual([30, 40, 20, 10]);
    expect(descendants(rows, 777)).toEqual([777]);
    for (const invalid of [0, -1, NaN, 1.5, '10']) expect(() => descendants(rows, invalid)).toThrow('supervisor PID');
  });
});

function packageInfo() {
  return { binaries: {
    ffmpeg: { path: path.join(root, 'Applications/Fixture.app/Contents/Resources/ffmpeg/ffmpeg'), versionLine: 'ffmpeg version 6.1 fixture' },
    ffprobe: { versionLine: 'ffprobe version 6.1 fixture' }
  } };
}
function mainLogs(info, { environment = '{ isPackaged: true, platform: \'darwin\' }',
  mediaPath = info.binaries.ffmpeg.path, ffmpeg = '{ available: true, versionLine: \'ffmpeg version 6.1 fixture\' }',
  ffprobe = '{ available: true, versionLine: \'ffprobe version 6.1 fixture\' }' } = {}) {
  return `[main] Environment: ${environment}\n[main] FFmpeg path (production): ${mediaPath}\n` +
    `[main] Binary health probe result: { ffmpeg: ${ffmpeg}, ffprobe: ${ffprobe} }\n`;
}

describe('owned packaged startup log attestation', () => {
  it('accepts complete owned logs and keeps partial logs pending', () => {
    const info = packageInfo();
    expect(assertMainLogs(mainLogs(info), info)).toMatchObject({ isPackaged: true, selectedFfmpegPath: info.binaries.ffmpeg.path });
    expect(assertMainLogs('', info)).toBeNull();
    expect(assertMainLogs('Environment: { isPackaged: true }\n', info)).toBeNull();
    expect(assertMainLogs(mainLogs(info).slice(0, -4), info)).toBeNull();
  });

  it('parses the actual Node inspection format and refuses duplicate fields or executable expressions', () => {
    const info = packageInfo();
    const environment = { environment: 'development', apiUrl: API_URL, isPackaged: true, version: '4.6.0' };
    const health = {
      ffmpeg: { available: true, errno: null, error: null, versionLine: info.binaries.ffmpeg.versionLine },
      ffprobe: { available: true, errno: null, error: null, versionLine: info.binaries.ffprobe.versionLine }
    };
    expect(parseInspectedObject(inspect(environment))).toEqual(environment);
    expect(assertMainLogs(`Environment: ${inspect(environment)}\nFFmpeg path (production): ${info.binaries.ffmpeg.path}\nBinary health probe result: ${inspect(health)}`, info)).toMatchObject({ isPackaged: true });
    for (const malformed of ['{ isPackaged: true, isPackaged: false }', '{ value: process.exit() }',
      '{ value: (() => true)() }', '{ value: "unterminated }', '{ value: true } trailing']) {
      expect(() => parseInspectedObject(malformed)).toThrow('Malformed');
    }
    expect(() => assertMainLogs(mainLogs(info, { ffprobe: '{ available: true, available: false, versionLine: \'ffprobe version 6.1 fixture\' }' }), info)).toThrow('Malformed');
  });

  it.each([
    { environment: '{ isPackaged: false }' }, { environment: '{ platform: \'darwin\' }' },
    { environment: '{ note: \'isPackaged: true\' }' }, { mediaPath: '/old.app/ffmpeg' },
    { ffmpeg: '{ available: false, versionLine: \'ffmpeg version 6.1 fixture\' }' },
    { ffmpeg: '{ available: null, error: \'startup timeout\', versionLine: \'ffmpeg version 6.1 fixture\' }' },
    { ffmpeg: '{ error: \'available: true\', versionLine: \'ffmpeg version 6.1 fixture\' }' },
    { ffprobe: '{ available: true, versionLine: \'ffprobe version OTHER\' }' }
  ])('rejects false, missing, spoofed, wrong-path or unhealthy startup evidence: %j', patch => {
    const info = packageInfo();
    expect(() => assertMainLogs(mainLogs(info, patch), info)).toThrow();
  });

  it('rejects dev binary paths or duplicate records and handles braces inside quoted values without eval', () => {
    const info = packageInfo();
    const logs = mainLogs(info);
    expect(() => assertMainLogs(logs + '\nFFmpeg path (dev): /node_modules/ffmpeg', info)).toThrow('development');
    expect(() => assertMainLogs(logs + '\nEnvironment: { isPackaged: true }', info)).toThrow('Ambiguous');
    expect(() => assertMainLogs(logs + `\nFFmpeg path (production): ${info.binaries.ffmpeg.path}`, info)).toThrow('wrong packaged');
    expect(objectAfter('Label: { note: "brace } and escaped \\" quote", nested: { ok: true } } tail', 'Label:'))
      .toBe('{ note: "brace } and escaped \\" quote", nested: { ok: true } }');
    expect(objectAfter('Label: {' + ' '.repeat(16384) + '}', 'Label:')).toBeNull();
  });
});

function resultEvidence() {
  const output = path.join(root, 'audio.webm');
  const hash = createHash('sha256').update('complete synthetic output').digest('hex');
  return { result: { pass: true, problems: [], phase: 'uploaded', nativeArchiveExpected: true,
    nativeSource: { chunkCount: 1, sourceId: '12345678-1234-1234-1234-123456789abc' },
    uploadAttempts: 1, localSha256: hash, output }, finalized: { success: true, outputPath: output },
    receipt: { version: 3, sourceMode: 'native', sha256: hash, systemPcmIncluded: false,
      sourceIds: ['12345678-1234-1234-1234-123456789abc'] } };
}

describe('synthetic result and finalization custody gates', () => {
  it('requires a successful matching native result and verified receipt', () => {
    const { result, finalized, receipt } = resultEvidence();
    expect(assertCaptureResult(result, finalized, receipt)).toBe(true);
    expect(() => assertCaptureResult(result, null, receipt)).toThrow('custody gates');
  });

  it.each([
    ['result', { pass: false }], ['result', { problems: ['clock mismatch'] }], ['result', { phase: 'finalizing' }],
    ['result', { nativeArchiveExpected: false }], ['result', { uploadAttempts: 2 }], ['result', { localSha256: 'not-a-hash' }],
    ['finalized', { success: false }], ['finalized', { outputPath: '/other/output' }],
    ['receipt', { version: 2 }], ['receipt', { sourceMode: 'microphone' }], ['receipt', { sha256: '0'.repeat(64) }],
    ['receipt', { sourceIds: [] }], ['receipt', { sourceIds: ['other-source'] }],
    ['receipt', { sourceIds: ['12345678-1234-1234-1234-123456789abc', 'second'] }], ['receipt', { systemPcmIncluded: true }]
  ])('rejects changed %s evidence %j', (kind, patch) => {
    const evidence = resultEvidence();
    Object.assign(evidence[kind], patch);
    expect(() => assertCaptureResult(evidence.result, evidence.finalized, evidence.receipt)).toThrow('custody gates');
  });

  it.each([undefined, NaN, 0, -1, 1.5])('rejects malformed native chunk count %s', chunkCount => {
    const evidence = resultEvidence();
    evidence.result.nativeSource.chunkCount = chunkCount;
    expect(() => assertCaptureResult(evidence.result, evidence.finalized, evidence.receipt)).toThrow('custody gates');
  });

  it('rejects matching-but-missing output and source identifiers', () => {
    const missingOutput = resultEvidence();
    delete missingOutput.result.output;
    delete missingOutput.finalized.outputPath;
    expect(() => assertCaptureResult(missingOutput.result, missingOutput.finalized, missingOutput.receipt)).toThrow('custody gates');
    const missingSource = resultEvidence();
    delete missingSource.result.nativeSource.sourceId;
    missingSource.receipt.sourceIds = [undefined];
    expect(() => assertCaptureResult(missingSource.result, missingSource.finalized, missingSource.receipt)).toThrow('custody gates');
  });
});
