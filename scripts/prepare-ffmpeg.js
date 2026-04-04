#!/usr/bin/env node

/**
 * Prepare FFmpeg binaries for Electron packaging.
 *
 * Usage:
 *   node scripts/prepare-ffmpeg.js          # Current platform only (fast, uses local npm packages)
 *   node scripts/prepare-ffmpeg.js --all    # ALL platforms (downloads from npm registry)
 *
 * Downloads ffmpeg + ffprobe from the @ffmpeg-installer / @ffprobe-installer
 * npm packages and places them in resources/ffmpeg/{os}-{arch}/.
 *
 * The electron-builder config uses ${os}-${arch} in extraResources,
 * so each target build gets exactly the right binary.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RESOURCES_DIR = path.join(__dirname, '..', 'resources', 'ffmpeg');

// All platform/arch combinations we ship
const TARGETS = [
  { os: 'mac',   arch: 'x64',   npmPlatform: 'darwin-x64',  ext: '' },
  { os: 'mac',   arch: 'arm64', npmPlatform: 'darwin-arm64', ext: '' },
  { os: 'win',   arch: 'x64',   npmPlatform: 'win32-x64',   ext: '.exe' },
];

// Map Node.js process.platform to electron-builder ${os} values
const OS_MAP = { darwin: 'mac', win32: 'win', linux: 'linux' };

/**
 * Prepare binaries for the current platform using locally installed npm packages.
 */
function prepareCurrent() {
  const os = OS_MAP[process.platform];
  const arch = process.arch;

  if (!os) {
    console.error(`Unsupported platform: ${process.platform}`);
    process.exit(1);
  }

  let ffmpegSrc, ffprobeSrc;
  try {
    ffmpegSrc = require('@ffmpeg-installer/ffmpeg').path;
    ffprobeSrc = require('@ffprobe-installer/ffprobe').path;
  } catch (e) {
    console.error('Could not resolve @ffmpeg-installer/ffmpeg or @ffprobe-installer/ffprobe.');
    console.error('Run: npm install');
    process.exit(1);
  }

  const target = TARGETS.find(t => t.os === os && t.arch === arch);
  if (!target) {
    console.error(`No target config for ${os}-${arch}`);
    process.exit(1);
  }

  const targetDir = path.join(RESOURCES_DIR, `${os}-${arch}`);
  fs.mkdirSync(targetDir, { recursive: true });

  const ffmpegDest = path.join(targetDir, `ffmpeg${target.ext}`);
  const ffprobeDest = path.join(targetDir, `ffprobe${target.ext}`);

  fs.copyFileSync(ffmpegSrc, ffmpegDest);
  fs.copyFileSync(ffprobeSrc, ffprobeDest);

  if (!target.ext) {
    fs.chmodSync(ffmpegDest, 0o755);
    fs.chmodSync(ffprobeDest, 0o755);
  }

  console.log(`  ${os}-${arch}: OK`);
}

/**
 * Download and prepare binaries for ALL platforms using npm pack.
 * Works from any machine — downloads tarballs from the npm registry
 * without requiring the target OS.
 */
function prepareAll() {
  const tmpDir = path.join(__dirname, '..', '.ffmpeg-tmp');

  // Clean up any previous temp dir
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    for (const target of TARGETS) {
      const { os, arch, npmPlatform, ext } = target;
      const targetDir = path.join(RESOURCES_DIR, `${os}-${arch}`);
      fs.mkdirSync(targetDir, { recursive: true });

      const ffmpegDest = path.join(targetDir, `ffmpeg${ext}`);
      const ffprobeDest = path.join(targetDir, `ffprobe${ext}`);

      // Skip if both binaries already exist and are real files (> 1KB)
      if (
        fs.existsSync(ffmpegDest) && fs.statSync(ffmpegDest).size > 1024 &&
        fs.existsSync(ffprobeDest) && fs.statSync(ffprobeDest).size > 1024
      ) {
        console.log(`  ${os}-${arch}: already present, skipping`);
        continue;
      }

      const pkgDir = path.join(tmpDir, `${os}-${arch}`);
      fs.mkdirSync(pkgDir, { recursive: true });

      // Download ffmpeg
      console.log(`  ${os}-${arch}: downloading ffmpeg...`);
      execSync(`npm pack @ffmpeg-installer/${npmPlatform} --pack-destination "${pkgDir}"`, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const ffmpegTgz = fs.readdirSync(pkgDir).find(f => f.startsWith('ffmpeg-installer'));
      execSync(`tar xzf "${path.join(pkgDir, ffmpegTgz)}" -C "${pkgDir}"`);
      fs.copyFileSync(path.join(pkgDir, 'package', `ffmpeg${ext}`), ffmpegDest);

      // Clean for ffprobe download
      fs.rmSync(path.join(pkgDir, 'package'), { recursive: true, force: true });
      fs.unlinkSync(path.join(pkgDir, ffmpegTgz));

      // Download ffprobe
      console.log(`  ${os}-${arch}: downloading ffprobe...`);
      execSync(`npm pack @ffprobe-installer/${npmPlatform} --pack-destination "${pkgDir}"`, {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      const ffprobeTgz = fs.readdirSync(pkgDir).find(f => f.startsWith('ffprobe-installer'));
      execSync(`tar xzf "${path.join(pkgDir, ffprobeTgz)}" -C "${pkgDir}"`);
      fs.copyFileSync(path.join(pkgDir, 'package', `ffprobe${ext}`), ffprobeDest);

      // Set executable permissions on Unix binaries
      if (!ext) {
        fs.chmodSync(ffmpegDest, 0o755);
        fs.chmodSync(ffprobeDest, 0o755);
      }

      console.log(`  ${os}-${arch}: OK`);
    }
  } finally {
    // Clean up temp dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- Main ---
const all = process.argv.includes('--all');
console.log(`Preparing FFmpeg binaries${all ? ' for ALL platforms' : ''}...`);

if (all) {
  prepareAll();
} else {
  prepareCurrent();
}

console.log('Done.');
