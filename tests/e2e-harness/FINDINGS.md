# Desktop App — Test Findings Log

The purpose of the E2E harness is **finding and documenting real defects in the
Suisse Notes desktop app** — lost audio, failed uploads, silent data loss,
desync, mislabeled state. This file is the running record.

Each finding: what the app did wrong, how it was found, severity, evidence,
and status. **Harness bring-up issues (bugs in the test code itself) do NOT
belong here** — only defects in the product (`src/`, `src-electron/`).

Severity: **P0** data loss / silent corruption reaching the user · **P1**
user-visible failure or wrong result · **P2** degraded behavior / bad UX ·
**P3** cosmetic / edge.

Status: `open` · `fixed (unreleased)` · `fixed (vX.Y.Z)` · `wontfix` · `investigating`.

---

## F-001 — Dev/packaged renderer silently calls PRODUCTION for minutes/history/templates
- **Severity:** P1 (real user impact in any non-production build; also a data-integrity risk)
- **Status:** fixed (unreleased) — branch `fix/mic-input-health-hardening`
- **Found by:** E2E harness bring-up — the renderer ignored the local mock and
  hit `https://app.suisse-notes.ch` for `/api/desktop/minutes`, `/history`,
  `/templates`, returning the real account's data (which then read as "no
  credits" and blocked recording).
- **Root cause:** `src/services/api.js` `getApiUrl()` (Electron path) calls
  `window.electronAPI.config.getApiUrl()`, but the preload
  (`src-electron/electron-preload.js`) never exposed `config.getApiUrl` — only
  `config.get`. The call was `undefined`, the `try` was skipped, and resolution
  fell through to the **production** fallback (`API_URLS.PRODUCTION`). So the
  renderer's REST calls targeted production regardless of the main process's
  configured backend.
- **Impact:** In development/staging builds the renderer and main process talk
  to DIFFERENT backends (main honors `API_BASE_URL`/env; renderer hardcodes
  production). Beyond testing, this means staging QA silently exercises the
  production minutes/history/templates APIs.
- **Fix:** Added `config:getApiUrl` IPC handler (returns `API_BASE_URL`) +
  preload binding, so the renderer inherits the main process's resolved base.
- **Evidence:** debug network trace showed `GET https://app.suisse-notes.ch/api/desktop/minutes`
  while `mainApiUrl` reported `http://localhost:3000`.

## F-002 — `getApiUrlSync` ignores the `VITE_API_URL` override (env split)
- **Severity:** P2 (config inconsistency; sync callers target a different host than async callers)
- **Status:** fixed (unreleased)
- **Found by:** same investigation as F-001.
- **Root cause:** `getApiUrl()` (async) honors `import.meta.env.VITE_API_URL`
  first; `getApiUrlSync()` did not — it went straight to environment defaults.
  Any sync caller (some history/minutes paths) could therefore hit a different
  backend than async callers within the same session.
- **Fix:** `getApiUrlSync()` now checks the same override first.

## F-003 — CORS: (context, not an app bug — recorded for completeness)
- The mock needed permissive CORS for the renderer's cross-origin fetches.
  This is expected browser behavior, NOT an app defect. The production backend
  sets CORS correctly. Noted only so it isn't re-investigated as a finding.

---

## Scenario coverage → what each actively checks for

| Scenario | Actively hunts for |
|---|---|
| s1-baseline | audio gaps/dup/truncation in a clean recording; exactly-once upload; correct duration |
| s2-angela-bt | **silent audio loss** on dead BT device; whether health UI warns (MSIG); level correctness across zeros/quiet |
| s3-autosplit | **audio loss at auto-split boundaries** (the 4h55m path); multi-session combine integrity |
| s4-storm | **upload retry storm** (ELECTRON-27) — must be bounded; local file must survive terminal failure |
| s5-resilience | **lost recordings** on transient 500 / expired token / socket-cut mid-upload — must recover, never delete |
| s6-crash | **lost audio** on renderer crash — recovery must combine what was captured |
| s7-endurance | everything above, sustained over 5h15m across the real split threshold |

Anything a verifier flags (missing pilot pulses = gap, extra = duplication,
short file = truncation, wrong level = capture defect) gets a new F-### entry
with the scenario, timestamps, and the `work/result_<scenario>.json` evidence.

---

_Findings below are appended as scenarios run._
