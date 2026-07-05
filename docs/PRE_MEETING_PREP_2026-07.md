# Pre-Meeting Kontext, Vorlagenwahl & Vorab-Ausfüllen (Juli 2026)

Stand: 2026-07-05. Ein Konzept („MeetingPrep") für alle Einstiegspunkte:
**Kontext** (Freitext + Dokumente mit OCR) + **Vorlagen-Vorwahl** + **Vorab-Ausfüllen**
der Vorlagen-Abschnitte — wirkt auf Transkription **und** Dokumentgenerierung.

## Wo was liegt

| Etappe | Repo/Branch | Commits | Status |
|---|---|---|---|
| E1 Backend-Fundament | suisse-notes-v2 · `feat/pre-meeting-context` (auf Server) | `05005a65` | **LIVE deployed** |
| E1b Desktop-Contract | ebd. | `10d7c316` | **LIVE deployed** |
| E2 Web-UI | ebd. | `176d8aff` + Review-Fixes `4f81cf8b` | **LIVE deployed** |
| E3+E4 Native Apps | dieses Repo · `feat/pre-meeting-prep` (gestackt auf `fix/mobile-history-upload-dedupe`) | `ed562dc` | committed, **nicht released** |
| E5 Kalender für alle | suisse-notes-v2 | — | in Arbeit |

Basis-Snapshot des Servers vor allem: `8367fdbe` (enthält fremdes Payrexx-WIP; nur auf Server).
⚠️ Beim Payrexx-Abschluss: Stripe-Spalten-Drift NICHT per `prisma migrate diff` blind auflösen (DB hat noch Stripe-Daten).

## Architektur (Backend, live)

- **Datenmodell:** `MeetingPrep` {contextText, templateId, templatePrefill Json `{entries:[{key,label?,content}]}`, source} + `MeetingContextFile` (Original auf Disk `/home/ubuntu/context-files`, `extractedText` in DB, `ocrUsed`) + `Meeting.prepId` + `SyncedCalendarEvent.prepId`. Migration `20260704230000_add_meeting_prep` (rein additiv).
- **Extraktion:** DOCX→mammoth, PDF→pdf-parse, Scan-PDF→`pdftoppm`+Vision-LLM (Batches à 4 Seiten, max 12), Bilder→Vision. `createVisionCompletion` in `lib/ai/client.ts` (Gemini→OpenAI→Anthropic-Kette). Max 20 MB/Datei, 5 Dateien.
- **STT:** Prep-Hint (≤3.5k Zeichen: Kontext + Dokument-Köpfe) via `buildSTTContext` auf desktop-upload, web-upload und **resubmit** (Kontext-Verlust-Bug bei Re-Transkription gefixt). Live-WS und MediaBot-seitige STT bekommen den Hint noch nicht (Limitation, s.u.).
- **DocGen:** Prep-Block (≤60k Zeichen: Kontext + extrahierte Dokumente + Prefill-Liste) in branded prompts-mode, placeholder-mode und Block-Templates; Prefill zusätzlich **pro Abschnitt** in die jeweilige Instruktion injiziert (Keys: Prompt-Id `p1…` / Platzhalter-Tag / Block-Id — 1:1 aus `GET /api/desktop/templates/[id]/sections`).
- **Vorlagen-Priorität:** `MeetingPrep.templateId` > Stern-Standard > KI-Matching > Sprach-Fallback. Nichts gewählt → Verhalten exakt wie vorher. Explizite Vorwahl überstimmt auch `defaultDocumentMode=none`.
- **Contract (nativ):** `UploadMetadata` + `{contextText, templateId, templatePrefill, contextFileIds}`; `GET /api/desktop/templates` (isStarred), `GET /api/desktop/templates/[id]/sections`, `POST /api/context-files` (+`DELETE /[id]`) — alle im OpenAPI + Deploy-Smoke-Test. Abwärtskompatibel.
- **Nachträglich:** `GET/PUT /api/meetings/[id]/prep` (Full-Replace, 400 bei leerem Body) + `POST /api/meetings/[id]/prep/regenerate` (409 bei laufender Generierung; un-default + enqueue atomar; altes Dokument bleibt als Version).

## Web (live)

- `session/new/{live,upload,online}`: Karte „Kontext & Vorlage" (`PreMeetingPrepCard.tsx`) — Freitext, Dateien (Status/OCR-Badge, Upload blockiert Start bis Extraktion fertig), Vorlagen-Picker (+ „Neue Vorlage erstellen"), Ausfüll-Panel. Alle drei Submit-Pfade senden die 4 Felder.
- Meeting-Seite → Tab **„Prep"**: Vorbereitung nachträglich ansehen/ändern + „Dokument neu generieren" (Studio-Tab zeigt Fortschritt). Fehler beim Laden → Fehlerzustand statt leerem Editor (verhindert versehentliches Wipe).

## Native Apps (E3+E4, Commit `ed562dc`)

- **RecordPage/UploadPage:** Expansion-Karte „Kontext & Vorlage" (`PreMeetingPrepOptions.vue`) unter den Transkriptions-Optionen. Vorlagenliste offline-gecacht (6h TTL, stale nutzbar); Kontext/Vorlage/Prefill funktionieren offline (reisen als Upload-Metadata durch alle Queues); nur neue Datei-Uploads brauchen Netz.
- **Metadata überall:** alle 11 Producer-Stellen (Auto-Upload inkl. 401-Retry, Failure-Queue, Crash-Recovery, History-Auto-Retry, Gerät-Sync + Gerät-Retry) senden die Prep-Felder; `prep` liegt am History-Record (`LOCAL_ONLY_FIELDS`) und übersteht Server-Merges + App-Neustarts.
- **Suisse Notes Pro (E4):** Nach dem Speichern aufs Handy, VOR dem Upload fragt ein globaler Dialog „Kontext? Vorlage?" — **wartet bis beantwortet** (Entscheid Marc), „Überspringen" immer möglich, „Für alle weiteren übernehmen" pro Sync-Lauf. Einstellungen (mobil): Fragen an/aus + Standard-Vorlage + Standard-Kontext → vollautomatisch. Wartende Records: Status `pending_prep` (kein Retry-Pfad lädt ohne Antwort hoch); App-Kill → Scanner re-prompted; History-Karte: Tippen öffnet die Frage.

## Testprotokoll (Marc)

**Web (sofort testbar auf app.suisse-notes.ch):**
1. `session/new/upload`: PDF als Kontext anhängen (auch ein GESCANNTES zum OCR-Test), Freitext mit ungewöhnlichen Eigennamen, Vorlage wählen, einen Abschnitt vorab füllen (z.B. Traktanden) → Audio hochladen → prüfen: Namen im Transkript korrekt? Dokument nutzt die gewählte Vorlage? Vorab-Inhalt im richtigen Abschnitt?
2. Meeting → Tab „Prep": Kontext ändern → „Dokument neu generieren" → neues Dokument im Studio, altes als Version.
3. `session/new/online` (Bot): Kontext+Vorlage setzen → nach Meeting-Ende prüfen wie oben.
4. Ohne jede Angabe: Verhalten unverändert (Auto-Vorlagenwahl wie bisher).
5. Grosse Datei >20 MB → saubere Fehlermeldung; 6. Datei → „max. 5".

**Native (nach Test-Build von `feat/pre-meeting-prep`):**
1. RecordPage → „Kontext & Vorlage" ausfüllen → aufnehmen → Upload → Dokument prüfen.
2. Flugmodus: Vorlage wählen (aus Cache) + Kontext tippen → aufnehmen → online gehen → Auto-Upload trägt Prep.
3. Suisse Notes Pro: 2 Aufnahmen syncen → Dialog pro Aufnahme; „Für alle übernehmen" testen; App während Dialog killen → nach Neustart kommt die Frage wieder (History zeigt „Wartet auf Kontext").
4. Einstellungen: „nicht mehr fragen" + Standard-Vorlage → Sync läuft vollautomatisch durch.

## Bekannte Limitationen / Folgearbeiten

- MediaBot (.NET, Teams) transkribiert bot-seitig → bekommt den STT-Hint nicht (DocGen profitiert trotzdem). Erfordert MediaBot-Repo-Änderung.
- Live-Browser-STT (WebSocket) bekommt den Hint noch nicht — Persistenz + DocGen + Resubmit ja.
- Titel/Insights/Summaries nutzen den Prep-Block noch nicht (nur Dokumente).
- Kontext-Dateien folgen noch nicht der Data-Retention/ZDR-Löschung (Cleanup-Job offen).
- Falls die SAS-Upload-Routen (`/api/uploads/*`) je deployed werden: `complete` muss `parseMeetingPrepInput` aufrufen (heute nicht existent — Legacy-POST ist der Live-Pfad und ist verdrahtet).
