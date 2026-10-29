import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// iOS SecureTokenStorePlugin.set must never lose the stored token when a
// Keychain write fails (it used to delete first, then add). The write
// strategy (KeychainUpsert, in the plugin source between BEGIN/END markers)
// is compiled with swiftc against the real Security constants and run with
// simulated Keychain results. Runs wherever swiftc exists (macOS CI runner);
// on a macOS CI runner a missing swiftc fails the test instead of skipping.

const PLUGIN = 'src-capacitor/ios/App/App/Plugins/SecureTokenStorePlugin.swift';
const hasSwiftc = spawnSync('swiftc', ['--version'], { stdio: 'ignore' }).status === 0;
const mustRun = process.platform === 'darwin' && !!process.env.CI;

function upsertSource() {
  const src = readFileSync(PLUGIN, 'utf8');
  const m = src.match(/\/\/ BEGIN KeychainUpsert[^\n]*\n([\s\S]*?)\/\/ END KeychainUpsert/);
  if (!m) throw new Error('KeychainUpsert block not found in the plugin');
  return m[1];
}

const DRIVER = String.raw`
import Foundation
import Security

var failures = 0
func check(_ cond: Bool, _ name: String) { if !cond { failures += 1; print("FAIL: \(name)") } else { print("ok: \(name)") } }

// A one-item fake Keychain: value nil = no item.
final class FakeKeychain {
  var value: String?
  var updateResults: [OSStatus] = []
  var addResult: OSStatus = errSecSuccess
  var calls: [String] = []
  init(_ v: String?) { value = v }
  func update(_ v: String) -> OSStatus {
    calls.append("update")
    let r = updateResults.isEmpty ? (value == nil ? errSecItemNotFound : errSecSuccess) : updateResults.removeFirst()
    if r == errSecSuccess { value = v }
    return r
  }
  func add(_ v: String) -> OSStatus {
    calls.append("add")
    if addResult == errSecSuccess { if value != nil { return errSecDuplicateItem }; value = v }
    return addResult
  }
}

func run(_ k: FakeKeychain, _ v: String) -> OSStatus { KeychainUpsert.upsert(update: { k.update(v) }, add: { k.add(v) }) }

do { let k = FakeKeychain("old"); check(run(k, "new") == errSecSuccess && k.value == "new" && k.calls == ["update"], "existing item is updated in place") }
do { let k = FakeKeychain(nil); check(run(k, "new") == errSecSuccess && k.value == "new" && k.calls == ["update", "add"], "missing item is added") }
do { let k = FakeKeychain("old"); k.updateResults = [errSecInteractionNotAllowed]
     let r = run(k, "new"); check(r == errSecInteractionNotAllowed && k.value == "old" && k.calls == ["update"], "locked device: update fails, old token kept, no add/delete") }
do { let k = FakeKeychain("old"); k.updateResults = [errSecDecode]
     check(run(k, "new") == errSecDecode && k.value == "old", "other update error: old token kept") }
do { let k = FakeKeychain(nil); k.addResult = errSecNotAvailable
     check(run(k, "new") == errSecNotAvailable && k.value == nil, "add failure is reported") }
do { let k = FakeKeychain(nil); k.updateResults = [errSecItemNotFound, errSecSuccess]; k.value = nil
     // Item created between update and add: add reports duplicate, second update wins.
     let r = KeychainUpsert.upsert(update: { k.update("new") }, add: { k.value = "racer"; return errSecDuplicateItem })
     check(r == errSecSuccess && k.value == "new" && k.calls == ["update", "update"], "duplicate after not-found: updated once more") }
if failures > 0 { exit(1) }
`;

describe('iOS SecureTokenStore write strategy (KeychainUpsert)', () => {
  it('the plugin uses SecItemUpdate/SecItemAdd via KeychainUpsert and never deletes in set()', () => {
    const src = readFileSync(PLUGIN, 'utf8');
    const setBody = src.slice(src.indexOf('@objc func set('), src.indexOf('@objc func remove('));
    expect(setBody).toContain('KeychainUpsert.upsert(');
    expect(setBody).toContain('SecItemUpdate(');
    expect(setBody).not.toContain('SecItemDelete');
  });

  it.skipIf(!hasSwiftc && !mustRun)('error cases (compiled with swiftc)', () => {
    expect(hasSwiftc).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'keychain-upsert-'));
    try {
      const file = join(dir, 'main.swift');
      writeFileSync(file, `import Security\n${upsertSource()}\n${DRIVER}`);
      execFileSync('swiftc', ['-o', join(dir, 'upsert'), file], { stdio: 'pipe' });
      const out = execFileSync(join(dir, 'upsert'), { encoding: 'utf8' });
      expect(out).not.toContain('FAIL');
      expect(out.match(/^ok:/gm)).toHaveLength(6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180000);
});
