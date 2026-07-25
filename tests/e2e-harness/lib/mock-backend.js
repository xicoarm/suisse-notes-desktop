/**
 * Adversarial mock backend â€” the app talks to it exactly like production
 * (API_BASE_URL / VITE_API_URL point here), and each test scripts the
 * failure of the day.
 *
 * Modes (set via POST /__control/mode {mode} or per-scenario):
 *   ok                â€” everything succeeds
 *   upload-400        â€” upload endpoints reject terminally (400). The app must
 *                       attempt a BOUNDED number of times and STOP (the
 *                       ELECTRON-27 regression test).
 *   upload-500-once   â€” first upload attempt 500s, second succeeds (transient)
 *   upload-401-once   â€” first upload 401s, must refresh and succeed
 *   upload-cut-50     â€” socket destroyed halfway through the request body,
 *                       then succeeds (connection-reset resilience)
 *   upload-slow       â€” 20s stall before responding (timeout behavior)
 *   status-unknown    â€” status endpoint returns an unknown enum (drift test)
 *
 * Introspection: GET /__control/requests â†’ every request with timestamps,
 * so scenarios can assert "exactly N upload attempts in M minutes".
 */
'use strict';

const http = require('http');
const crypto = require('crypto');

const TEST_USER = {
  id: 'e2e-user-1',
  email: 'e2e@test.local',
  name: 'E2E Tester',
  role: 'USER',
};

function makeToken() {
  // Looks like a JWT so any client-side decoding stays happy.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: TEST_USER.id, email: TEST_USER.email, exp })}.${crypto.randomBytes(8).toString('base64url')}`;
}

// Port 3000 â€” the renderer's hardwired dev default (src/services/api.js
// API_URLS.development). The main process is pointed here via API_BASE_URL.
function startMockBackend({ port = 3000 } = {}) {
  const state = {
    mode: 'ok',
    requests: [],           // { t, method, url, bodyBytes }
    uploads: new Map(),     // audioFileId -> { recordId, status }
    counters: new Map(),    // per-key attempt counters for -once modes
  };

  const bump = (key) => {
    const n = (state.counters.get(key) || 0) + 1;
    state.counters.set(key, n);
    return n;
  };

  // The renderer fetches cross-origin (dev server / file:// origin â†’ this
  // localhost port), so every response needs permissive CORS or the browser
  // blocks it and the app falls back to defaults (e.g. "no credits"). Reflect
  // the origin and allow credentials so cookie/Authorization requests pass.
  const cors = (req) => ({
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Authorization,Content-Type,X-Requested-With',
    'Access-Control-Max-Age': '600',
  });

  const json = (res, code, obj, req) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(req ? cors(req) : {}),
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    let bodyBytes = 0;
    const chunks = [];
    const wantBody = req.headers['content-type']?.includes('json') && url.startsWith('/__control');

    // CORS preflight â€” answer before any body handling.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(req));
      res.end();
      return;
    }

    // upload-cut-50: kill the socket halfway through a large request body.
    let cutAt = null;
    if (state.mode === 'upload-cut-50' && url === '/api/desktop/upload' && req.headers['content-length']) {
      const total = parseInt(req.headers['content-length'], 10);
      if (total > 100_000 && bump('cut') === 1) cutAt = Math.floor(total / 2);
    }

    req.on('data', (c) => {
      bodyBytes += c.length;
      if (wantBody) chunks.push(c);
      if (cutAt !== null && bodyBytes >= cutAt) {
        state.requests.push({ t: Date.now(), method: req.method, url, bodyBytes, note: 'SOCKET CUT' });
        req.socket.destroy();
      }
    });

    req.on('end', () => {
      state.requests.push({ t: Date.now(), method: req.method, url, bodyBytes });

      // â”€â”€ Control surface â”€â”€
      if (url === '/__control/mode' && req.method === 'POST') {
        try {
          const { mode } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          state.mode = mode || 'ok';
          state.counters.clear();
          return json(res, 200, { ok: true, mode: state.mode }, req);
        } catch (e) { return json(res, 400, { error: e.message }, req); }
      }
      if (url === '/__control/requests') {
        return json(res, 200, { mode: state.mode, requests: state.requests, uploads: [...state.uploads.entries()] }, req);
      }
      if (url === '/__control/reset') {
        state.requests.length = 0;
        state.counters.clear();
        state.uploads.clear();
        state.mode = 'ok';
        return json(res, 200, { ok: true }, req);
      }

      // â”€â”€ Auth â”€â”€
      if (url === '/api/auth/login' || url === '/api/auth/desktop') {
        return json(res, 200, { success: true, token: makeToken(), user: TEST_USER }, req);
      }
      if (url === '/api/auth/refresh') {
        return json(res, 200, { success: true, token: makeToken(), user: TEST_USER }, req);
      }
      if (url === '/api/auth/logout') return json(res, 200, { success: true }, req);
      if (url === '/api/analytics/auth-event') return json(res, 200, { ok: true }, req);

      // â”€â”€ Profile / settings / minutes / vocab â”€â”€
      if (url === '/api/user/profile') return json(res, 200, { user: TEST_USER }, req);
      if (url === '/api/user/settings') return json(res, 200, { settings: {} }, req);
      if (url === '/api/desktop/minutes' || url === '/api/user/minutes') {
        // Unlimited credits for the E2E user â€” credit exhaustion is tested by
        // scripting THIS endpoint, never by accident.
        return json(res, 200, { remaining: -1, total: -1, used: 0, unlimited: true }, req);
      }
      if (url.startsWith('/api/custom-spelling')) return json(res, 200, { entries: [] }, req);
      if (url.startsWith('/api/desktop/templates')) return json(res, 200, { templates: [] }, req);
      if (url.startsWith('/api/context-files')) return json(res, 200, { files: [] }, req);
      if (url === '/api/desktop/history') return json(res, 200, { recordings: [], meetings: [] }, req);

      // â”€â”€ SAS init: force the legacy POST path (production reality today) â”€â”€
      if (url === '/api/uploads/init') {
        return json(res, 200, { mode: 'fallback' }, req);
      }

      // â”€â”€ Legacy upload â”€â”€
      if (url === '/api/desktop/upload' && req.method === 'POST') {
        const attempt = bump('upload');
        if (state.mode === 'upload-400') {
          return json(res, 400, { error: 'E2E: permanently malformed upload (scripted)' }, req);
        }
        if (state.mode === 'upload-500-once' && attempt === 1) {
          return json(res, 500, { error: 'E2E: transient server error (scripted)' }, req);
        }
        if (state.mode === 'upload-401-once' && attempt === 1) {
          return json(res, 401, { error: 'E2E: token expired (scripted)' }, req);
        }
        if (state.mode === 'upload-slow' && attempt === 1) {
          setTimeout(() => {
            const audioFileId = `e2e-audio-${crypto.randomUUID()}`;
            state.uploads.set(audioFileId, { status: 'PROCESSING' });
            json(res, 200, { success: true, audioFileId, transcriptionId: audioFileId, meetingId: `e2e-meeting-${attempt}` });
          }, 20_000);
          return;
        }
        const audioFileId = `e2e-audio-${crypto.randomUUID()}`;
        state.uploads.set(audioFileId, { status: 'PROCESSING' });
        return json(res, 200, { success: true, audioFileId, transcriptionId: audioFileId, meetingId: `e2e-meeting-${attempt}` }, req);
      }

      // â”€â”€ Upload status poll â”€â”€
      const statusMatch = url.match(/^\/api\/desktop\/upload\/([^/]+)\/status$/);
      if (statusMatch) {
        if (state.mode === 'status-unknown') {
          return json(res, 200, { status: 'QUEUED_FOR_SOMETHING_NEW' }, req);
        }
        const up = state.uploads.get(statusMatch[1]);
        return json(res, 200, { status: up ? up.status : 'PROCESSING' }, req);
      }
      if (url.startsWith('/api/desktop/meeting/')) {
        return json(res, 200, { status: 'COMPLETED' }, req);
      }
      if (url.startsWith('/api/desktop/recording')) {
        return json(res, 200, { success: true }, req);
      }

      // Default: succeed blandly so unrelated calls never block a scenario.
      return json(res, 200, { ok: true, e2eDefault: true }, req);
    });
  });

  return new Promise((resolve) => {
    // No host binding: dual-stack, so the renderer's "localhost" (which may
    // resolve to ::1 on Windows) and the main process's 127.0.0.1 both land.
    server.listen(port, () => {
      resolve({
        server,
        port,
        url: `http://localhost:${port}`,
        state,
        setMode: (m) => { state.mode = m; state.counters.clear(); },
        close: () => new Promise(r => server.close(r)),
      });
    });
  });
}

module.exports = { startMockBackend };

// Standalone: `node lib/mock-backend.js [port]`
if (require.main === module) {
  const port = parseInt(process.argv[2] || '3999', 10);
  startMockBackend({ port }).then(({ url }) => {
    console.log(`Mock backend listening on ${url} (control: ${url}/__control/requests)`);
  });
}

