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

## Desktop App Release & Auto-Updates

The desktop app uses **electron-updater** with **GitHub Releases** for automatic updates.

### Auto-Update Configuration

Located in `src-electron/electron-main.js`:
- `autoUpdater.autoDownload = true` — Updates download silently in the background
- `autoUpdater.autoInstallOnAppQuit = true` — Installs when user closes the app
- Checks for updates on startup + every 4 hours

### GitHub Release Settings

Located in `quasar.config.js`:
```javascript
publish: {
  provider: 'github',
  owner: 'xicoarm',
  repo: 'suisse-notes-desktop',
  releaseType: 'release',
  private: true
}
```

**GitHub Repo:** https://github.com/xicoarm/suisse-notes-desktop (private)

### How to Release a New Version

```bash
# 1. Bump version (uses standard-version)
npm run release:patch    # 3.3.4 → 3.3.5 (bug fixes)
npm run release:minor    # 3.3.4 → 3.4.0 (new features)
npm run release:major    # 3.3.4 → 4.0.0 (breaking changes)

# 2. Build the app
npm run build

# 3. Push version bump + git tag
git push --follow-tags

# 4. Create GitHub Release
#    - Go to: https://github.com/xicoarm/suisse-notes-desktop/releases
#    - Click "Draft a new release"
#    - Select the tag that was just pushed (e.g., v3.3.5)
#    - Upload artifacts from: dist/electron/Packaged/
#      - Suisse Notes Setup X.X.X.exe (Windows installer)
#      - latest.yml (REQUIRED for auto-updater to work)
#    - Publish the release
```

### What Happens on Client Side

1. User opens Suisse Notes desktop app
2. App checks GitHub Releases for newer version
3. If found → downloads update silently in background
4. When user closes the app → update installs automatically
5. Next launch → running the new version

### Important Notes

- **Private repo:** Requires `GH_TOKEN` environment variable for electron-updater to access releases
- **latest.yml:** This file MUST be uploaded with each release — it tells the updater what version is available
- **Code signing:** Windows builds can be signed by setting `CSC_LINK` and `CSC_KEY_PASSWORD` environment variables

---

## Access & Resources

**Web App SSH Access:**
```bash
ssh ubuntu@185.79.233.140
```

**GitHub Repositories:**
- Web App: https://github.com/xicoarm/suisse-notes-v2.git
- Desktop App: https://github.com/xicoarm/suisse-notes-desktop (private)