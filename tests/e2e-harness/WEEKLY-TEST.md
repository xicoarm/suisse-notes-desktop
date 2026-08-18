# Suisse Notes Desktop — Weekly Full-Feature Test Procedure

> **Cadence:** once per week, and always before cutting a release.
> **Goal:** prove that *every* user-facing feature works end-to-end against the
> **real** backend — not just "the app launches." A green run here is the gate
> for `npm run release`.
>
> This document is exhaustive on purpose. Each feature block states **what we
> test**, the **exact steps**, the **expected result**, and **how to verify it
> in the backend** (DB row, API response, or transcription output). If any block
> is red, do not release — file a finding in `FINDINGS.md` and fix-forward.
>
> **Why so thorough:** auto-update reaches every user within *hours* of a tag,
> and there is no rollback. A feature that silently half-works (Angela's dead
> Bluetooth mic; custom vocab that never reaches transcription) is worse than a
> crash because nobody notices until the customer complains. The weekly test
> exists to catch exactly that class before it ships.

---

## 0. Prerequisites & environment (do this once, reuse weekly)

| Thing | Value / how |
|---|---|
| Test user | `desktop-e2e@suisse-notes.test` (isolated, **unlimited minutes**). Provision/refresh via backend `node scripts/provision-e2e-user.mjs`. |
| Backend (prod) | `https://app.suisse-notes.ch` — `ssh suisse-notes`, code at `/home/ubuntu/Suisse-Notes-V2`. |
| DB access | `ssh suisse-notes` then `PGPASSWORD='<DB_PASSWORD from .env.local>' psql -h localhost -U <user> -d <db>`. The harness `lib/backend.js` already wires this — prefer `dbQuery()`. |
| Automated harness | `tests/e2e-harness/` in this repo. `node run-live.js` = real backend; `node run.js` = mock backend + forensic audio. |
| Packaged app under test | Build with `npm run build` → `dist/electron/Packaged/win-unpacked/Suisse Meets.exe`. **Always test the packaged build**, not `quasar dev` (dev has HMR/replay overhead that confounds timing). |
| E2E hooks | Packaged app honors `SUISSE_E2E_HOOKS=1` (enables fake-audio + CDP eval). Never ships enabled: gate is `!app.isPackaged || SUISSE_E2E_HOOKS==='1'`. |
| Sentry | Org `suisse-it-gmbh`, project `electron`. Filter by `release:suisse-notes@X.Y.Z`. Watch during + 24h after. |

**Safety:** always clean up test meetings afterward (`lib/backend.js`
`cleanupAllTestMeetings()`), and never run the weekly test on a real user's
account.

---

## 1. Automated harness pass (≈30 min active + endurance)

This is the backbone. Run it first; it catches most regressions unattended.

```bash
cd tests/e2e-harness
node run-live.js          # real backend: upload + transcription E2E (s-live)
node run.js               # mock backend: forensic audio + adverse conditions (s1–s6)
node run.js --endurance   # 5h15m single recording (s7) — run overnight/detached
```

What each scenario proves (all must be **PASS** in the run summary):

| ID | Proves | Backend-verified? |
|---|---|---|
| s-live | Real app → Azure SAS upload → `Meeting` row → transcription `COMPLETED` with correct segments | ✅ DB + transcript |
| s1 | Clean 10-min recording, audio bit-intact (no energy holes) | forensic |
| s2 | **Dead-mic (Angela class)** → MSIG fires "Keine Aufnahme" alert ~140s, no false alarm on real speech | client alert |
| s3 | Wedged MediaRecorder (ELECTRON-23) detected ~30s → stop-with-save | client |
| s4 | Upload recovery: transient 500 / expired token / socket cut all recover, file not lost | mock upload log |
| s5 | Crash recovery: renderer crash loses only in-flight ~3s chunk | recovered file |
| s6 | Auto-split at boundary: zero audio lost across the split | forensic |
| s7 | 5h15m endurance: no freeze, no drift, no leak, all audio intact | forensic + isAppAlive |

If `run-live.js` is green, the **upload + transcription contract is proven for
this build**. The manual matrix below covers what the harness can't drive
(SSO browser flows, system-audio device mixing, the prep/vocab UI).

---

## 2. Manual feature matrix

Do these against the **packaged build**, logged into the **test user**, pointed
at the **real backend**. Record pass/fail per row in §4.

### A. Login & authentication

Auth is the gate for everything; a broken login = no recordings reach the server.

| # | Test | Steps | Expected | Backend verify |
|---|---|---|---|---|
| A1 | Email/password login | Enter test-user creds → Sign in | Lands on main screen; minutes shown | `POST /api/auth/desktop` 200; a `Session`/token issued |
| A2 | Wrong password | Bad password → Sign in | Clear error, no crash, stays on login | 401 logged, no session |
| A3 | Microsoft SSO | Click "Sign in with Microsoft" → browser opens → consent → returns to app via `suissenotes://` | App receives deep-link, session established | MS token exchange 200; user matched |
| A4 | Google SSO | Same via Google | Same | Google token exchange 200 |
| A5 | Token refresh | Stay logged in >30 min while idle | No re-login prompt; silent refresh | Refresh endpoint hit ~every 30 min (note: code comment says "6h" but interval is 30 min — stale comment, behavior is 30 min) |
| A6 | Degraded/offline session | Kill network, relaunch app | App still allows **recording** on the cached grace token (by design — never block a recording on auth); upload queues until back online | Recording persists locally; uploads flush on reconnect |
| A7 | Logout | Log out | Returns to login; queued uploads preserved, not lost | Local queue intact on disk |
| A8 | Token-at-rest | Inspect stored token | Encrypted via OS `safeStorage`; **note:** falls back to plaintext if OS encryption unavailable (Linux/no-keychain) — flag if plaintext on Win/Mac | — |

**Why A6 matters:** a recording must never be blocked or lost because auth
hiccuped. This is the "record first, reconcile later" invariant.

### B. Core recording

| # | Test | Steps | Expected | Backend verify |
|---|---|---|---|---|
| B1 | Start/stop | Pick mic → Record 2 min speech → Stop | File finalizes; appears in History; uploads | `Meeting` row created; `durationSeconds ≈ 120` |
| B2 | Pause/resume | Record → Pause 20s → Resume → Stop | Single continuous file; paused span excluded; no gap/dup at seam | transcript continuous, no repeated words at seam |
| B3 | Mic selection | Switch mic in dropdown before recording | Chosen device is captured (verify label in `main.log`) | — |
| B4 | Chunk persistence | Record 1 min; watch `%APPDATA%\Suisse Notes\recordings\` (the folder name is a pinned MACHINE identifier — the rebranded app keeps it forever via src-electron/app-identity.js; there is NO migration) | New chunk file every ~3s (fsync per chunk) | files grow monotonically |
| B5 | Long meeting | Record ≥60 min (or trust s7 endurance) | No drift between wall-clock and audio length; no memory growth | `durationSeconds` matches audio |

### C. Dead-mic / Bluetooth failover (the Angela class — MSIG)

This is the reason the hardening branch exists. Verify the safety net, not just the happy path.

| # | Test | Steps | Expected | Verify |
|---|---|---|---|---|
| C1 | Dead device (zero signal) | Start recording, then disable/unplug the mic (or use s2 fake dead-audio) | Within ~140s: **"Keine Aufnahme erkannt"** warning surfaces; app does not silently record silence | client alert fires; `main.log` MSIG `ZERO_SIGNAL` |
| C2 | Bluetooth A2DP↔HFP flip | Record with a BT headset, trigger profile flip (connect/disconnect) | `devicechange` rebind re-acquires a live mic; recording continues; no permanent silence | `main.log` shows rebind; audio has signal after flip |
| C3 | Sequential failover | With multiple mics, pull the active one mid-recording | App re-acquires next available verified mic (tries up to 3), verifies signal post-switch (SWITCH_VERIFY_MS=5s) | `main.log` `LOW_LEVEL`/switch + post-switch signal OK |
| C4 | No false alarm | Record normal speech at normal volume | **No** dead-mic warning ever appears | clean run, no MSIG alert |

**⚠️ Hardware gap:** C2/C3 with a **real Bluetooth speakerphone** (the AI
speakerphones from Angela's incident) still need real hardware — cannot be fully
faked. Run at least once per month on a physical BT device.

### D. System audio capture

Capture the *other side* of a call (Teams/Zoom/system playback) mixed with the mic.

| # | Test | Steps | Expected | Verify |
|---|---|---|---|---|
| D1 | Enable system audio (Win) | Toggle "System audio" ON → play audio (music/video) + speak → record 1 min → stop | Final audio contains **both** mic speech and system playback (live loopback mix) | listen to file; transcript has both voices |
| D2 | Enable system audio (Mac) | Same on macOS | AudioTee captures PCM; FFmpeg `amix` merges at stop; both audible at full volume | listen; check FFmpeg merge in `main.log` |
| D3 | Mic-only default | Fresh launch, do NOT touch the toggle → record | Only mic captured | file has mic only |
| D4 | **Toggle resets OFF each session (intended)** | Enable system audio → quit → relaunch | Toggle is OFF again — **by design**. `config:getSystemAudioEnabled` returns hardcoded `false` (electron-main.js ~L5490); commit 81076f1 deliberately made it "always start inactive... instead of persisting across sessions" — privacy/safety so the app never silently captures system audio the user forgot was on. **Not a bug — do not fail this row.** User must re-enable each session by design. | — |

**Note:** no `systemAudioEnabled` flag is sent to the backend, so the server
cannot distinguish mic-only from mixed recordings. Not a data-loss bug, but
worth knowing when triaging "why are there two voices."

### E. Pre-meeting context / prep (name, context, template) → document creation

The user sets **title / context text / a template / context files BEFORE**
recording; these must reach the backend and drive document generation.

| # | Test | Steps | Expected | Backend verify |
|---|---|---|---|---|
| E1 | Meeting title | Set a title before recording → record → stop → upload | Title used for the meeting/document | `Meeting.title` = the entered title |
| E2 | Context text | Enter free-text context ("Quarterly review with ACME, discuss renewal") | Context stored + fed into document generation | `MeetingPrep` row via `Meeting.prepId`; `contextText` populated (upload route L405-408: `parseMeetingPrepInput` → `createMeetingPrep` → `linkPrepToMeeting`) |
| E3 | Template selection | Pick a template before recording | Chosen template drives the generated document structure | `MeetingPrep.templateId` set; generated doc follows template sections (`/api/desktop/templates/[id]/sections`) |
| E4 | Context files | Attach a PDF/doc as context before recording | File uploaded + linked; used as grounding for the document | `MeetingContextFile` row(s); `contextFileIds` linked to prep |
| E5 | Applied in output | After transcription, open the generated document | Document reflects the context/template (e.g., correct sections, references the ACME context) | inspect generated doc; confirm it used prep, not a generic template |

**How to verify E2–E4 in one shot (DB):**
```sql
-- after recording, find the meeting then its prep
SELECT id, title, "prepId" FROM "Meeting"
  WHERE "userId" = (SELECT id FROM "User" WHERE email='desktop-e2e@suisse-notes.test')
  ORDER BY "createdAt" DESC LIMIT 1;
SELECT id, "contextText", "templateId" FROM "MeetingPrep" WHERE id = '<prepId>';
SELECT id, "fileName" FROM "MeetingContextFile" WHERE "prepId" = '<prepId>';
```
All three must be populated when you set them in the UI. If `prepId` is NULL
after you entered context, prep is silently dropping — that's a P1.

**Known limitation:** prep currently drives **document generation** only. Title,
insights, and summaries do **not** yet consume prep. Don't fail E5 for insights
not reflecting context — that's expected scope, note it.

### F. Custom vocabulary / spelling

Proper nouns, product names, Swiss-German terms must transcribe correctly.

| # | Test | Steps | Expected | Backend verify |
|---|---|---|---|---|
| F1 | Add spelling word | Add a distinctive term (e.g., "Xylofonstrasse", a product name) in custom spelling UI | Word **saved to the account**, not just this session | `PUT/POST /api/custom-spelling/user` 200; word appears in `GET /api/custom-spelling/merged` |
| F2 | Applied in transcription | Record yourself clearly saying that term → stop → wait for transcription | Transcript spells it **exactly** as configured (not a phonetic guess) | transcript segment contains the exact term |
| F3 | Merged list | Check the effective vocab | Includes predefined Swiss terms + org vocab + your user spellings | `GET /api/custom-spelling/merged` returns the union |

**Critical mechanism note (verified in backend `lib/transcription/vocabulary.ts`):**
custom vocab reaches transcription via the **saved user/org lists**
(`getUserSpellings` + `getOrganizationVocabulary`), **NOT** via the per-recording
`metadata.customVocabulary` field — the desktop upload route does **not** read
that field. **Therefore F2 only works if F1 actually saved the word to the
account.** If a word is added in the UI but never POSTed to
`/api/custom-spelling/user`, it will silently NOT apply to transcription. **This
is the F-class thing to watch:** verify the save network call fires, not just
that the word shows in the local UI.

### G. Upload pipeline

| # | Test | Steps | Expected | Verify |
|---|---|---|---|---|
| G1 | Happy path | Record → stop with network up | Uploads to Azure via SAS; `Meeting` COMPLETED | `Meeting.status` progresses to `COMPLETED` |
| G2 | Network loss mid-upload | Start upload → kill network → restore | Retries, resumes, no data loss; file stays queued | file eventually uploads; no dup meeting |
| G3 | Queue persistence | Record offline → quit app → relaunch online | Queued upload survives restart and flushes | `Meeting` appears after relaunch |
| G4 | SAS init 404 fallback | (contract check) | Falls back to legacy POST if `/api/uploads/init` 404s (the 4.0.9–4.0.10 lesson) | no silent 404; legacy path used |
| G5 | Terminal error | Force a 400/413 | Tried once, not forever (ELECTRON-27 storm fix); user sees a clear failure | `uploadTerminal` latch set; no retry storm |
| G6 | Proxy network (Insel-class) | On a corporate proxy, upload | Honors OS proxy (main-process); NTLM-auth proxies still 407 (known gap) | `main.log`; watch for 407 |

### H. Transcription completion

| # | Test | Steps | Expected | Verify |
|---|---|---|---|---|
| H1 | Completes | After G1, wait | `Meeting.status = COMPLETED`; segments present | `SELECT status FROM "Meeting"...`; segment count > 0 |
| H2 | Segment correctness | Read the transcript | Text matches spoken content; timestamps sane | eyeball transcript vs known script |
| H3 | Language | Record in DE/FR/IT | Correct language detected/transcribed | transcript language matches |

### I. Adverse conditions

| # | Test | Steps | Expected | Verify |
|---|---|---|---|---|
| I1 | Battery low/critical | Simulate low battery during recording | **ALERT only** (warning at low, persistent negative at critical) — **never auto-stops** (per Marc's decision). Chunks already persisted every ~3s. | Notify appears; recording continues |
| I2 | Power kill mid-recording | Hard-kill the machine while recording (or run `node verify-recovery.js`) | On relaunch: `recoverOrphanedRecordings` reconstructs a valid file (all audio to the last ~3s chunk), the history entry flips `recording`→`pending`+filePath+`recovered`, a **"Recovered N recording(s)" toast** appears, and it **auto-uploads via the main-process queue** (works even if the renderer isn't logged in) | recovered file present; toast shown; `Meeting` reaches COMPLETED |
| I3 | App crash | Kill the renderer | Only in-flight ~3s chunk lost; rest recovered | see s5 |
| I4 | Disk full (ENOSPC) | Fill disk near finalize | Pre-combine space gate + 4-language retry dialog; recording recoverable | dialog appears; no corrupt file |
| I5 | Another app steals mic | Open another app that grabs exclusive mic | MSIG detects level drop → attempts re-acquire; if truly gone, dead-mic alert (not silent) | `main.log` MSIG |

### J. Auto-update

| # | Test | Steps | Expected | Verify |
|---|---|---|---|---|
| J1 | Update prompt | With a newer release available | Persistent translated dialog "Update now / Later"; **gated** so it never interrupts an active recording/upload | dialog only when not recording |
| J2 | Apply on quit | Choose "Update now" | Silent install + relaunch | new version in About dialog |

---

## 3. Backend verification cookbook

Run these from `ssh suisse-notes` (or via harness `dbQuery`). Substitute the
test-user email.

```sql
-- Latest meeting for the test user (title + prep link + status + duration)
SELECT id, title, status, "durationSeconds", "prepId", "createdAt"
FROM "Meeting"
WHERE "userId" = (SELECT id FROM "User" WHERE email='desktop-e2e@suisse-notes.test')
ORDER BY "createdAt" DESC LIMIT 3;

-- Prep detail (context text + template)
SELECT id, "contextText", "templateId" FROM "MeetingPrep" WHERE id='<prepId>';

-- Context files linked to a prep
SELECT id, "fileName", "mimeType" FROM "MeetingContextFile" WHERE "prepId"='<prepId>';

-- Transcript segment count + sample
SELECT count(*) FROM "TranscriptSegment" WHERE "meetingId"='<meetingId>';
```

API checks (with the test user's bearer token):
```bash
# Effective custom vocab (should include your F1 word)
curl -s -H "Authorization: Bearer <token>" https://app.suisse-notes.ch/api/custom-spelling/merged | jq
# Your saved user spellings
curl -s -H "Authorization: Bearer <token>" https://app.suisse-notes.ch/api/custom-spelling/user | jq
```

Log greps (client-side, `%APPDATA%\Suisse Notes\logs\main.log` — pinned machine identifier, see app-identity.js):
- MSIG: `grep -E 'ZERO_SIGNAL|LOW_LEVEL|switch|rebind' main.log`
- Upload: `grep -E 'upload|SAS|legacy|407|terminal' main.log`
- System audio: `grep -E 'AudioTee|amix|loopback|desktopCapturer' main.log`

Sentry (24h watch after release):
- `release:suisse-notes@X.Y.Z` — any new issue is a regression until triaged.
- Remember: **low event count ≠ rare** (ELECTRON-1B was 3 events = 100% feature
  breakage). Treat any new signal on a shipped feature as high priority.

---

## 4. Weekly sign-off

Fill this in each run; a release requires all **must-pass** rows green.

| Block | Must-pass rows | Result | Notes |
|---|---|---|---|
| 1 Automated | s-live, s1–s6 (s7 if release) | ☐ | |
| A Auth | A1, A3 or A4, A6 | ☐ | |
| B Recording | B1, B2, B4 | ☐ | |
| C Dead-mic | C1, C4 (C2/C3 monthly on HW) | ☐ | |
| D System audio | D1 (D2 on Mac) | ☐ | |
| E Prep | E1, E2, E3 | ☐ | |
| F Vocab | F1, F2 | ☐ | |
| G Upload | G1, G2, G3 | ☐ | |
| H Transcription | H1, H2 | ☐ | |
| I Adverse | I1, I2 | ☐ | |
| J Update | J1 | ☐ | |

**Open items carried forward (as of 2026-07-26):**
- C2/C3: real Bluetooth speakerphone hardware test outstanding.
- macOS AudioTee / FFmpeg merge / sleep-resume: never exercised on real Mac HW.
- G6: NTLM-authenticated corporate proxies still 407 (unsupported).
