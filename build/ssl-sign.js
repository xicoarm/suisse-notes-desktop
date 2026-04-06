const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Custom code signing script for SSL.com eSigner.
 * Called by electron-builder for each file that needs signing.
 * Requires CodeSignTool to be installed and CODE_SIGN_TOOL_PATH set.
 */
exports.default = async function (configuration) {
  const filePath = configuration.path;
  if (!filePath) return;

  // Only sign .exe and .dll files
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.exe' && ext !== '.dll') return;

  const toolPath = process.env.CODE_SIGN_TOOL_PATH;
  const credentialId = process.env.SSL_COM_CREDENTIAL_ID;
  const username = process.env.SSL_COM_USERNAME;
  const password = process.env.SSL_COM_PASSWORD;
  const totpSecret = process.env.SSL_COM_TOTP_SECRET;

  if (!toolPath || !credentialId || !username || !password || !totpSecret) {
    console.log(`Skipping signing for ${path.basename(filePath)} — SSL.com credentials not configured`);
    return;
  }

  console.log(`Signing ${path.basename(filePath)} with SSL.com eSigner...`);

  // Check if the file exists and is accessible
  if (!fs.existsSync(filePath)) {
    console.warn(`File not found, skipping: ${filePath}`);
    return;
  }

  const command = [
    `"${toolPath}"`,
    'sign',
    `-credential_id=${credentialId}`,
    `-username=${username}`,
    `-password=${password}`,
    `-totp_secret=${totpSecret}`,
    `-input_file_path="${filePath}"`,
    '-override'
  ].join(' ');

  try {
    execSync(command, { stdio: 'inherit', timeout: 120000 });
    console.log(`Signed: ${path.basename(filePath)}`);
  } catch (error) {
    console.error(`Failed to sign ${path.basename(filePath)}:`, error.message);
    throw error;
  }
};
