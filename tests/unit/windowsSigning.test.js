// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Until 4.7.3 only the finished Windows installer was signed. Every file it
// installed - the app exe, its DLLs, ffmpeg, the uninstaller - was unsigned,
// so Windows 11 Smart App Control blocked the app outright and the Microsoft
// Store (which requires every PE file of an EXE installer to be signed) was
// closed. These checks keep the build signing every file and the release
// refusing to ship one that is not signed.
const quasarConfig = fs.readFileSync('quasar.config.js', 'utf8');
const releaseWorkflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));

describe('every Windows binary is signed during the build', () => {
  it('routes all of electron-builder\'s signing through the eSigner hook', () => {
    expect(quasarConfig).toContain("const windowsSign = require('./scripts/windows-sign.cjs');");
    expect(quasarConfig).toContain('sign: windowsSign,');
    // One signature per file: the default (sha1 + sha256) would call the hook
    // twice per file and pay for two eSigner signings.
    expect(quasarConfig).toContain("signingHashAlgorithms: ['sha256'],");
    // .exe is signed by default; the DLLs and native modules need this.
    expect(quasarConfig).toContain("signExts: ['.dll', '.node']");
  });

  it('makes a missing credential fail the release build instead of skipping', () => {
    const build = releaseWorkflow.slice(releaseWorkflow.indexOf('- name: Build and sign Electron app'));
    const step = build.slice(0, build.indexOf('\n      - name:', 10));
    expect(step).toContain("WINDOWS_SIGN_REQUIRED: '1'");
    for (const secret of ['SSL_COM_USERNAME', 'SSL_COM_PASSWORD', 'SSL_COM_CREDENTIAL_ID', 'SSL_COM_TOTP_SECRET']) {
      expect(step).toContain(`${secret}: \${{ secrets.${secret} }}`);
    }
  });

  it('pins the CodeSignTool download', () => {
    expect(releaseWorkflow).toMatch(/\$sha256 = '[0-9A-F]{64}'/);
    expect(releaseWorkflow).toContain('does not match the pinned');
  });

  it('verifies a real install before anything is uploaded', () => {
    const verify = releaseWorkflow.indexOf('./scripts/verify-windows-signatures.ps1');
    const upload = releaseWorkflow.indexOf('- name: Upload Windows artifacts to GitHub Release');
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(upload);
    // The old installer-only signing step must not come back.
    expect(releaseWorkflow).not.toMatch(/uses:\s*sslcom\/esigner-codesign/);
  });
});

describe('the signing hook', () => {
  const { signFile, credentials } = require('../../scripts/windows-sign.cjs');

  it('skips without credentials on local and PR builds', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(signFile('C:/build/Suisse Meets.exe', {})).resolves.toBe(false);
    expect(log.mock.calls.flat().join(' ')).toContain('skipped Suisse Meets.exe');
    log.mockRestore();
  });

  it('fails the build without credentials when signing is required', async () => {
    await expect(signFile('C:/build/ffmpeg.exe', { WINDOWS_SIGN_REQUIRED: '1' }))
      .rejects.toThrow(/cannot sign ffmpeg\.exe: missing username, password, credentialId, totpSecret, toolDir, javaHome/);
  });

  it('keeps working after a failed file (one failure does not jam the queue)', async () => {
    await expect(signFile('C:/build/a.dll', { WINDOWS_SIGN_REQUIRED: '1' })).rejects.toThrow();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(signFile('C:/build/b.dll', {})).resolves.toBe(false);
    log.mockRestore();
  });

  it('reads every credential from the environment', () => {
    const { missing } = credentials({
      SSL_COM_USERNAME: 'u', SSL_COM_PASSWORD: 'p', SSL_COM_CREDENTIAL_ID: 'c',
      SSL_COM_TOTP_SECRET: 't', CODE_SIGN_TOOL_PATH: 'x', JAVA_HOME: 'j',
    });
    expect(missing).toEqual([]);
  });
});

describe('the packaged app ships each binary once', () => {
  // The packaged app runs ffmpeg/ffprobe from resources/ffmpeg only; these npm
  // packages are the development fallback. As dependencies they shipped a
  // second, unused copy of both binaries (139 MB) that also had to be signed.
  it('keeps the ffmpeg npm packages out of the installer', () => {
    for (const name of ['@ffmpeg-installer/ffmpeg', '@ffprobe-installer/ffprobe']) {
      expect(packageJson.dependencies[name]).toBeUndefined();
      expect(packageJson.devDependencies[name]).toBeDefined();
    }
  });

  it('only requires them when running unpackaged', () => {
    const main = fs.readFileSync('src-electron/electron-main.js', 'utf8');
    const uses = [...main.matchAll(/require\('@ff(?:mpeg|probe)-installer\/ff(?:mpeg|probe)'\)/g)];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      const before = main.slice(Math.max(0, use.index - 900), use.index);
      expect(before).toMatch(/app\.isPackaged/);
    }
  });
});
