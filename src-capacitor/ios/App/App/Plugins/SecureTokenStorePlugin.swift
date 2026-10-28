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
        // Delete + add, so the accessibility class is always the current one
        // (an update would keep the attributes of an older item).
        SecItemDelete(baseQuery(key) as CFDictionary)
        var attributes = baseQuery(key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
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
