# INT-2: Mobile Interruption Recovery + Upload Dedupe (Juli 2026)

Branch: `fix/mobile-history-upload-dedupe` (gepusht, NICHT auf main gemerged).
Stand: 2026-07-04. Release-Entscheid: wird zusammen mit dem nächsten grossen
Feature released; TestFlight/APK-Build 3.9.31 dient nur dem Gerätetest.

## 1. Der Auslöser: Kunden-Incident (jn@juhonyberg.com, 25.06.2026)

iPhone (iOS 18.7), App 3.9.29, Aufnahme im **Vordergrund**. Eingehender Anruf
(weggedrückt) um 15:00 lokal. Forensik (Sentry `capacitor` + Backend-DB):

| Zeit (UTC) | Ereignis |
|---|---|
| 12:56:22 | Aufnahme startet, Chunks alle 3 s |
| 13:00:39.870 | Breadcrumb: `AudioContext state changed to "interrupted" — attempting resume` |
| 13:00:39.914 | `AudioContext auto-resume failed: InvalidStateError` — der EINE Versuch, 44 ms nach Beginn, während der Anruf das Audiogerät noch besass |
| 13:01:13 | Watchdog: `capture STALLED — savedChunks=86` (86×3 s = 258 s = exakt die gemeldeten 4:18) |
| 13:25:42–49 | User klickt Stall-Banner, dann Pause→Resume — Capture bleibt tot (Resume holt das Mikro nicht neu) |
| 14:29 | Stop: Combine+Upload der 258 s OK. **~90 Minuten Meeting unwiederbringlich nie aufgenommen** |
| 20:34 | Dieselbe Datei wird erneut hochgeladen (Duplikat; Backend-Dedupe fing es ab) |

**Mechanismus:** iOS-Audio-Session-Unterbrechung friert den WKWebView-AudioContext
ein und mutet den Mic-Track (`onmute`, NICHT `onended`). Der MediaRecorder nimmt
den Mixing-Graph-Output auf (`createMixingPipeline` — "Always use mixing pipeline",
alle Plattformen) → eingefrorener Context = keine Frames = **null `dataavailable`**,
obwohl `mediaRecorder.state === 'recording'`. Es gab: keinen `onmute`-Listener,
keinen Retry nach Unterbrechungs-ENDE, keinen Post-Resume-Healthcheck, Watchdog
nur warn-only.

## 2. Was auf dem Branch liegt (6 Commits)

| Commit | Inhalt |
|---|---|
| `0011534` | Ursprünglicher Dedupe-Fix: In-Memory-In-Flight-Guard pro recordId (`{inProgress:true}`-Resultat), `_normalizeServerRecording` für die Server-History |
| `d3fafce` | Review-Nachbesserungen: `startMobileUpload` (der ECHTE Mobile-Pfad in UploadPage) behandelt `inProgress` (vorher: roter Fehler-Toast); kein Call-Site strandet Records mehr auf `'uploading'` (HistoryPage lässt Status unangetastet, device.js revertet auf `'pending'`, Auto-Retry revertet Status+retryCount); RecordPage-Handoff-Watcher statt Stuck-Phase; History-Merge-Guard (lokale Felder `source`/`deviceFilename`/Retry-Bookkeeping überleben Fetch; Server-`recording` überschreibt kein lokales `failed`); Guard-TTL 30 min; i18n `uploadAlreadyInProgress` (4 Sprachen) |
| `b720073` | **INT-2 Recovery-Engine** (`recordingService.js`): `scheduleCaptureRecovery`/`attemptCaptureRecovery` — 5-s-Loop (max 30 min): Contexts resumen → Mic re-akquirieren via `switchMicrophoneStream` wenn Track tot/gemutet → `requestData`-Nudge → Erfolg erst wenn ein Chunk NACH Episodenbeginn persistiert. Trigger: ctx-`statechange`, Track-`onmute`/`onunmute` (auch auf Ersatz-Tracks), 30-s-Chunk-Stall-Watchdog (trigger-agnostisches Netz, deckt Android/Unbekanntes), 10-s-Post-Resume-Check (Identity-Vergleich!). Plus: Auto-Retry lädt keine `failed`-Records mit gesetztem `audioFileId` mehr hoch (Backend verwirft Re-Uploads inkl. FAILED still — war der wochenlange 93-MB-Loop) |
| `c633dc3` | **INT-2b Eskalation**: nach 6 Ticks (~30 s) nachweislich gesunder Pipeline (ctx running + Mic live) ohne Chunk → `captureRecoveryFailed` → useRecorder spiegelt den bewährten diskFull-**Emergency-Stop-with-Save** (bewusst KEIN In-Place-Recorder-Rebuild: zweiter EBML-Header in der Mobile-Chunk-Sequenz → under-probed Combine → stille Teil-Transkription). Stall-Banner hat „Jetzt wiederherstellen"-Button (`forceCaptureRecovery()` — User-Gesture, falls iOS `resume()` aus Timern verweigert). Recovery pausiert während Auto-Split |
| `03ea047` | Version-Bump 3.9.31 (versionCode 33, iOS build 11) |

UI: Stall-Banner-Text neu („Aufnahme unterbrochen (eingehender Anruf?) —
automatische Wiederherstellung läuft…"), Recovered-Toast mit Lückenlänge,
Recovery-Failed-Meldung — alle 4 Sprachen.

Android: identischer geteilter Code. Restlücken: Stille-Chunks-Variante mancher
Geräte (Watchdog feuert nicht, nur Stille-Warnung) und fehlender nativer
AudioFocus-Listener (R3).

## 3. Verifizierte Backend-Gaps (3/3 adversarial, Live-Server gelesen) — OFFEN

1. **FAILED-Dedupe-Falle**: `/api/desktop/upload` dedupet per botSessionId inkl.
   Status FAILED → Re-Upload eines gescheiterten Meetings wird still verworfen
   (Bytes gelöscht) → In-App-Retry dauerhaft nutzlos. Fix: FAILED-Row beim
   Re-Upload ersetzen ODER Re-Transcribe-Endpoint im Desktop-Contract
   (Reprocess-Logik existiert serverseitig).
2. **Trunkierung unsichtbar**: alle Duration-Guards sind inflation-only (2×),
   Client meldet ehrliche (trunkierte) Dauer, kein Wall-Clock-Feld im Contract,
   `reconcileCoverage` nur für Browser-Live-Sessions verdrahtet → 93-min-Meeting
   als 258 s = null Signal. Fix: `wallClockSec`/`captureGapSec` in Upload-Metadata
   + Shortfall-Alert.
3. Kein Multi-Segment/Append: gleiche recordId → verworfen; neue recordId →
   unverlinktes separates Meeting (= heutiges Auto-Split-Verhalten). SAS-Routen
   existieren weiterhin nicht — Legacy-POST-Fallback ist der permanente Live-Pfad.

Nebenbefund: Backend-Server-Worktree ist dirty + auf Feature-Branch gebaut.

## 4. Release-Stand & Prozess

- Branch gepusht; `mobile-release.yml` per `workflow_dispatch` auf dem Branch
  gelaufen (Run 28718384327): **Android ✅** (signiertes APK/AAB als Artifact,
  lokal unter `temp/android-3.9.31/`; kein Play-Deploy — `PLAY_STORE_JSON_KEY`
  fehlt), **iOS** zuerst ❌ „required agreement missing/expired" (Apple-Vertrag),
  nach Akzeptierung durch Account Holder rerun → TestFlight.
- **Finaler Release**: nach Gerätetest + grossem Feature zusammen — Merge auf
  `main` triggert `mobile-release.yml` automatisch (push-Pfad `src/**`).
  Desktop-Release (`npm run release` → Tag) separat entscheiden; die INT-2-Logik
  läuft auch auf Desktop (macOS-Interruptions profitieren).

## 5. Gerätetest-Protokoll (VOR Produktions-Release, iOS + Android)

1. Aufnahme starten, ~1 min sprechen.
2. Anruf eingehen lassen, wegdrücken → Banner erscheint, verschwindet von selbst,
   Timer läuft weiter, Toast nennt Lücke. Sentry: `capture recovery started` →
   `capture RECOVERED`.
3. Anruf ANNEHMEN, 1 min telefonieren, auflegen → Recovery nach Auflegen.
4. Banner bleibt? → „Jetzt wiederherstellen"-Button (User-Gesture-Pfad).
5. Worst Case: nach ~30 s Emergency-Stop-with-Save + Meldung → neue Aufnahme
   muss sofort starten. Sentry: `capture recovery FAILED`.
6. History: keine Duplikate; Upload einmalig.

## 6. Offene Punkte

- [ ] Gerätetest iOS + Android (Protokoll oben)
- [ ] Backend-Fixes (Abschnitt 3, Repo suisse-notes-v2)
- [ ] Antwort an jn@juhonyberg.com (Workaround: Fokus/Nicht-stören während
      Sitzungen; Fix implementiert, Release folgt)
- [ ] Adversarial-Review der Commits b720073/c633dc3 nachholen (Session-Limit
      killte die Verifier; Audit-Resume: `resumeFromRunId: wf_8066b97d-ec6`)
- [ ] R3 nativ (AVAudioSession-Observer iOS, AudioFocus+FGS-owns-mic Android) —
      die definitive Prävention, device-gated
- [ ] Stille-Chunks-Variante Android: Stille-Erkennung → Recovery koppeln (mit
      Vorsicht: False-Positives in leisen Räumen)
