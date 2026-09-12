/**
 * Device server — serves the real Capacitor web bundle and plays the phone's
 * storage: a virtual file system on disk (one root per scenario), the
 * `/_capacitor_file_/…` route the WebView would serve for `convertFileSrc`
 * URIs, and the native chunk combiner. Files end up as ordinary files under
 * work/device/<name>/fs/<DIRECTORY>/…, where the forensic verifier and the
 * scenarios can read them directly.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.map': 'application/json', '.txt': 'text/plain'
};

function safeJoin(root, rel) {
  const p = path.resolve(root, rel.replace(/^\/+/, ''));
  if (!p.startsWith(path.resolve(root))) throw Object.assign(new Error('path escapes root'), { code: 'EACCES' });
  return p;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function statEntry(abs, name, uri) {
  const st = fs.statSync(abs);
  return { name, type: st.isDirectory() ? 'directory' : 'file', size: st.size, mtime: Math.round(st.mtimeMs), ctime: Math.round(st.ctimeMs), uri };
}

async function startDeviceServer({ name, platform = 'android', wwwDir, port = 0, root }) {
  const deviceRoot = root || path.join(__dirname, '..', 'work', 'device', name);
  const fsRoot = path.join(deviceRoot, 'fs');
  fs.mkdirSync(fsRoot, { recursive: true });
  const log = [];

  const uriFor = (directory, rel) => (platform === 'android'
    ? `file:///storage/emulated/0/Android/data/ch.suissenotes.app/files/__${directory}__/${rel}`
    : `file:///var/mobile/Containers/Data/Application/E2E/__${directory}__/${rel}`);
  const dirRoot = (directory) => {
    const d = String(directory || 'DOCUMENTS').toUpperCase();
    const abs = path.join(fsRoot, d);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  };

  const ops = {
    writeFile({ path: rel, data, directory, recursive, encoding }) {
      const abs = safeJoin(dirRoot(directory), rel);
      if (!fs.existsSync(path.dirname(abs))) {
        if (!recursive) throw new Error('Parent folder doesn\'t exist');
        fs.mkdirSync(path.dirname(abs), { recursive: true });
      }
      fs.writeFileSync(abs, encoding ? Buffer.from(String(data), 'utf8') : Buffer.from(String(data), 'base64'));
      return { uri: uriFor(directory, rel) };
    },
    appendFile({ path: rel, data, directory, encoding }) {
      const abs = safeJoin(dirRoot(directory), rel);
      fs.appendFileSync(abs, encoding ? Buffer.from(String(data), 'utf8') : Buffer.from(String(data), 'base64'));
      return {};
    },
    readFile({ path: rel, directory, encoding }) {
      const abs = safeJoin(dirRoot(directory), rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new Error('File does not exist.');
      const buf = fs.readFileSync(abs);
      return { data: encoding ? buf.toString('utf8') : buf.toString('base64') };
    },
    deleteFile({ path: rel, directory }) {
      const abs = safeJoin(dirRoot(directory), rel);
      if (!fs.existsSync(abs)) throw new Error('File does not exist.');
      fs.unlinkSync(abs);
      return {};
    },
    mkdir({ path: rel, directory, recursive }) {
      const abs = safeJoin(dirRoot(directory), rel);
      if (fs.existsSync(abs)) throw new Error('Directory exists');
      if (!recursive && !fs.existsSync(path.dirname(abs))) throw new Error('Parent directory must exist');
      fs.mkdirSync(abs, { recursive: !!recursive });
      return {};
    },
    rmdir({ path: rel, directory, recursive }) {
      const abs = safeJoin(dirRoot(directory), rel);
      if (!fs.existsSync(abs)) throw new Error('Directory does not exist');
      if (!recursive && fs.readdirSync(abs).length) throw new Error('Directory is not empty');
      fs.rmSync(abs, { recursive: true, force: true });
      return {};
    },
    readdir({ path: rel, directory }) {
      const abs = safeJoin(dirRoot(directory), rel);
      if (!fs.existsSync(abs)) throw new Error('Directory does not exist');
      const files = fs.readdirSync(abs).map(n => statEntry(path.join(abs, n), n, uriFor(directory, path.posix.join(rel, n))));
      return { files };
    },
    stat({ path: rel, directory }) {
      const abs = safeJoin(dirRoot(directory), rel);
      if (!fs.existsSync(abs)) throw new Error('Entry does not exist.');
      return statEntry(abs, path.basename(abs), uriFor(directory, rel));
    },
    rename({ from, to, directory, toDirectory }) {
      const src = safeJoin(dirRoot(directory), from);
      const dst = safeJoin(dirRoot(toDirectory || directory), to);
      if (!fs.existsSync(src)) throw new Error('File does not exist.');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return {};
    },
    copy({ from, to, directory, toDirectory }) {
      const src = safeJoin(dirRoot(directory), from);
      const dst = safeJoin(dirRoot(toDirectory || directory), to);
      if (!fs.existsSync(src)) throw new Error('File does not exist.');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
      return { uri: uriFor(toDirectory || directory, to) };
    }
  };

  /** The native combiner: chunk_000000.webm … concatenated in index order. */
  function combine({ recordId }) {
    for (const directory of ['EXTERNAL', 'DOCUMENTS']) {
      const dir = path.join(fsRoot, directory, 'recordings', recordId, 'chunks');
      if (!fs.existsSync(dir)) continue;
      const chunks = fs.readdirSync(dir).filter(n => /^chunk_\d+\.\w+$/.test(n)).sort();
      if (!chunks.length) return { success: false, error: 'No chunks found' };
      const ext = path.extname(chunks[0]);
      const out = path.join(fsRoot, directory, 'recordings', recordId, `combined${ext}`);
      const fd = fs.openSync(out, 'w');
      try { for (const c of chunks) fs.writeSync(fd, fs.readFileSync(path.join(dir, c))); } finally { fs.closeSync(fd); }
      const fileSize = fs.statSync(out).size;
      log.push({ t: Date.now(), msg: `combine ${recordId}: ${chunks.length} chunks → ${fileSize} bytes (${directory})` });
      return { success: true, outputPath: `recordings/${recordId}/combined${ext}`, fileSize, chunkCount: chunks.length, duration: chunks.length * 3 };
    }
    return { success: false, error: 'Recording directory not found' };
  }

  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const json = (code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Access-Control-Allow-Origin': '*' }); res.end(b); };
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' }); return res.end(); }
      if (url.startsWith('/__device/fs/')) {
        const op = url.slice('/__device/fs/'.length);
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (!ops[op]) return json(400, { error: `unknown fs op ${op}` });
        try { return json(200, ops[op](body)); } catch (e) { return json(200, { error: e.message }); }
      }
      if (url === '/__device/combine') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        return json(200, combine(body));
      }
      if (url === '/__device/log') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        log.push({ t: Date.now(), msg: body.msg });
        return json(200, {});
      }
      if (url.startsWith('/_capacitor_file_/')) {
        // file:///…/__DIRECTORY__/<rel> → fs/<DIRECTORY>/<rel>
        const m = /__([A-Z_]+)__\/(.+)$/.exec(url);
        if (!m) return json(404, { error: 'not a device file' });
        const abs = safeJoin(path.join(fsRoot, m[1]), m[2]);
        if (!fs.existsSync(abs)) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
        const st = fs.statSync(abs);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Content-Length': st.size, 'Access-Control-Allow-Origin': '*' });
        return fs.createReadStream(abs).pipe(res);
      }
      // Static bundle (SPA: unknown paths fall back to index.html for hash routing).
      let rel = url === '/' ? '/index.html' : url;
      let abs = safeJoin(wwwDir, rel);
      if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) abs = path.join(wwwDir, 'index.html');
      const st = fs.statSync(abs);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      json(500, { error: e.message });
    }
  });

  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  const api = {
    server, port: actualPort, url: `http://localhost:${actualPort}`, root: deviceRoot, fsRoot, log, platform,
    /** Absolute path of a VFS file in whichever directory holds it. */
    find(rel) {
      for (const d of ['EXTERNAL', 'DOCUMENTS', 'CACHE', 'DATA']) {
        const p = path.join(fsRoot, d, rel);
        if (fs.existsSync(p)) return p;
      }
      return null;
    },
    /** Newest combined recording file in the VFS. */
    findCombined() {
      const out = [];
      for (const d of ['EXTERNAL', 'DOCUMENTS']) {
        const recs = path.join(fsRoot, d, 'recordings');
        if (!fs.existsSync(recs)) continue;
        for (const id of fs.readdirSync(recs)) {
          const dir = path.join(recs, id);
          if (!fs.statSync(dir).isDirectory()) continue;
          for (const f of fs.readdirSync(dir)) if (/^combined\.\w+$/.test(f)) out.push(path.join(dir, f));
        }
      }
      out.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return out[0] || null;
    },
    chunkCount(recordId) {
      for (const d of ['EXTERNAL', 'DOCUMENTS']) {
        const dir = path.join(fsRoot, d, 'recordings', recordId, 'chunks');
        if (fs.existsSync(dir)) return fs.readdirSync(dir).filter(n => /^chunk_/.test(n)).length;
      }
      return 0;
    },
    wipe() { fs.rmSync(fsRoot, { recursive: true, force: true }); fs.mkdirSync(fsRoot, { recursive: true }); },
    close: () => new Promise(r => server.close(r))
  };
  return api;
}

module.exports = { startDeviceServer };
