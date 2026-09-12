# Mobile Release Guide — Suisse Meets (iOS + Android)

The complete, step-by-step procedure for shipping the mobile app: which tool runs when,
which account and secret is involved, when a browser is needed, where exactly to click,
and how to test before anything reaches users. Follow it top to bottom.

> **This repository is public.** This file contains no secret values: no passwords, no
> keys, no console account IDs. Where a value is needed, the guide names *where it
> lives*: a GitHub Actions secret, the local file `RELEASE-RUNBOOK.md` (repo root,
> gitignored, never committed), `.env.local` (gitignored) or the store console itself.
> If you are on a machine without `RELEASE-RUNBOOK.md`, every value can be recovered
> from the consoles by an account owner (see §2).

Contents

1. [The release at a glance](#1-the-release-at-a-glance)
2. [Accounts, access and secrets](#2-accounts-access-and-secrets)
3. [Tools and local setup](#3-tools-and-local-setup)
4. [Phase A — prepare and verify the build](#4-phase-a--prepare-and-verify-the-build)
5. [Phase B — distribute test builds](#5-phase-b--distribute-test-builds)
6. [Phase C — test on real devices](#6-phase-c--test-on-real-devices)
7. [Phase D — production release](#7-phase-d--production-release)
8. [Phase E — after the release](#8-phase-e--after-the-release)
9. [Release test plan](#9-release-test-plan)
10. [Troubleshooting — failures that already happened](#10-troubleshooting--failures-that-already-happened)
11. [Store obligations and deadlines](#11-store-obligations-and-deadlines)
12. [Rules for Claude sessions](#12-rules-for-claude-sessions)
13. [Recommended improvements](#13-recommended-improvements)

---

## 1. The release at a glance

| Phase | What happens | Tool | Who | Time |
|---|---|---|---|---|
| A | Branch, version bump, unit tests, lint, mobile harness, CI test build | git, npm, `gh`, GitHub Actions | developer / Claude | 1–2 h incl. CI |
| B | Test builds to testers: iOS → TestFlight (automatic), Android → Play **internal testing** track | GitHub Actions, Play Console (browser) | developer / Claude, Play login by a human | 15 min |
| C | Test plan on real phones with the real recorder (§9) | TestFlight app, Play Store app, recorder | tester | 2–4 h |
| D | Merge to `main` → CI builds → Play production + App Store review | git, GitHub Actions, Play Console, `ios-submit.yml` | developer / Claude, Play login by a human | 1 h + review (Apple ≤ 48 h, Google 1–7 days) |
| E | Watch Sentry and reviews, write the release log | Sentry API, consoles | developer / Claude | 48 h of watching |

Nothing reaches production users before Phase D. Phases A–C can be repeated as often as
needed; every repetition with a new Android upload costs one versionCode (§4.3).

---

## 2. Accounts, access and secrets

### 2.1 App identities — never rename

| Platform | Identifier | Where it is set |
|---|---|---|
| iOS | bundle ID `ch.suissenotes.mobile`, App Store app ID `6758680707`, Apple team ID `UTU38DWABG` | `src-capacitor/capacitor.config.json`, `src-capacitor/ios/App/fastlane/` |
| Android | package `ch.suissenotes.app` | `src-capacitor/android/app/build.gradle` (`applicationId`) |
| Deep link | `suissenotes://auth/callback` (SSO) | iOS `Info.plist`, Android `AndroidManifest.xml` |
| Sentry | org `suisse-it-gmbh`, project `capacitor`, release `ch.suissenotes.mobile@<versionName>` | `src/boot/sentry.js`, `quasar.config.js` |

The display name is "Suisse Meets"; these machine identifiers keep the old name forever
(store identity, SSO redirect registered at Google/Microsoft).

### 2.2 Accounts and who can use them

| System | Used for | Access | Login |
|---|---|---|---|
| GitHub `xicoarm/suisse-notes-desktop` | code, Actions, secrets | write access to the repo; secrets need admin | `gh auth login` (browser device flow) |
| GitHub `xicoarm/certificates` (private) | iOS signing certificates (fastlane match) | read access via a fine-grained PAT (§2.3) | — |
| Apple Developer + App Store Connect | TestFlight, App Store versions, review | team member with App Manager or Admin role in team Suisse IT GmbH | Apple ID + 2FA — a human signs in |
| App Store Connect API | CI upload to TestFlight, `ios-submit.yml` | API key (secrets, §2.3) | none, key-based |
| Google Play Console | internal testing, production, review submission, app content | the company developer account, user with release permissions for Suisse Meets | Google account + 2FA — a human signs in |
| Sentry | crash/error monitoring, source maps | org `suisse-it-gmbh` | token in `.env.local` for scripts |
| Backend `app.suisse-meets.ch` | API the app talks to; store-review demo accounts | ssh alias per `CLAUDE.md` | — |

The Play developer account ID and the Play app ID used in direct console URLs are in the
local `RELEASE-RUNBOOK.md` §4. Without it, open https://play.google.com/console and pick
the app **Suisse Meets** from "Alle Apps".

### 2.3 GitHub Actions secrets (names only — values are write-only)

List them any time with `gh secret list -R xicoarm/suisse-notes-desktop`.

| Secret | Used by | What it is | When it breaks / how to renew |
|---|---|---|---|
| `APP_STORE_CONNECT_API_KEY_ID` | mobile-release (iOS), ios-submit | App Store Connect API key ID | App Store Connect → Benutzer und Zugriff → Integrationen → App Store Connect API → Teamschlüssel: create a key (role App Manager), set ID, issuer and `.p8` content again |
| `APP_STORE_CONNECT_API_ISSUER_ID` | same | issuer ID shown on the same page | same |
| `APP_STORE_CONNECT_API_KEY_CONTENT` | same | full text of the `.p8` file | same (the `.p8` can be downloaded only once) |
| `MATCH_PASSWORD` | mobile-release (iOS) | passphrase that decrypts the match certificates repo | only changes if the certificates repo is re-encrypted |
| `MATCH_GIT_URL` | mobile-release (iOS) | URL of `xicoarm/certificates` | — |
| `MATCH_GIT_BASIC_AUTHORIZATION` | mobile-release (iOS) | `base64("xicoarm:<fine-grained PAT>")` | iOS job fails in seconds with `could not read Username` or 403 → renew the PAT, §10.1 |
| `ANDROID_KEYSTORE` | mobile-release (Android) | base64 of the **upload** keystore | if lost: Play Console → App-Integrität → App-Signatur → request an upload key reset (Google holds the app signing key) |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | mobile-release (Android) | keystore credentials | with the keystore |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` | mobile-release (both) | source-map and dSYM upload | token revoked → create a new org token in Sentry with `project:releases` |
| `ASC_DEMO_USER`, `ASC_DEMO_PASS` | ios-submit | the App Store review demo login, written into the App Review information | must always log in successfully (§7.1) |
| `PLAY_STORE_JSON_KEY` | mobile-release (Android, optional) | **does not exist** — without it the Android job only builds, and Play uploads are done in the browser | see §13 to automate |
| `CSC_LINK`, `CSC_KEY_PASSWORD`, `GH_PAT`, `SSL_COM_*` | release.yml | **desktop** signing and publishing — not used by mobile | desktop guide in `CLAUDE.md` |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `CSC_INSTALLER_LINK`, `SENTRY_PROJECT_DESKTOP` | no workflow references them today | legacy | leave them |

### 2.4 Local-only files (never commit)

| File | Content |
|---|---|
| `.env.local` | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT_*` for scripts on this machine |
| `RELEASE-RUNBOOK.md` | console account IDs and direct URLs, store-review demo account credentials (§9 there), the release log (institutional memory), incident notes |
| `play-console-sign-in-details.txt` | the long English reviewer instructions for Play "App-Zugriff" |

`.gitignore` covers all three. Before every commit: `git status --porcelain` must not list them.

---

## 3. Tools and local setup

| Tool | Check | Notes |
|---|---|---|
| Node 22 + npm | `node -v` | `npm ci` in the repo root |
| GitHub CLI | `gh auth status` | must see `xicoarm/suisse-notes-desktop` |
| Google Chrome | — | needed for the Play Console; the harness also uses it |
| Claude in Chrome extension | connected browser listed by the session | only for Claude sessions driving the consoles in the user's own Chrome (§12) |
| ssh alias for the backend | `ssh suisse-notes echo ok` | only for the cross-repo contract check (§4.2) |

No Xcode or Android Studio is needed: both native builds run on GitHub runners
(`macos-26` with Xcode 26 for iOS, `ubuntu-latest` for Android).

---

## 4. Phase A — prepare and verify the build

### 4.1 Git pre-flight

```bash
git status --porcelain
git fetch origin
git switch -c fix/<short-name> origin/main
```

Work on a branch, never on `main`. The pre-flight rules in `CLAUDE.md` apply.

### 4.2 Cross-repo contract check (only if a new `/api/...` call ships)

```bash
ssh suisse-notes "grep -rln '<endpoint-path>' /home/ubuntu/Suisse-Notes-V2/src/app/api/"
```

No match means the backend route does not exist yet: do not ship the client change.

### 4.3 Version bump — two files, by hand

| File | Field | Rule |
|---|---|---|
| `src-capacitor/android/app/build.gradle` | `versionCode` | +1 per upload. **Must be higher than every versionCode ever uploaded to Play, including internal-testing uploads.** A used versionCode can never be uploaded again. |
| same | `versionName` | the marketing version, e.g. `3.9.37` |
| `src-capacitor/ios/App/App.xcodeproj/project.pbxproj` | `MARKETING_VERSION` (2×) | same as `versionName`; the App Store version string must equal it |
| same | `CURRENT_PROJECT_VERSION` (2×) | +1 for hygiene; CI overrides the real iOS build number with a timestamp (`yyMMddHHmm`) |

`src-capacitor/package.json` "version" is unused — leave it. Commit as
`chore(mobile): bump to 3.9.X (versionCode N, iOS build M)`.

### 4.4 Local verification

```bash
npm run lint
npx vitest run
npx quasar build -m capacitor -T android --skip-pkg
git checkout -- src-capacitor/android/app/capacitor.build.gradle src-capacitor/android/capacitor.settings.gradle src-capacitor/capacitor.config.json src-capacitor/package.json
node tests/mobile-harness/run.js all
node tests/mobile-harness/run.js all --platform ios
```

- The build step runs `cap sync`, which rewrites four files under `src-capacitor/`; the
  `git checkout` line reverts them. Never commit those four changes.
- The mobile harness (`tests/mobile-harness/README.md`) runs the real app bundle on a
  virtual phone against a virtual recorder. Every scenario must print `PASS` on both
  personas. A failure marked `APP-DEFECT` is a product bug: fix it before continuing.
- A 20-minute endurance check when recording code changed:
  `node tests/mobile-harness/run.js m2-endurance --minutes 20`.
- The harness' mock backend listens on port 3000. If that port is taken, add
  `--mock-port 3010`. It needs Google Chrome; set `CHROME_PATH` if Chrome is not in its
  standard location.

### 4.5 Push and open the pull request

```bash
git push -u origin fix/<short-name>
gh pr create --base main --fill
```

Checks that must be green on the PR:

| Check | Workflow | What it proves |
|---|---|---|
| `lint-and-test`, `build-validation` | `ci.yml` | lint, unit tests, desktop build compiles |
| `scenarios (android)`, `scenarios (ios)` | `mobile-reliability.yml` | the mobile harness on both personas |
| `endurance` | `mobile-reliability.yml` | 5h15 recording — started by adding the label **endurance** to the PR; also runs nightly on `main` |

### 4.6 Test build from the branch

```bash
gh workflow run mobile-release.yml --ref fix/<short-name> -f platform=both
gh run list --workflow=mobile-release.yml --branch fix/<short-name> --limit 1
gh run view <run-id> --json conclusion,jobs -q '.conclusion + " | " + ([.jobs[] | .name + "=" + .conclusion] | join(", "))'
```

The run has four jobs: `test` (lint + unit tests, gates the builds), `check`, `android`,
`ios`. All four must end `success`. On success:

- **iOS** is already uploaded to TestFlight. Get its build number:
  ```bash
  gh run view --job <ios-job-id> --log | grep "Updated CFBundleVersion"
  ```
- **Android** produces the artifact `android-build` (`bundle/release/app-release.aab`
  for Play, `apk/release/app-release.apk` for sideloading).

**Mandatory artifact check** (the check that caught a dead 3.9.35 build):

```bash
gh run download <run-id> -n android-build -D temp/aab-<version>
unzip -o -q temp/aab-<version>/bundle/release/app-release.aab -d temp/aab-x
grep -rl "app.suisse-meets.ch" temp/aab-x/base/assets/public/     # API host present
grep -o 'connect-src[^;]*' temp/aab-x/base/assets/public/index.html  # CSP allows the API host
```

If the release changes hosts, URLs or network config, read `RELEASE-RUNBOOK.md` §1a
(CSP trap) before going further.

---

## 5. Phase B — distribute test builds

### 5.1 iOS → TestFlight (no action needed)

The `ios` job's fastlane lane `beta` uploads every successful build to TestFlight for
**internal testers** (team members added in App Store Connect). There is no external
distribution and no Beta App Review.

- Export compliance is pre-answered in `Info.plist` (`ITSAppUsesNonExemptEncryption = false`),
  so builds do not stop at "Missing Compliance".
- Processing takes 10–30 minutes after the upload.
- Internal groups with automatic distribution receive every build. If the build does not
  show up for a tester: App Store Connect → TestFlight → the internal group → Builds → **+**
  → select the build.
- Tester: open the **TestFlight** app on the iPhone → Suisse Meets → choose the build with
  the number from §4.6.
- To look in the browser: https://appstoreconnect.apple.com → Apps → Suisse Meets →
  TestFlight → iOS builds. Requires a human Apple ID login.

### 5.2 Android → Play internal testing (browser)

Internal testing is available to the testers in the track's email list within minutes and
needs no review. It installs **over the Play production version** (same signing key), so it
also tests the update of an existing installation.

1. Open https://play.google.com/console, sign in with the Google account that has release
   rights for Suisse Meets.
2. **Alle Apps → Suisse Meets**.
3. Left menu: **Testen und veröffentlichen → Test → Interner Test**.
4. Tab **Releases** shows the current internal release; tab **Tester** shows the email list
   (currently the list "Tester") and the opt-in link (**Link kopieren**).
5. Click **Neuen Release erstellen** (top right).
6. Section **App-Bundles**: drop the AAB or use **Hochladen**. Wait until the row
   `app-release.aab` appears and the toast "1 App Bundle hochgeladen" shows.
7. **Releasedetails**: the release name fills itself (`<versionCode> (<versionName>)`).
   **Versionshinweise**: replace the placeholder, keep the tags:
   ```
   <de-DE>
   Testversion 3.9.X: <one sentence>
   </de-DE>
   ```
8. **Weiter** (bottom right) → page **Vorschau anzeigen und bestätigen**.
9. Read **Fehler, Warnungen und Meldungen**. Errors block. Expected warnings today:
   - "Mit diesem App Bundle ist keine Offenlegungsdatei verknüpft" (R8 mapping) — normal.
   - "Deine App ist derzeit auf API-Ebene … ausgerichtet, sollte jedoch eine API-Mindestebene
     von … haben" must **not** appear: it means `targetSdkVersion` is behind Google's
     requirement (§11). Since versionCode 40 the app targets API 36.
   - "Geräte nicht mehr unterstützt" must be **0** in the device table.
10. **Speichern und veröffentlichen** → dialog "Änderung bei Google Play veröffentlichen?" →
    **Speichern und veröffentlichen**.
11. Verify: the track page shows "Neuester Release: <vc> (<version>)" and the release row
    "Für interne Tester verfügbar".
12. Give the testers the opt-in link from step 4. On the phone: open the link, **Tester werden**,
    then update Suisse Meets in the Play Store.

A tester whose Google account is not in the email list gets "not available" on the link:
add the address under **Tester → list → E-Mail-Adressen hinzufügen → Speichern**.

### 5.3 Android without Play (sideload)

The artifact's `app-release.apk` is signed with the upload key, not Google's app signing
key, so it cannot install over a Play installation: uninstall the Play version first. The
update path (existing recordings, migrations) cannot be tested this way.

---

## 6. Phase C — test on real devices

Run the release test plan in §9: every **P1** case, plus every **P2** case whose area the
release touched. Minimum devices: one Android 16 phone, one older Android (10 or 11),
one current iPhone, one Suisse Notes Pro recorder that can be wiped.

Record the result per case (pass / fail + note) in the pull request. Any failure: fix on
the branch, go back to Phase A with a new versionCode.

Sign-off criteria for Phase D:

- all P1 cases pass on both platforms;
- all in-scope P2 cases pass;
- no new error-level Sentry issue from the test builds (§8.1 command, filter on the test build's release).

---

## 7. Phase D — production release

### 7.1 Pre-checks

1. Phase C signed off.
2. Store-review demo logins work. The credentials are in `RELEASE-RUNBOOK.md` §9 and in the
   `ASC_DEMO_*` secrets. 200 = fine, 401 = the review will be rejected:
   ```bash
   curl -sS -X POST https://app.suisse-meets.ch/api/auth/desktop -H 'Content-Type: application/json' -w '\nHTTP=%{http_code}\n' -d '{"email":"<play-review-account>","password":"<password>"}'
   ```
   Run it for the Play account and the App Store account.
3. The release notes text in `.github/workflows/ios-submit.yml` (the `Write release notes`
   step) is **hard-coded**: edit it for this release and commit it on the branch.
4. Deadlines in §11 are not blocking this release.

### 7.2 Merge to `main`

```bash
gh pr merge <pr-number> --merge
```

Use `--merge`: it keeps the branch commits and their SHAs on `main`. Squash or rebase
merges create new SHAs, and the tested internal Play build would then no longer come from
a commit on `main` (§7.3 Way 1).

- Every push to `main` that touches `src/**`, `src-capacitor/**` or `quasar.config.js` starts
  **Mobile Release** automatically. Do **not** also dispatch it manually (double build).
- Commits whose first line starts with `chore(release):` or contains `[skip ci]` are skipped;
  those runs finish "green" in about 7 seconds without building anything.
- **Never push a `v*` tag for a mobile release**: `v*` tags start the **desktop** release
  (`release.yml`), which auto-updates every desktop installation within hours.
- Watch the run as in §4.6, note the iOS build number, download the AAB, repeat the artifact check.

### 7.3 Android production (Play Console)

Choose one of two ways:

**Way 1 — promote the tested internal release** (only if the internal build was made from a
commit that is now on `main` — merged with `--merge` — and nothing under `src/` or
`src-capacitor/` changed after that commit):

1. **Testen und veröffentlichen → Test → Interner Test → Releases**.
2. On the release row: **Release hochstufen → Produktion**.
3. Check notes and the rollout, then **Weiter → Speichern**.

**Way 2 — upload the build from `main`** (required when the code changed after the test,
with a versionCode higher than the internal upload):

1. **Testen und veröffentlichen → Produktion → Neuen Release erstellen**.
2. Upload the AAB from the `main` run, or **Aus der Bibliothek hinzufügen**.
3. Versionshinweise `<de-DE>…</de-DE>` → **Weiter** → review warnings → **Speichern**.

Then, for both ways:

4. Left menu **Veröffentlichungen – Übersicht**.
5. **Änderungen zur Überprüfung einreichen**. Nothing ships before this step; it bundles the
   release with any listing changes into one review.
6. Verified submitted: the submit button disappears and the section reads "Änderungen, die
   überprüft werden" with "Änderungen entfernen".

Play Console traps (from real releases): the UI writes non-breaking spaces, so match texts
with `\s+`; wait for render before reading the page; "Überprüfung" appears in the page's
static text, so it proves nothing; the listing-quality pre-check ("Funktionen nicht deutlich
beschrieben") can be passed with **Trotzdem fortfahren**.

### 7.4 iOS production (no browser)

1. Prepare without submitting:
   ```bash
   gh workflow run ios-submit.yml -f version=3.9.X -f build=<CFBundleVersion> -f submit=false
   ```
   The script `scripts/asc-submit.js` finds the TestFlight build, creates or reuses the App
   Store version, sets release type "after approval", attaches the build, writes the
   release notes into every locale and corrects the App Review demo login from
   `ASC_DEMO_USER`/`ASC_DEMO_PASS`. It never touches name, descriptions, screenshots or
   pricing.
2. Read the run log. Everything must be ready, and the log ends with "PREPARED but NOT submitted".
3. Submit:
   ```bash
   gh workflow run ios-submit.yml -f version=3.9.X -f build=<CFBundleVersion> -f submit=true
   ```
4. Final state in the log: `WAITING_FOR_REVIEW`.

Never use the fastlane lanes `release` or `release_submit`: `release_submit` uploads
metadata and screenshots and can blank the live store listing.

---

## 8. Phase E — after the release

### 8.1 Sentry watch (first 48 hours)

Mobile events carry the release `ch.suissenotes.mobile@<versionName>` and the dist
`android` or `ios`. New unresolved issues of the release:

```bash
node -e "
const fs=require('fs');const t=(fs.readFileSync('.env.local','utf8').match(/^SENTRY_AUTH_TOKEN=(.*)$/m)||[])[1].trim();
fetch('https://sentry.io/api/0/organizations/suisse-it-gmbh/issues/?project=4510958727462992&statsPeriod=14d&limit=100&query='+encodeURIComponent('is:unresolved release:ch.suissenotes.mobile@3.9.X'),{headers:{Authorization:'Bearer '+t}})
 .then(r=>r.json()).then(a=>a.forEach(i=>console.log(i.shortId,i.level,i.count,i.userCount,i.title.slice(0,90))));"
```

- Use the **organization** endpoint; `/api/0/issues/<id>/…` returns 404.
- 3.9.37 is the first mobile release whose JavaScript stack traces are symbolicated. Open
  the first error event and check that the frames show `src/…` paths.

### 8.2 Reviews

- Play: review mails go to the developer account; the console inbox shows "Das App-Update
  wurde veröffentlicht" when it is live.
- Apple: mails to the account holder; App Store Connect → Apps → Suisse Meets → Vertrieb shows the state.
- A rejection: fix it, then write the reason into the release log.

### 8.3 Bookkeeping

- Append a row to the **Release log** in `RELEASE-RUNBOOK.md`: version, versionCode, iOS
  build number, what shipped, what went wrong.
- Update this guide if a step changed. A guide that is wrong is worse than no guide.

---

## 9. Release test plan

**Why a device test is still needed.** Unit tests and the mobile harness cover the app's
own logic: recording pipeline, file handling, upload retry policy, recorder protocol,
recovery. They cannot cover the operating system and the radio: permission dialogs,
background limits, phone calls, the real Bluetooth stack, the file picker, sharing, SSO
sign-in sheets, and how the app looks and feels. Those cases are manual.

**Priorities**

- **P1** — test in every release, on Android and iOS.
- **P2** — test when the release touched that area (see the release's change list).
- **P3** — test at least once per quarter, or when the area changes.

**Automated** names the unit test or harness scenario that already covers the logic; the
manual case then checks the device side only.

### A. Install and update

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| A1 | Fresh install | Install, open | Welcome/login screen in the phone's language; no Bluetooth or notification prompt at start | P1 | — |
| A2 | Update over the production version | With recordings in History and a paired recorder, update via internal testing / TestFlight | History complete, recordings playable, recorder still paired, no duplicate entries | P1 | m7 (pairing identity) |
| A3 | Update on Android 10/11 | Same as A2 on an old Android | Old recordings still available after the storage migration | P2 | unit `storage.androidDirectory` |

### B. Login and session

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| B1 | Email/password login | Log in | Record screen, remaining minutes shown | P1 | m0 |
| B2 | Wrong password | Wrong password | Clear message, no crash | P2 | — |
| B3 | Login offline | Airplane mode, log in | Translated "no internet connection" message | P2 | unit `auth.store` |
| B4 | Google sign-in | "Mit Google anmelden" | Returns to the app logged in | P1 | — |
| B5 | Microsoft sign-in | "Mit Microsoft anmelden" | Returns to the app logged in | P1 | — |
| B6 | Cancel SSO | Open SSO, close the sheet | Back on login, no error message | P2 | — |
| B7 | Session survives restart | Kill the app, reopen | Still logged in | P1 | m6 (relaunch) |
| B8 | Logout blocked while recording | Record, try Settings → Abmelden | Blocked with a message | P2 | — |
| B9 | Switch user | Log out, log in as another user | No history, no recorder pairing of the first user | P2 | — |

### C. Language

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| C1 | Device language | Phone in English / French / Italian, fresh install | App in that language; German for any other language | P2 | unit `i18n.localeDetection` |
| C2 | Manual language | Settings → Sprache | Whole app switches, survives restart | P3 | — |

### D. Recording on the phone

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| D1 | Short recording | Record 2 min, stop | Upload succeeds, entry "Hochgeladen" in History | P1 | m1 |
| D2 | Microphone permission denied | Deny the mic prompt, press record | Explanation with the way to the settings | P2 | — |
| D3 | Screen locked | Record, lock the phone 5 min, unlock, stop | Full 5 min in the file, no gap warning | P1 | — |
| D4 | App in background | Record, switch to other apps 5 min, return, stop | Full audio, no gap warning | P1 | — |
| D5 | Incoming phone call | Record, receive and accept a call, hang up | Recording resumes or warns clearly; audio before and after the call is kept | P1 | — |
| D6 | Long recording | Record ≥ 60 min | One file, uploaded, length correct | P2 | m2 (5h15 nightly) |
| D7 | Pause / resume | Pause 1 min, resume | Pause not in the file, rest complete | P2 | — |
| D8 | Stop right after start | Start and stop within 2 s | "Recording too short", no failed entry | P3 | — |
| D9 | App killed while recording | Record 2 min, swipe the app away, reopen | Recording recovered and uploaded | P1 | m6 |
| D10 | Bluetooth headset mic | Record with AirPods / headset | Audio from the headset, recording complete | P3 | — |
| D11 | Transcription options + context | Set title, vocabulary, template before recording | Transcript uses them | P2 | — |
| D12 | Low storage | Phone with < 500 MB free | Warning before start; stop and save below the critical limit | P3 | unit `storage` |

### E. Upload and transcription

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| E1 | Offline at stop | Airplane mode, record, stop, wait, go online | Queued, then uploads by itself | P1 | m3 (retry paths) |
| E2 | Connection lost mid-upload | Long recording, disable Wi-Fi/mobile data during upload | Retries, finishes once online | P2 | m3 |
| E3 | Upload a file | "Datei hochladen" → choose an audio file | Uploaded, transcript appears | P1 | — |
| E4 | Upload a video file | "Datei hochladen" → choose a video | Uploaded, transcript appears | P3 | — |
| E5 | No minutes left | Account with 0 minutes, record and stop | Clear message, no endless retries, entry shows the reason | P2 | unit `upload.classifyHttpFailure` |
| E6 | Transcript reachable | History → entry → "Link kopieren", open the link | Opens the meeting in the web app | P1 | — |

### F. History and local storage

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| F1 | Day groups | History with recordings from several days | Grouped Today / Yesterday / date, newest first | P2 | unit `historyGroups` |
| F2 | No duplicates, nothing missing | Compare phone History with the web app | Same meetings, none twice, none missing | P1 | m5 |
| F3 | Playback | Expand an entry with local audio, play | Plays | P2 | — |
| F4 | Export / share | Entry → "Audio exportieren" | Share sheet opens with the file | P2 | — |
| F5 | Delete one entry | Delete | Gone locally; the meeting on the server stays | P2 | — |
| F6 | "Nach dem Hochladen löschen" | Einstellungen → Standard-Speicherverhalten → "Nach dem Hochladen löschen", then record | About 30 s after the upload the audio is gone from the phone; entry and transcript link stay | P1 | m4 |
| F7 | Delete all recordings | Einstellungen → "Alle Aufnahmen löschen" | Local audio gone, uploaded entries stay without audio, never-uploaded entries gone | P2 | unit `recordingsHistory.storagePreference` |
| F8 | Failed upload explained | Cause a failure (E5) | Card shows the reason; "Erneut hochladen" works | P2 | — |

### G. Suisse Notes Pro recorder

Use a recorder that can be wiped. Charge it; put 3–5 recordings of different lengths on it,
one of them ≥ 30 minutes.

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| G1 | First pairing | Einstellungen or Aufnahmegerät → "Gerät koppeln" → select the recorder | Bluetooth permission asked now (not at app start), connected, battery and storage shown | P1 | m5 |
| G2 | Existing files sync by themselves | After pairing, wait | Each file: context prompt (if "Vor dem Hochladen nach Kontext & Vorlage fragen" is on), transferred, uploaded, "Hochgeladen" in History | P1 | m5 |
| G3 | Record with the recorder's button while connected | Record 1 min on the recorder, stop | Appears and syncs within about a minute | P1 | m5 |
| G4 | Record while disconnected | Phone Bluetooth off, record on the recorder, Bluetooth on | Reconnects by itself and syncs the new file | P1 | — |
| G5 | Recorder off and on | Switch the recorder off 5 min, on again, app in foreground | Reconnects without user action, no error toasts | P1 | unit `deviceStore.reconnectBackoff` |
| G6 | Out of range during a transfer | Start the ≥ 30-min file, walk away until it drops, come back | Transfer restarts by itself and completes, no duplicate entry | P1 | m5 (dropped link) |
| G7 | Cancel the current file | During a transfer: "Überspringen" on that file | Entry stays in History as "Übersprungen"; "Vom Gerät erneut synchronisieren" works | P1 | m5 |
| G8 | Cancel all | During a batch: "Alle abbrechen" | Stops, no half-uploaded entries | P2 | — |
| G9 | Skip / unskip a file | Skip on the device page, then sync it again | Skipped file is not auto-synced; manual sync works | P2 | — |
| G10 | App in background during a transfer (iOS) | Start a transfer, lock the iPhone 2 min | Continues or resumes after unlock, no corrupt file | P2 | — |
| G11 | Upload fails for a recorder file | Offline right after the transfer | Retries later without transferring the file again | P2 | m5 |
| G12 | Context prompt | Answer "Übernehmen & hochladen" for one file, "Überspringen" for another, then "Für alle weiteren Aufnahmen übernehmen" | Each option respected, asked once per file | P2 | — |
| G13 | Forget and pair again | Aufnahmegerät → ⋮ menu → "Gerät vergessen", then pair again | Unpaired cleanly, pairs again, files not duplicated | P1 | m5, m7 |
| G14 | Reinstall and pair again | Uninstall app (recorder still paired), install, log in, pair | Pairs without "bereits mit einer anderen App gekoppelt" | P1 | m7 |
| G15 | Recorder paired to another phone | Pair the same recorder from a second phone/user | Clear, translated message telling what to do | P2 | m7 (foreign app) |
| G16 | Bluetooth off | Phone Bluetooth off, scan | Translated message to switch it on | P2 | unit `bleErrors` |
| G17 | Reset recorder | Aufnahmegerät → ⋮ menu → "Gerät zurücksetzen" (**wipes the card**) | Recorder formatted and unpaired | P3 | — |
| G18 | Error texts | Provoke G5, G6, G15, G16 | Every message translated and actionable, no raw codes | P1 | unit `bleErrors` |

### K. Android 16 behaviour (target API 36)

Run on a phone with **Android 16**. Apps targeting API 36 get Google's predictive back
gesture, forced edge-to-edge drawing and free rotation on large screens.

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| K1 | Layout edge-to-edge | Open Aufnehmen, Verlauf, Einstellungen, Aufnahmegerät; open a dialog | Nothing hidden under the status bar or the navigation bar, bottom tabs fully tappable, with gesture navigation and with 3-button navigation | P2 | — |
| K2 | Back gesture | Swipe back inside a dialog, on a sub-page and on the start page | Dialog closes; sub-page goes back; on the start page the app goes to the background with the system animation | P2 | — |
| K3 | Tablet or foldable rotation | Rotate while recording and on History | Layout usable in landscape, recording continues | P3 | — |

### H. Notifications, permissions, battery

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| H1 | Notification permission | First recorder sync on Android 13+ / iOS | Prompt appears at that moment; progress and completion notifications shown | P2 | — |
| H2 | Battery optimisation (Android) | Record with battery saver on | Recording survives, or the app explains the exemption | P3 | — |
| H3 | Low battery during recording | Battery ≤ 15 % | Warning; at the critical level the recording is saved | P3 | — |

### I. Account

| ID | Case | Steps | Expected | Prio | Automated |
|---|---|---|---|---|---|
| I1 | Remaining minutes | Einstellungen → "Verbleibende Credits" | Correct balance or unlimited | P2 | — |
| I2 | Delete account | Only with a throwaway account | Account deleted, logged out | P3 | — |

### Time budget

| Scope | Cases | Time with 2 phones + recorder |
|---|---|---|
| P1 only | 26 | about 2 hours |
| P1 + P2 | 56 | about 4 hours |
| Everything | 66 | about 5 hours |

### Scope of 3.9.37

This release changed storage location and migration, iOS background handling, disk-space
checks, login error handling, language detection, History (day groups, no duplicates,
skipped entries), delete after upload, delete all, upload retry policy and the whole
recorder protocol layer, and versionCode 40 raised the Android target to API 36. In scope:
**all P1** plus A3, B3, B6, B8, C1, D2, D6, E2, E5, F1, F5, F7, F8, G8, G9, G10, G11, G12,
G15, G16, K1, K2.

---

## 10. Troubleshooting — failures that already happened

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 10.1 | iOS job fails in seconds at "Deploy to TestFlight": `could not read Username` or 403 | the match PAT expired or lost access to `xicoarm/certificates` | as **xicoarm**: GitHub → Settings → Developer settings → Fine-grained tokens → new token, repository access **Only select repositories** with `certificates` + `suisse-notes-desktop`, Contents **Read-only**; test with `git -c http.extraheader="Authorization: Basic $(printf 'xicoarm:%s' '<PAT>' \| base64 -w0)" ls-remote https://github.com/xicoarm/certificates.git HEAD`; then `printf 'xicoarm:%s' '<PAT>' \| base64 -w0 \| gh secret set MATCH_GIT_BASIC_AUTHORIZATION -R xicoarm/suisse-notes-desktop`; `gh run rerun <run-id> --failed` |
| 10.2 | App cannot log in or upload after an update, nothing in server logs | CSP `connect-src` in `index.html` does not allow the API host | artifact check §4.6; `RELEASE-RUNBOOK.md` §1a |
| 10.3 | Store review rejected: "login credentials are incorrect" | demo account in the console is dead | §7.1 curl check before every submission; fix in Play "App-Inhalte → App-Zugriff" / via `ios-submit.yml` |
| 10.4 | Play: "Version code N has already been used" | versionCode reused (also after an internal-testing upload) | bump `versionCode` and rebuild |
| 10.5 | "Mobile Release" run green in 7 seconds, no artifacts | commit starts with `chore(release):` or contains `[skip ci]` | push a normal commit or dispatch manually |
| 10.6 | Sentry mobile events show minified frames (`js_no_source`) | source maps not uploaded (glob or release name wrong) | CI log must contain "Successfully uploaded source maps to Sentry"; config in `quasar.config.js` |
| 10.7 | Four modified files under `src-capacitor/` after a local build | `cap sync` rewrites them | `git checkout --` them (§4.4) |
| 10.8 | App Store Connect shows an empty page | not signed in (it does not redirect reliably) | sign in as a human first |
| 10.9 | Play text matching fails in automation | non-breaking spaces in Play's UI | match with `\s+` |
| 10.10 | Recorder transfers fail on every retry / file list shows duplicates | stale Bluetooth frames (fixed in 3.9.37) | run the harness scenario `m5-recorder-sync` after every recorder change |

---

## 11. Store obligations and deadlines

| Due | Store | Obligation | Status 2026-09-12 |
|---|---|---|---|
| 2026-09-30 | Google Play | Register the apps for **Android developer verification**. Unregistered Play apps are removed worldwide. | **done** — `ch.suissenotes.app` registered since 2026-03-05 with 2 signing keys (Play Console → Identitätsbestätigung für Android-Entwickler → Paketnamen: "Registriert"). Check there that every new package name or new signing key is registered too. |
| 2026-11-01 | Google Play | Target **API level 36**. After that date no updates can be published. | **done** in versionCode 40 (`targetSdkVersion = 36` in `src-capacitor/android/variables.gradle`). Google raises the level every year around August — check the Play Console warning on every upload. |
| 2026-09-07 | App Store | Social-media age-rating questions (App-Informationen banner) | check in App Store Connect |
| — | both | Store screenshots still show the old "Suisse Notes" UI | open |

Check the Play Console inbox (bell icon, "Ungelesene Benachrichtigungen") and the App Store
Connect banners at the start of every release.

---

## 12. Rules for Claude sessions

1. **Read this guide and `RELEASE-RUNBOOK.md` first.** Follow the phases in order.
2. **Browser work** happens in the user's own Chrome through the Claude in Chrome extension.
   It works when the user is already signed in to the console. On 2026-09-12 the Play
   Console was signed in; App Store Connect was not.
3. **Never type a password, never sign in, never create an account.** If a login page
   appears, ask the user to sign in and wait.
4. **Publishing clicks** — "Speichern und veröffentlichen", "Änderungen zur Überprüfung
   einreichen", `ios-submit.yml -f submit=true`, merging to `main` — happen only after the
   user said to release in this conversation, and the final message says exactly what was
   published.
5. In the Play Console, find elements by their label (`find`, element refs); screenshot
   coordinates drift. Upload files through the hidden file input, never through the picker
   button. Wait for rendering before reading the page.
6. Verify every step by its visible result (§5.2 step 11, §7.3 step 6), not by the absence of an error.
7. Close the browser tabs you opened.
8. After the release: release log in `RELEASE-RUNBOOK.md`, update this guide if anything differed.

Fallback when the extension is not available: launch a separate Chrome with
`--remote-debugging-port=9222 --user-data-dir=<temp>` (PowerShell `Start-Process`), let the
user sign in inside that window, drive it with `puppeteer-core` over CDP. The user's normal
Chrome profile cannot be reused for this (locked cookies, app-bound encryption).

---

## 13. Recommended improvements

| Improvement | Effect | How |
|---|---|---|
| Play service account (`PLAY_STORE_JSON_KEY`) | Android uploads to internal testing without a browser; production promotion via `fastlane promote_to_production` | Google Cloud project → create a service account → JSON key; Play Console → Nutzer und Berechtigungen → invite the service account email with release rights for Suisse Meets; store the JSON as secret `PLAY_STORE_JSON_KEY`. The `android` job then runs lane `internal` automatically. |
| TestFlight status script | see processing state and tester availability without a browser login | small workflow using the ASC API like `scripts/asc-submit.js` (`GET /v1/builds?filter[app]=6758680707`) |
| Release notes as `ios-submit.yml` input | no code edit per release | replace the hard-coded heredoc with a `notes` input |
| Android emulator stage in CI | install the real APK, log in, record with injected audio, upload | `reactivecircus/android-emulator-runner` on `ubuntu-latest` with the harness' mock backend |
| Keystore backup | recovery without Google's upload-key reset | keep an offline copy of the upload keystore in the company password manager; note where in `RELEASE-RUNBOOK.md` |
