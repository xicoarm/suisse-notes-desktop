// Route outbound HTTPS from the Electron MAIN process through the proxy the
// operating system is configured to use (WinINET/PAC on Windows, System
// Configuration on macOS).
//
// WHY: the main process runs on Node, which only honors http(s)_proxy env vars
// and knows nothing about OS proxy settings or PAC scripts. Chromium (the
// renderer) evaluates them natively. On networks that ENFORCE a proxy and drop
// direct outbound TCP (hospitals, banks), every main-process axios call —
// auth, minutes, uploads — dies with "connect ETIMEDOUT <ip>:443" while the
// renderer logs in fine. See Sentry electron issue 7e8b8dd2 (action=
// history_upload, release 4.5.3, user @insel.ch — Inselspital enforcing a
// proxy). Same class of bug as os-ca.js (Node ignoring OS network config).
//
// HOW: an axios request interceptor asks Chromium (session.resolveProxy) for
// the proxy of each request URL and, when one is configured, tunnels the
// request through it via https-proxy-agent (HTTP CONNECT). Per-request
// resolution means PAC rules that differ per host (app server vs Azure blob)
// and laptops that roam between networks (home ↔ hospital) both behave
// correctly. Agents are cached per proxy endpoint for connection pooling.
//
// LIMITATION: proxies demanding NTLM/Kerberos auth on the CONNECT are not
// supported (Node has no SSPI); those fail with 407 — same outcome as before
// this fix, but now visible in main.log.
//
// Defensive by design: any failure here falls back to a direct connection,
// which is exactly the pre-fix behaviour. Must NEVER break a request.
const { app, session } = require('electron');
const axios = require('axios');
const log = require('electron-log');
const { HttpsProxyAgent } = require('https-proxy-agent');

const agentCache = new Map();    // proxy URL -> HttpsProxyAgent
const loggedOnce = new Set();    // log each distinct proxy/warning only once

function agentFor(proxyUrl) {
  let agent = agentCache.get(proxyUrl);
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
    agentCache.set(proxyUrl, agent);
  }
  return agent;
}

// Turn Chromium's PAC-style answer ("PROXY host:port; DIRECT", "HTTPS h:p",
// "SOCKS5 h:p", "DIRECT") into a proxy URL usable by https-proxy-agent, or
// null for direct / unsupported schemes. Only the first entry is used; PAC
// fallback chains ("PROXY a; DIRECT") are not walked — on proxy-enforcing
// networks the DIRECT fallback is blocked anyway, and the upload layer
// already retries on connection errors.
function parseResolvedProxy(pacString) {
  const first = (pacString || '').split(';')[0].trim();
  if (!first || /^DIRECT$/i.test(first)) return null;
  const [scheme, endpoint] = first.split(/\s+/);
  if (!endpoint) return null;
  if (/^PROXY$/i.test(scheme)) return `http://${endpoint}`;
  if (/^HTTPS$/i.test(scheme)) return `https://${endpoint}`;
  if (!loggedOnce.has(first)) {
    loggedOnce.add(first);
    log.warn(`[os-proxy] Unsupported proxy type from system config, going direct: ${first}`);
  }
  return null;
}

function installSystemProxy() {
  axios.interceptors.request.use(async (config) => {
    try {
      // Respect explicit per-request agents / proxy settings, and axios'
      // built-in http(s)_proxy env-var handling (proxy undefined = env
      // applies to requests we leave untouched).
      if (config.httpsAgent || config.proxy !== undefined) return config;
      if (!app.isReady()) return config; // session unavailable before ready

      const url = axios.getUri(config);
      if (!/^https:/i.test(url)) return config;

      const resolved = await session.defaultSession.resolveProxy(url);
      const proxyUrl = parseResolvedProxy(resolved);
      if (!proxyUrl) return config;

      if (!loggedOnce.has(proxyUrl)) {
        loggedOnce.add(proxyUrl);
        log.info(`[os-proxy] System proxy detected — tunnelling main-process HTTPS through ${proxyUrl}`);
      }
      config.httpsAgent = agentFor(proxyUrl);
      config.proxy = false; // the agent owns proxying; stop axios' own handling
    } catch (err) {
      if (!loggedOnce.has('resolve-error')) {
        loggedOnce.add('resolve-error');
        log.warn('[os-proxy] Proxy resolution failed (going direct):', err?.message);
      }
    }
    return config;
  });
  log.info('[os-proxy] System-proxy interceptor installed for main-process axios');
}

module.exports = { installSystemProxy };
