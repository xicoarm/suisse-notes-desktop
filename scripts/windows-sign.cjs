'use strict';

// Signs Windows executables with the SSL.com eSigner certificate
// (CN=Suisse IT GmbH) through CodeSignTool - every file, not only the
// installer.
//
// electron-builder calls this for each file it signs (quasar.config.js
// `win.sign`): the app executable after its icon and version resources are
// written, every .dll/.node/.exe inside the app, elevate.exe, the NSIS
// uninstaller and finally the installer.
//
// Until 4.7.3 only the finished installer was signed. Everything it installed
// was unsigned, so Windows 11 Smart App Control blocked the app outright (it
// checks every executable and DLL, not only downloads), and the Microsoft
// Store route for EXE installers - which requires every PE file to be signed -
// was closed.
//
// Without eSigner credentials (local and PR builds) it skips. With
// WINDOWS_SIGN_REQUIRED=1 (the release job) a missing credential or a
// signature that does not verify fails the build instead of shipping an
// unsigned file.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SIGNER_SUBJECT_PREFIX = 'CN=Suisse IT GmbH,';
// CodeSignTool picks the signature format from the file extension and rejects
// ".node" ("Unsupported file format for signing - node"), although a native
// Node module is an ordinary PE DLL. Such files are signed as a ".dll" copy.
const CODESIGNTOOL_EXTENSIONS = new Set(['.exe', '.dll', '.msi']);

function needsDllAlias(file) {
  return !CODESIGNTOOL_EXTENSIONS.has(path.extname(file).toLowerCase());
}
const TOTP_WINDOW_MS = 30000;
const ATTEMPTS = 3;
const SIGN_TIMEOUT_MS = 5 * 60 * 1000;

// electron-builder signs several files concurrently. eSigner derives a one-time
// password from the TOTP secret for every signature, so the signatures run one
// after another and each one waits for its own 30-second TOTP window: a reused
// password is rejected, and repeated rejections can lock the credential.
let queue = Promise.resolve();
let lastWindow = -1;

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        output: `${stdout || ''}\n${stderr || ''}`,
      });
    });
  });
}

async function readSignature(file) {
  const env = { ...process.env, SIGN_TARGET: file };
  // The Actions default shell is PowerShell 7. Windows PowerShell 5.1 started
  // from it inherits PowerShell 7's PSModulePath, cannot load
  // Microsoft.PowerShell.Security and reports no signature at all.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  const script = "$ErrorActionPreference = 'Stop'; " +
    '$s = Get-AuthenticodeSignature -LiteralPath $env:SIGN_TARGET; ' +
    "$subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { '' }; " +
    "Write-Output ('SIGNATURE|' + $s.Status + '|' + $subject)";
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env });
  const line = result.output.split(/\r?\n/).find(text => text.startsWith('SIGNATURE|'));
  if (!line) {
    throw new Error(`cannot read the signature of ${path.basename(file)}: ${describeFailure(result.output)}`);
  }
  const [, status = '', subject = ''] = line.split('|');
  return { status: status.trim(), subject: subject.trim() };
}

function credentials(env = process.env) {
  const values = {
    username: env.SSL_COM_USERNAME,
    password: env.SSL_COM_PASSWORD,
    credentialId: env.SSL_COM_CREDENTIAL_ID,
    totpSecret: env.SSL_COM_TOTP_SECRET,
    toolDir: env.CODE_SIGN_TOOL_PATH,
    javaHome: env.JAVA_HOME,
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  return { values, missing };
}

function codeSignToolJar(toolDir) {
  const jarDir = path.join(toolDir, 'jar');
  const jar = fs.readdirSync(jarDir).find(name => /^code_sign_tool-.*\.jar$/.test(name));
  if (!jar) throw new Error(`CodeSignTool jar not found in ${jarDir}`);
  return path.join(jarDir, jar);
}

async function waitForFreshTotpWindow() {
  let window = Math.floor(Date.now() / TOTP_WINDOW_MS);
  if (window === lastWindow) {
    const wait = (window + 1) * TOTP_WINDOW_MS - Date.now() + 1500;
    await new Promise(resolve => setTimeout(resolve, wait));
    window = Math.floor(Date.now() / TOTP_WINDOW_MS);
  }
  lastWindow = window;
}

function describeFailure(output) {
  // CodeSignTool prints its own diagnostics; never echo the command line,
  // which carries the password and the TOTP secret.
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const relevant = lines.filter(line => /error|exception|invalid|denied|failed|limit|quota/i.test(line));
  return (relevant.length ? relevant : lines).slice(-5).join(' | ').slice(0, 800);
}

async function signNow(file, env = process.env) {
  const name = path.basename(file);
  const required = env.WINDOWS_SIGN_REQUIRED === '1';
  const { values, missing } = credentials(env);

  if (missing.length) {
    if (required) throw new Error(`cannot sign ${name}: missing ${missing.join(', ')}`);
    console.log(`  - windows-sign: skipped ${name} (no eSigner credentials; local or PR build)`);
    return false;
  }

  const before = await readSignature(file);
  if (before.status === 'Valid') {
    // Already signed - by us earlier in this build, or by its vendor (for
    // example Microsoft's d3dcompiler_47.dll). Keep that signature.
    console.log(`  - windows-sign: kept ${name} (already signed: ${before.subject.split(',')[0]})`);
    return false;
  }

  const java = path.join(values.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const jar = codeSignToolJar(values.toolDir);
  let target = file;
  let tempDir = null;
  if (needsDllAlias(file)) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-sign-'));
    target = path.join(tempDir, `${path.basename(file, path.extname(file))}.dll`);
    fs.copyFileSync(file, target);
  }
  try {
    return await signTarget({ file, target, name, java, jar, values });
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function signTarget({ file, target, name, java, jar, values }) {
  let lastError = '';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await waitForFreshTotpWindow();
    const result = await run(java, [
      '-Xmx2048M', '-jar', jar, 'sign',
      `-username=${values.username}`,
      `-password=${values.password}`,
      `-credential_id=${values.credentialId}`,
      `-totp_secret=${values.totpSecret}`,
      `-input_file_path=${target}`,
      '-override=true',
    ], { cwd: values.toolDir, timeout: SIGN_TIMEOUT_MS });
    const reportedSigned = result.code === 0 && /Code signed successfully/i.test(result.output);

    if (reportedSigned && target !== file) fs.copyFileSync(target, file);
    const after = await readSignature(file);
    if (after.status === 'Valid' && after.subject.startsWith(SIGNER_SUBJECT_PREFIX)) {
      console.log(`  - windows-sign: signed ${name}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return true;
    }
    lastError = `exit ${result.code}, signature ${after.status || 'none'} ${after.subject.split(',')[0]}: ` +
      describeFailure(result.output);
    // Every eSigner signature is billed. When the service reports the file as
    // signed but it does not verify, signing again would only pay for the same
    // result - stop and report instead. A rejected format fails the same way
    // on every attempt.
    if (reportedSigned || /Unsupported file format/i.test(result.output)) break;
    console.warn(`  - windows-sign: attempt ${attempt} for ${name} failed: ${lastError}`);
  }

  throw new Error(`could not sign ${name}: ${lastError}`);
}

function signFile(file, env = process.env) {
  const task = queue.then(() => signNow(file, env));
  queue = task.catch(() => {});
  return task;
}

// electron-builder custom sign hook: called once per file and hash algorithm
// (quasar.config.js limits signing to sha256, so once per file).
async function sign(configuration) {
  await signFile(configuration.path);
}

module.exports = sign;
module.exports.sign = sign;
module.exports.signFile = signFile;
module.exports.credentials = credentials;
module.exports.needsDllAlias = needsDllAlias;
module.exports.SIGNER_SUBJECT_PREFIX = SIGNER_SUBJECT_PREFIX;
