# BLE Device Sync Bug Report

**Date:** 2026-04-02
**App version at discovery:** 3.7.60
**Fix version:** 3.7.61 (1)
**Affected devices:** All M1(BLE) / Record Card devices — confirmed identical protocol
**Sentry project:** capacitor (project ID 4510958727462992)
**Sentry issue:** [CAPACITOR-2X](https://suisse-it-gmbh.sentry.io/issues/109296171/) — `SyntaxError: JSON Parse error: Unrecognized token '\u0001'`

---

## Symptoms observed

### With old device (working)
- Connects via BLE as `M1(BLE)`
- File list loads correctly
- Auto-sync transfers files to app after recording stops
- Battery displays correct percentage
- Reset device works

### With new device (broken)
- Connects via BLE as `M1(BLE)` — same name, same protocol
- File list never loads
- Device shows "transferring" status permanently (stuck in sync state)
- No files ever sync to the app
- Battery shows 123%, then 0%, then jumps erratically
- Reset device doesn't delete files (claims 0 files to delete)
- Auto-sync retries every 20 seconds, fails every time

### Key observation
Both devices are **identical hardware** (`M1(BLE)`, model `Record Card`, same protocol). The only difference: the new device had **618 files** stored on it. The old device had few files.

---

## Root cause analysis

### The trigger: 618 files

The first `getFileList()` call succeeded in parsing the file count:
```
getFileList countResp raw: [0x01, 0x1b, 0x00, 0x7b, 0x0a, 0x09, 0x22, 0x46, 0x69, 0x6c, 0x65, 0x4e, 0x75, 0x6d, 0x22, 0x3a, 0x09, 0x36, 0x31, 0x38...] len=22
getFileList countJson: {"FileNum":618}
getFileList fileCount=618
```

The function then tried to read 618 file entries one by one via `_readNotification()`. At some point during this long read, a file entry had malformed JSON, causing `SyntaxError: JSON Parse error: Unrecognized token '\u0001'`.

### Bug 1: getFileList didn't exit sync state on error (FIXED in earlier commit)

Before our fix, `getFileList()` entered sync state (`CMD_SYNC_STATE [0x01]`) but had no `try/finally`. When the JSON parse error occurred, the function threw without sending `CMD_SYNC_STATE [0x00]`. The device stayed locked in "transferring" mode permanently.

**Fix:** Added `try/finally` that always exits sync state, matching the pattern already used by `downloadFile()`.

### Bug 2: Device keeps streaming after interrupted file list

After `getFileList` failed mid-way through 618 entries, the device continued sending the remaining file entries as BLE notifications. These accumulated in the notification queue at a rate of ~90-306 notifications per 20-second poll interval.

**Evidence from Sentry breadcrumbs:**
```
Drained 306 stale BLE notification(s)
Drained 221 stale BLE notification(s)
Drained 90 stale BLE notification(s)
Drained 306 stale BLE notification(s)    ← pattern repeats
```

The numbers cycle consistently (90, 306, 221), suggesting a steady stream from the device.

### Bug 3: Instant drain misses in-flight notifications

The original `_drainNotifyQueue()` cleared the queue synchronously in one instant. But between the drain and the next `_write()` command, more stale file entries arrived from the device and entered the queue via `_onNotify()`. This caused a cascade:

1. Drain clears queue
2. Write `CMD_SYNC_STATE [0x01]` to device
3. Stale file entries arrive, get queued
4. `_readNotification()` returns a stale file entry instead of the sync state ack
5. Write `CMD_FILE_LIST`
6. `_readNotification()` returns the sync state ack (`[0x01, 0x74, 0x00, 0x01]`) instead of the file count JSON
7. `parseJsonFromBuffer([0x01, 0x74, 0x00, 0x01], 3)` → tries to parse `0x01` as JSON → `SyntaxError`

**Evidence from Sentry — every retry shows the wrong response:**
```
getFileList countResp raw: [0x01, 0x74, 0x00, 0x01...] len=4    ← CMD_SYNC_STATE response
getFileList countResp raw: [0x01, 0x74, 0x00, 0x01...] len=4    ← repeats every 20s
getFileList countResp raw: [0x01, 0x09, 0x00, 0x3d...] len=4    ← CMD_BATTERY response!
```

`0x74` = `CMD_SYNC_STATE`, `0x09` = `CMD_BATTERY`. Neither is a file list response.

**Fix:** Replaced instant drain with a quiet-wait drain that loops in 300ms intervals until no new notifications arrive (max 5s). Ensures the device's stale stream is fully consumed before sending the next command.

### Bug 4: Concurrent BLE commands interleave responses

The auto-sync poll (`_autoSyncPoll`) ran every 20 seconds. Within each poll, it called `getBattery()` as a keepalive, then `fetchFileList()`. If a previous poll's `getFileList` was still running (reading 618 entries), the next poll's `getBattery()` sent a `CMD_BATTERY` write to the device. The battery response then got consumed by the still-running `getFileList`'s `_readNotification()`.

**Evidence:** Battery responses (`[0x01, 0x09, 0x00, 0x3d]`) appearing inside `getFileList` breadcrumbs. `0x3d` = 61% battery.

**Fix:** Added a promise-based mutex (`_commandLock`) to `BleDeviceManager`. All public BLE commands (getBattery, getStorage, syncTime, getDeviceInfo, getFileList, downloadFile, deleteFile, unpair) acquire the lock before sending and release in `finally`. Concurrent callers wait in a queue instead of interleaving.

### Bug 5: Battery reads wrong byte from wrong response

`getBattery()` did `return resp[3]` without checking that `resp` was actually a battery response. When it consumed a stale notification or a response from another command, `resp[3]` could be any value (0-255), displayed as battery percentage.

**Evidence:**
- Battery showed 123% (0x7B — which is the `{` character, likely from a JSON file entry)
- Battery showed 0% (empty/wrong response)
- At 02:10:03: `getFileList countResp raw: [0x01, 0x09, 0x00, 0x3d...]` — a battery response (`0x3d` = 61%) was consumed by getFileList instead of getBattery

**Fix:** Added response validation to `getBattery()` — checks `resp[0] === TYPE_CMD`, `resp[1] === CMD_BATTERY[0]`, `resp[2] === CMD_BATTERY[1]`, and level is 0-100. Returns -1 for invalid responses. Store ignores -1 and keeps the last valid reading.

### Bug 6: Reset device didn't delete files

`resetDevice()` calls `fetchFileList()` to get the list of files to delete. Since `fetchFileList` → `getFileList` was failing (bugs 2-4), it returned an empty array. The delete loop iterated over 0 files. The device was unpaired but no files were deleted.

**Fix:** Addressed by fixing bugs 2-4. Once `getFileList` works, reset will correctly enumerate and delete files.

---

## Sentry evidence

### Issue: CAPACITOR-2X
- **URL:** https://suisse-it-gmbh.sentry.io/issues/109296171/
- **Error:** `SyntaxError: JSON Parse error: Unrecognized token '\u0001'`
- **Location:** `getFileList` in `device-Dq49pdfA.js`
- **Tag:** `action: ble_file_list`
- **Count:** 30+ events between 01:49 and 02:12 UTC
- **Device:** iPhone, iOS 18.7
- **Release:** ch.suissenotes.mobile@3.7.60

### Handshake info (confirms identical devices)
- **Name:** M1(BLE)
- **SN:** 352404225100000041
- **Model:** Record Card
- **UUID:** afee4dbc-f78e-f60a-c4d6-65ea6fbdafb5

### Key breadcrumb timeline (UTC)
```
01:49:28  BLE device found (name-filter): M1(BLE)
01:49:36  BLE connecting to device
01:49:37  BLE handshake OK: M1(BLE)
01:49:38  getFileList countJson: {"FileNum":618}        ← SUCCESS: 618 files
01:49:38  getFileList fileCount=618
01:49:43  Drained 146 stale BLE notification(s)         ← First failure, stale data starts
01:49:43  countResp raw: [0x01, 0x09, 0x00, 0x40...]    ← Battery response in file list!
01:50:03  Drained 306 stale BLE notification(s)         ← Device still streaming
01:50:03  countResp raw: [0x01, 0x74, 0x00, 0x01...]    ← Sync state response in file list
...       (pattern repeats every 20 seconds until 02:12)
01:56:56  Device started recording (button)
02:09:18  Device stopped recording (button)
02:09:23  Drained 91 stale BLE notification(s)          ← Still broken after 20 minutes
```

---

## Fixes applied (in order)

| Commit | Fix | File |
|--------|-----|------|
| 6e606e5 | `getFileList` always exits sync state via try/finally | bleService.js |
| afa8bb1 | `fetchFileList` catch sends to Sentry with breadcrumbs | device.js |
| 2118947 | Command lock (promise mutex) on all BLE commands | bleService.js |
| f113d3d | Quiet drain — waits until device stops streaming | bleService.js |
| de90b27 | Battery response validation + version bump to 3.7.61 | bleService.js, device.js |

---

## Open questions

1. **Why did the JSON parse fail on a file entry?** The first getFileList correctly parsed `FileNum: 618` and started reading entries. One of the 618 entries had data that wasn't valid JSON. This could be:
   - A corrupt file entry on the device
   - A BLE packet boundary issue (entry split across two notifications, only first half parsed)
   - The device sending a non-file-entry notification mid-stream (e.g., recording state change)

2. **Will the quiet drain be enough?** If the device streams 618 file entries continuously, the 5-second quiet-wait might not be long enough. The drain cycles show ~90-306 notifications per 20s, which is ~5-15 per second. At that rate, 618 entries take ~40-120 seconds. The drain would wait 5 seconds, see no quiet period, and give up. We may need to increase `maxWaitMs` or add a different approach.

3. **Is the new device's storage actually full/corrupted?** 618 files is unusual for a recording device. The device may have accumulated test recordings or have storage issues.

4. **Should getFileList validate each file entry response?** Currently it blindly calls `parseJsonFromBuffer(fileResp, 3)` for each entry. It should verify `fileResp[0] === TYPE_CMD` and `fileResp[1] === CMD_FILE_LIST[0]` before parsing. Non-matching responses should be skipped.

---

## Recommendations

1. **Test on 3.7.61** — confirm Sentry shows the new version and whether the fixes work
2. **Factory reset the new device** — if possible via a physical button on the device, to clear the 618 files
3. **Contact device manufacturer** — ask about:
   - Maximum recommended file count
   - Factory reset BLE command
   - Expected behavior when sync state is exited mid-file-list-transfer
4. **Add file entry response validation** — verify each `_readNotification` response matches the expected command before parsing
5. **Consider paginated file list** — if the protocol supports it, request files in batches instead of all 618 at once
