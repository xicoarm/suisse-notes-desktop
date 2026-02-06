# Suisse Notes - Project Context for AI Assistants

## Overview

**Suisse Notes** is a multi-tenant SaaS platform for automated meeting transcription, note-taking, and business intelligence. It's developed by **Suisse AI Group GmbH**, a Swiss company focused on AI-powered business tools.

The platform consists of three main components:
1. **Web Application** (`app.suisse-notes.ch`) - Next.js 16 app for viewing/managing meetings and transcripts
2. **Desktop Recording App** - Electron + Vue 3 + Quasar app for recording audio locally
3. **Transcription Service** (`transcribe.suisse-voice.ch`) - FastAPI service that interfaces with Soniox API

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                         │
├─────────────────────┬─────────────────────┬─────────────────────────────────┤
│   Web Browser       │   Desktop App       │   WhisperTranscribe (Legacy)    │
│   (Next.js PWA)     │   (Electron/Vue)    │   (Electron app)                │
└─────────┬───────────┴──────────┬──────────┴──────────────┬──────────────────┘
          │                      │                         │
          │                      │                         │
          ▼                      ▼                         │
┌─────────────────────────────────────────────┐            │
│        app.suisse-notes.ch                  │            │
│        (Next.js 16 + Prisma + PostgreSQL)   │            │
│                                             │            │
│  /api/desktop/upload - Receives audio,      │            │
│                        saves file,          │            │
│                        forwards to          │            │
│                        transcription        │            │
│                                             │            │
│  /api/internal/transcripts - Webhook that   │◄───────────┼────────────┐
│                              receives       │            │            │
│                              completed      │            │            │
│                              transcripts    │            │            │
│                              and creates    │            │            │
│                              Meeting        │            │            │
│                              records        │            │            │
└─────────────────────┬───────────────────────┘            │            │
                      │                                    │            │
                      ▼                                    ▼            │
          ┌───────────────────────────────────────────────────┐        │
          │      transcribe.suisse-voice.ch                   │        │
          │      (FastAPI + Soniox API)                       │        │
          │                                                   │        │
          │  1. Receives audio file (multipart)               │        │
          │  2. Saves locally to /home/ubuntu/audio-files     │        │
          │  3. Uploads to Soniox API                         │        │
          │  4. Polls for transcription completion            │        │
          │  5. Calls webhook with results ───────────────────┼────────┘
          │                                                   │
          └───────────────────────────────────────────────────┘
                      │
                      ▼
          ┌───────────────────────────────────────────────────┐
          │              Soniox API                           │
          │   (Third-party speech-to-text service)            │
          │   - Swiss German support                          │
          │   - Speaker diarization                           │
          │   - High accuracy for German/Swiss German         │
          └───────────────────────────────────────────────────┘
```

---

## Multi-Tenant Structure

Suisse Notes is a **multi-tenant SaaS** platform:

- **Organizations** - Top-level tenant (companies/teams)
- **Users** - Belong to an organization, have roles (admin, member)
- **Meetings** - Belong to a user, within an organization
- **Transcripts** - Belong to a meeting

### Key Database Models (Prisma)

```
Organization
  ├── Users[]
  ├── Teams[]
  └── Settings (subscription, features)

User
  ├── Meetings[]
  ├── Organization (belongsTo)
  └── Role (admin, member)

Meeting
  ├── Transcript[]
  ├── Participants[]
  ├── IntelligenceResults (AI-generated summaries, action items)
  └── AudioFile reference

Transcript
  ├── Segments[] (with speaker labels, timestamps)
  └── Meeting (belongsTo)
```

---

## Desktop App Details

**Repository:** `simple-meeting-recorder` (this repo)

**Tech Stack:**
- Electron (main process)
- Vue 3 + Composition API
- Quasar Framework (UI components)
- Pinia (state management)

**Key Features:**
- Local audio recording with chunk-based saving (prevents data loss)
- Automatic upload after recording stops
- Retry logic with exponential backoff for network failures
- Prevents app close during upload
- Recording history with local playback
- Storage preference: "Keep locally" or "Delete after upload"

### Recording Flow

```
1. User clicks Record
   └── useRecorder.js: getUserMedia() with selected microphone
   └── Creates recording session (generates UUID)
   └── MediaRecorder starts with 5-second timeslice

2. During Recording
   └── Chunks saved every 5 seconds via IPC
   └── electron-main.js: recording:saveChunk handler
   └── Chunks stored in: AppData/Roaming/Electron/recordings/{id}/chunks/

3. User clicks Stop
   └── Final chunk saved
   └── electron-main.js: recording:combineChunks
   └── FFmpeg combines chunks into single audio.webm

4. Auto-Upload
   └── Upload starts immediately after processing
   └── POST to app.suisse-notes.ch/api/desktop/upload
   └── Auth token in header (stored encrypted via safeStorage)

5. Server Processing
   └── File saved to /home/ubuntu/audio-files/
   └── Forwarded to transcribe.suisse-voice.ch/transcribe
   └── Transcription webhook creates Meeting record

6. User sees "Upload Complete"
   └── If "delete after upload" preference: local file deleted
   └── Recording added to history
```

### Key Files

| File | Purpose |
|------|---------|
| `src-electron/electron-main.js` | IPC handlers, upload logic, FFmpeg processing |
| `src-electron/electron-preload.js` | Exposes secure APIs to renderer |
| `src/composables/useRecorder.js` | MediaRecorder logic, microphone selection |
| `src/stores/recording.js` | Recording state (Pinia) |
| `src/stores/recordings-history.js` | History persistence |
| `src/pages/RecordPage.vue` | Main recording UI |
| `src/pages/HistoryPage.vue` | Recording history list |

---

## Web Application Details

**Server:** `185.79.233.140` (Ubuntu)
**Path:** `/home/ubuntu/Suisse-Notes-V2`
**Process Manager:** PM2 (`pm2 restart suisse-notes`)

**Tech Stack:**
- Next.js 16 (App Router)
- TypeScript
- Prisma ORM
- PostgreSQL
- TailwindCSS

### Key API Routes

| Route | Purpose |
|-------|---------|
| `/api/auth/desktop` | Desktop app authentication (email/password → JWT) |
| `/api/desktop/upload` | Receives audio from desktop, forwards to transcription |
| `/api/internal/transcripts` | Webhook: receives completed transcripts, creates Meeting |
| `/api/meetings` | CRUD for meetings |
| `/api/audio/[id]` | Stream audio files for playback |

### Authentication Flow (Desktop)

```
1. Desktop app: POST /api/auth/desktop
   Body: { email, password, deviceId, platform, appVersion }

2. Server validates credentials
   └── Creates/updates DesktopAppUser record
   └── Returns JWT token

3. Desktop stores token encrypted (Electron safeStorage)

4. All subsequent requests include:
   Header: Authorization: Bearer {token}
```

---

## Transcription Service Details

**Server:** Same server, Docker container (`swiss-german-api`)
**Path:** `/home/ubuntu/swiss-german/api_v2/main.py`
**URL:** `https://transcribe.suisse-voice.ch`

### Transcription Flow

```
1. POST /transcribe
   └── Multipart: file (audio), options (JSON)
   └── Headers: accountid, userid, platform, etc.

2. Service saves audio locally
   └── /home/ubuntu/audio-files/{uuid}.webm

3. Upload to Soniox API
   └── POST /v1/files → get file_id
   └── POST /v1/transcriptions → start transcription

4. Poll for completion
   └── GET /v1/transcriptions/{id} every 5 seconds
   └── Until status: "completed"

5. Get transcript
   └── GET /v1/transcriptions/{id}/transcript

6. Forward to Suisse Notes webhook
   └── POST http://127.0.0.1:3000/api/internal/transcripts
   └── Includes: transcriptionId, rawResponse, metadata

7. Cleanup
   └── DELETE transcription and file from Soniox
```

### Headers Expected by Transcription Service

When these headers are present, the service knows to forward results to Suisse Notes:

```
accountid: {user_id}         # Links to Suisse Notes user
userid: {user_id}            # Same as accountid for desktop
platform: win32|darwin       # OS
appversion: 1.0.0            # App version
deviceid: {device_uuid}      # Unique device identifier
```

---

## Environment Variables

### Web App (.env)
```
DATABASE_URL=postgresql://...
NEXTAUTH_SECRET=...
INTERNAL_API_SECRET=...          # For webhook authentication
TRANSCRIPTION_API_URL=https://transcribe.suisse-voice.ch
AUDIO_STORAGE_DIR=/home/ubuntu/audio-files
```

### Transcription Service
```
SONIOX_API_KEY=...
SUISSE_NOTES_WEBHOOK_URL=http://127.0.0.1:3000/api/internal/transcripts
INTERNAL_API_SECRET=...
```

### Desktop App (hardcoded)
```
API_BASE_URL=https://app.suisse-notes.ch
```

---

## Common Issues & Solutions

### "Recordings not appearing in web app"
- Check PM2 logs: `pm2 logs suisse-notes`
- Look for "Transcription service error" - usually means wrong request format
- The transcription service expects multipart file upload, not JSON

### "Upload fails with network error"
- Desktop app has retry logic (0s, 2s, 5s, 10s delays)
- Check if server is reachable
- Files are saved locally even if upload fails

### "Audio playback not working in desktop history"
- Uses custom `local-audio://` protocol registered in electron-main.js
- Check if file exists at the stored path

### "Building Next.js runs out of memory"
```bash
NODE_OPTIONS='--max-old-space-size=4096' npm run build
```

---

## Deployment Commands

### Restart Web App
```bash
ssh ubuntu@185.79.233.140
source ~/.nvm/nvm.sh
cd /home/ubuntu/Suisse-Notes-V2
npm run build
pm2 restart suisse-notes
```

### View Logs
```bash
pm2 logs suisse-notes --lines 100
```

### Restart Transcription Service
```bash
docker restart swiss-german-api
```

---

## Brand Guidelines

- **Name:** "Suisse Notes" (two words, no hyphen)
- **Colors:** Indigo (#6366F1) primary, Purple (#8B5CF6) secondary
- **Font:** Inter (body), JetBrains Mono (code/timer)

---

## Related Projects

- **WhisperTranscribe** - Legacy desktop app (similar purpose, different codebase)
- **SuisseGPT** - AI chat product (separate)
- **Suisse Voice** - Voice AI services (includes transcription service)

---

## Contact & Resources

- **Production URL:** https://app.suisse-notes.ch
- **Transcription API:** https://transcribe.suisse-voice.ch
- **Server IP:** 185.79.233.140
- **Company:** Suisse AI Group GmbH (Swiss company)

---

## Desktop Release Process (CRITICAL)
- Release workflow: `.github/workflows/release.yml`, triggered on `v*` tags
- Release steps: `npm run release:patch` → `git push --follow-tags origin main`
- `standard-version` bumps version in package.json, creates CHANGELOG, tags with `v*`
- **Windows**: `npm run build` with `GH_TOKEN` → electron-builder auto-publishes to GitHub Release
- **macOS**: `npx quasar build -m electron -P never` → sign → notarize → upload via `action-gh-release`
- The `-P never` flag is Quasar's pass-through to electron-builder's `--publish never`
- NEVER use `PUBLISH` env var or `SKIP_PUBLISH` — electron-builder does NOT read these
- NEVER set `publish: null` in quasar.config.js — it prevents `latest-mac.yml` generation

### How to Release a New Version

```bash
# 1. Bump version (uses standard-version)
npm run release:patch    # 3.7.29 → 3.7.30 (bug fixes)
npm run release:minor    # 3.7.29 → 3.8.0 (new features)
npm run release:major    # 3.7.29 → 4.0.0 (breaking changes)

# 2. Push version bump + git tag
git push --follow-tags origin main

# 3. Done! GitHub Actions will:
#    - Build for Windows (auto-publish to GitHub Release)
#    - Build for macOS (sign, notarize, then upload to GitHub Release)
#    - Generate latest.yml and latest-mac.yml for auto-updates
```

## Auto-Update (CRITICAL - DO NOT BREAK)
- `quasar.config.js` → `builder.publish` config MUST always be present (never conditional/null)
- This config generates `latest.yml` (Windows) and `latest-mac.yml` (macOS) during build
- `electron-updater` in the app reads `app-update.yml` (embedded at build time) to find the GitHub repo
- Then fetches `latest-mac.yml` / `latest.yml` from the latest GitHub Release to check for updates
- macOS auto-update uses the `.zip` files (not DMGs) — both x64 and arm64 zips must be present
- Release workflow has validation guards that FAIL the build if auto-update files are missing
- Three guards: Windows post-build, macOS post-build, macOS post-upload verification
- Auto-update settings in `electron-main.js`: `autoDownload=true`, `autoInstallOnAppQuit=true`
- KNOWN BUG: electron-builder generates filenames with dots (Suisse.Notes-) but latest-mac.yml references dashes (Suisse-Notes-)
- Fix: release workflow runs `sed -i '' 's/Suisse-Notes-/Suisse.Notes-/g' latest-mac.yml` to update yml to match files
- DO NOT try to rename files to match yml — just update yml to match files (simpler, more reliable)
- DO NOT try to detect the mismatch conditionally — just always run the sed (it's a no-op if already matching)
- NEVER use `artifactName` in mac config to fix this — electron-builder ignores it for latest-mac.yml (known bug #2706)

### Dot/Dash Filename Fix - Lessons Learned (v3.7.24–v3.7.29)
The following approaches were tried and FAILED. Do NOT repeat them:

**FAILED Approach 1: Rename files to match yml (v3.7.24)**
```bash
# WRONG — DO NOT DO THIS
for file in *.dmg *.zip *.blockmap; do
  newname=$(echo "$file" | sed 's/^Suisse\.Notes-/Suisse-Notes-/')
  mv "$file" "$newname"
done
# Then verify yml references match renamed files
grep "url:" latest-mac.yml | sed 's/.*url: //' | while read -r fname; do
  [ ! -f "$fname" ] && exit 1  # THIS ONLY EXITS SUBSHELL, NOT SCRIPT
done
```
Why it failed: (1) Renaming files then verifying is fragile — the verification parsing
of latest-mac.yml kept failing due to invisible characters or YAML format variations.
(2) `while read` in a pipe creates a subshell — `exit 1` only exits the subshell,
not the parent script.

**FAILED Approach 2: Conditional detection with if/elif (v3.7.27, v3.7.28)**
```bash
# WRONG — DO NOT DO THIS
if ls Suisse.Notes-*.zip 1>/dev/null 2>&1 && grep -q 'Suisse-Notes-' latest-mac.yml; then
  sed -i '' 's/Suisse-Notes-/Suisse.Notes-/g' latest-mac.yml
fi
```
Why it failed: The conditional detection (`ls` + `grep`) consistently fell through
to the else branch in CI even though the mismatch existed. The exact cause is unclear
(possibly globbing behavior differences on macOS CI runners), but the detection
logic never triggered the sed fix. v3.7.28 passed but the yml was NOT updated.

**WORKING Approach (v3.7.29):**
```bash
# CORRECT — ALWAYS DO THIS
sed -i '' 's/Suisse-Notes-/Suisse.Notes-/g' latest-mac.yml
```
Why it works: No detection, no conditionals, no verification parsing. Just
unconditionally run sed. Since electron-builder ALWAYS produces this mismatch
for productName "Suisse Notes", and sed is a no-op if there's nothing to replace,
this is safe and reliable.

**Key principles:**
1. NEVER add conditional logic around this sed — just run it unconditionally
2. NEVER try to rename files — update the yml instead
3. NEVER use `while read` in a pipe for verification — it creates a subshell
4. Keep CI workflow steps as simple as possible — complex bash in YAML is fragile
5. If you can't access CI logs to debug, simplify the code instead of adding more logic

## Mobile Release Workflow
- `.github/workflows/mobile-release.yml` triggers on push to main
- Watches: `src/**`, `src-capacitor/**`, `quasar.config.js` (NOT `package.json`)
- Skips `chore(release):` commits (desktop version bumps) and `[skip ci]` commits
- Deploys to TestFlight (iOS) and Play Store Internal (Android) via Fastlane
- Desktop and mobile share `src/` so i18n or shared component changes trigger both workflows

## Multi-Platform Development
Every change and every implementation should consider all four platforms: desktop Windows, desktop macOS, mobile Android, and mobile iOS. Always make implementations adaptable for all platforms, and if needed, create individual solutions to support all four platforms equally.