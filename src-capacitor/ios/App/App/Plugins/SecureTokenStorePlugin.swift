import Foundation
import Capacitor
import Security

/**
 * SecureTokenStorePlugin
 *
 * Small key/value store for the session token and other secrets, backed by
 * the iOS Keychain (kSecClassGenericPassword, service
 * "ch.suissenotes.app.secure", accessible after first unlock, this device
 * only - so it is neither synced to iCloud Keychain nor restored onto
 * another device from a backup).
 *
 * JS: get({ key }) -> { value: string | null }, set({ key, value }), remove({ key }).
 * Every failure rejects: the JS layer then refuses to store (no plaintext
 * fallback to UserDefaults).
 */
@objc(SecureTokenStorePlugin)
public class SecureTokenStorePlugin: CAPPlugin {

    private let service = "ch.suissenotes.app.secure"

    private func validKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), !key.isEmpty, key.count <= 128,
              key.range(of: "^[A-Za-z0-9_.-]+$", options: .regularExpression) != nil else {
            call.reject("INVALID_KEY")
            return nil
        }
        return key
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        var query = baseQuery(key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(["value": NSNull()])
            return
        }
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("KEYSTORE_READ_FAILED", String(status))
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        guard let value = call.getString("value"), let data = value.data(using: .utf8) else {
            call.reject("MISSING_VALUE")
            return
        }
        // Update in place (value and accessibility class), add only when there
        // is no item yet. Never delete first: a failed write must leave the
        // stored token intact (KeychainUpsert).
        let query = baseQuery(key)
        let changes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var attributes = query
        attributes.merge(changes) { _, new in new }
        let status = KeychainUpsert.upsert(
            update: { SecItemUpdate(query as CFDictionary, changes as CFDictionary) },
            add: { SecItemAdd(attributes as CFDictionary, nil) }
        )
        guard status == errSecSuccess else {
            call.reject("KEYSTORE_WRITE_FAILED", String(status))
            return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = validKey(call) else { return }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("KEYSTORE_REMOVE_FAILED", String(status))
            return
        }
        call.resolve()
    }
}

// BEGIN KeychainUpsert (also compiled standalone by tests/native/keychain-upsert.test.mjs)
/// Write strategy of SecureTokenStorePlugin.set: SecItemUpdate first; SecItemAdd
/// only on errSecItemNotFound; if an item appeared in between (errSecDuplicateItem)
/// update once more. There is no delete, so every failure leaves the previous
/// value in the Keychain and is returned to the caller.
enum KeychainUpsert {
    static func upsert(update: () -> OSStatus, add: () -> OSStatus) -> OSStatus {
        let updated = update()
        if updated != errSecItemNotFound { return updated }
        let added = add()
        if added == errSecDuplicateItem { return update() }
        return added
    }
}
// END KeychainUpsert
