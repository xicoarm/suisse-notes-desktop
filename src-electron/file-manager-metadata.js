'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Files a file manager leaves in a folder a person opens: Finder's .DS_Store and
// AppleDouble companions (._name), Explorer's desktop.ini and Thumbs.db. This
// app never writes them and they are never audio. The strict checks of a
// recording's folders pass over them instead of refusing the recording: a
// customer who looked for his audio in Finder after a failed save could no
// longer recover or upload it. Nothing here changes or deletes a file.
const NAMES = new Set(['.ds_store', 'desktop.ini', 'thumbs.db']);

function isFileManagerMetadataName(name) {
  return typeof name === 'string' && (NAMES.has(name.toLowerCase()) || (name.startsWith('._') && name.length > 2));
}

// A plain file: not a folder, not a link (a Windows junction is a link).
function isRegularFile(directory, name) {
  try { return fs.lstatSync(path.join(directory, name)).isFile(); } catch { return false; }
}

// Only a regular file counts. A directory or link of such a name is not what a
// file manager writes and stays subject to the caller's normal validation.
function isFileManagerMetadata(directory, name) {
  return isFileManagerMetadataName(name) && isRegularFile(directory, name);
}

// What an entry is, without its name: a name in a recording folder can be
// personal (a file someone put there), and this text reaches logs and reports.
// Kind, extension, length and a short mark of the name are enough to tell a
// known system file from anything else: the mark of ".DS_Store" is always the
// same, the name cannot be read back from it.
function describeEntry(directory, name) {
  const text = String(name);
  let type = 'entry';
  try {
    const stat = fs.lstatSync(path.join(directory, text));
    if (stat.isSymbolicLink()) type = 'link';
    else if (stat.isDirectory()) type = 'directory';
    else if (stat.isFile()) type = 'file';
  } catch { /* gone again between listing and looking: still unexpected */ }
  const extension = /\.([a-z0-9]{1,8})$/i.exec(text.replace(/^\.+/, ''));
  const mark = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `${text.startsWith('.') ? 'hidden ' : ''}${type}${extension ? ` .${extension[1].toLowerCase()}` : ''}` +
    ` (name: ${text.length} characters, mark ${mark})`;
}

// The file-manager files inside one recording, as paths relative to it, for a
// log line. Bounded in depth and number: a recording's own tree is five levels
// deep (native-sources/<id>/chunks/<file>), and this is diagnostics only.
function findFileManagerMetadata(recordPath, { maxDepth = 5, maxFound = 20, maxEntries = 20000 } = {}) {
  const found = [];
  let seen = 0;
  const walk = (directory, depth) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= maxFound || ++seen > maxEntries) return;
      if (entry.isFile() && isFileManagerMetadataName(entry.name)) {
        // An AppleDouble companion carries the name of the file it belongs to.
        const shown = entry.name.startsWith('._') ? '._*' : entry.name;
        found.push(path.relative(recordPath, path.join(directory, shown)).split(path.sep).join('/'));
      } else if (entry.isDirectory() && depth < maxDepth) {
        walk(path.join(directory, entry.name), depth + 1);
      }
    }
  };
  walk(recordPath, 1);
  return found;
}

module.exports = { isFileManagerMetadataName, isFileManagerMetadata, isRegularFile, describeEntry, findFileManagerMetadata };
