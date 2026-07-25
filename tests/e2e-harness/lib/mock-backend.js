/**
 * Adversarial mock backend — the app talks to it exactly like production
 * (API_BASE_URL / VITE_API_URL point here), and each test scripts the
 * failure of the day.
 *
 * Modes (set via POST /__control/mode {mode} or per-scenario):
 *   ok                — everything succeeds
 *   upload-400        — upload endpoints reject terminally (400). The app must
 *                       attempt a BOUNDED number of times and STOP (the
 *                       ELECTRON-27 regression test).
 *   upload-500-once   — first upload attempt 500s, second succeeds (transient)
 *   upload-401-once   — first upload 401s, must refresh and succeed
 *   upload-cut-50     — socket destroyed halfway through the request body,
 *                       then succeeds (connection-reset resilience)
 *   upload-slow       — 20s stall before responding (timeout behavior)
 *   status-unknown    — status endpoint returns an unknown enum (drift test)
 *
 * Introspection: GET /__control/requests → every request with timestamps,
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

function startMockBackend({ port = 3999 } = {}) {
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

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    let bodyBytes = 0;
    const chunks = [];
    const wantBody = req.headers['content-type']?.includes('json') && url.startsWith('/__control');

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

      // ── Control surface ──
      if (url === '/__control/mode' && req.method === 'POST') {
        try {
          const { mode } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          state.mode = mode || 'ok';
          state.counters.clear();
          return json(res, 200, { ok: true, mode: state.mode });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (url === '/__control/requests') {
        return json(res, 200, { mode: state.mode, requests: state.requests, uploads: [...state.uploads.entries()] });
      }
      if (url === '/__control/reset') {
        state.requests.length = 0;
        state.counters.clear();
        state.uploads.clear();
        state.mode = 'ok';
        return json(res, 200, { ok: true });
      }

      // ── Auth ──
      if (url === '/api/auth/login' || url === '/api/auth/desktop') {
        return json(res, 200, { success: true, token: makeToken(), user: TEST_USER });
      }
      if (url === '/api/auth/refresh') {
        return json(res, 200, { success: true, token: makeToken(), user: TEST_USER });
      }
      if (url === '/api/auth/logout') return json(res, 200, { success: true });
      if (url === '/api/analytics/auth-event') return json(res, 200, { ok: true });

      // ── Profile / settings / minutes / vocab ──
      if (url === '/api/user/profile') return json(res, 200, { user: TEST_USER });
      if (url === '/api/user/settings') return json(res, 200, { settings: {} });
      if (url === '/api/desktop/minutes' || url === '/api/user/minutes') {
        return json(res, 200, { remainingMinutes: 600, remainingSeconds: 36000, totalMinutes: 600, unlimited: false });
      }
      if (url.startsWith('/api/custom-spelling')) return json(res, 200, { entries: [] });
      if (url.startsWith('/api/desktop/templates')) return json(res, 200, { templates: [] });
      if (url.startsWith('/api/context-files')) return json(res, 200, { files: [] });
      if (url === '/api/desktop/history') return json(res, 200, { recordings: [], meetings: [] });

      // ── SAS init: force the legacy POST path (production reality today) ──
      if (url === '/api/uploads/init') {
        return json(res, 200, { mode: 'fallback' });
      }

      // ── Legacy upload ──
      if (url === '/api/desktop/upload' && req.method === 'POST') {
        const attempt = bump('upload');
        if (state.mode === 'upload-400') {
          return json(res, 400, { error: 'E2E: permanently malformed upload (scripted)' });
        }
        if (state.mode === 'upload-500-once' && attempt === 1) {
          return json(res, 500, { error: 'E2E: transient server error (scripted)' });
        }
        if (state.mode === 'upload-401-once' && attempt === 1) {
          return json(res, 401, { error: 'E2E: token expired (scripted)' });
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
        return json(res, 200, { success: true, audioFileId, transcriptionId: audioFileId, meetingId: `e2e-meeting-${attempt}` });
      }

      // ── Upload status poll ──
      const statusMatch = url.match(/^\/api\/desktop\/upload\/([^/]+)\/status$/);
      if (statusMatch) {
        if (state.mode === 'status-unknown') {
          return json(res, 200, { status: 'QUEUED_FOR_SOMETHING_NEW' });
        }
        const up = state.uploads.get(statusMatch[1]);
        return json(res, 200, { status: up ? up.status : 'PROCESSING' });
      }
      if (url.startsWith('/api/desktop/meeting/')) {
        return json(res, 200, { status: 'COMPLETED' });
      }
      if (url.startsWith('/api/desktop/recording')) {
        return json(res, 200, { success: true });
      }

      // Default: succeed blandly so unrelated calls never block a scenario.
      return json(res, 200, { ok: true, e2eDefault: true });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
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
