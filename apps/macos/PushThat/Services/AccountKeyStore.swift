import Foundation
import Security

/// The account key as this device keeps it after sign-in, with what it is good for: the
/// account it opens and the key version it belongs to. A key is never used for another
/// account than the one it was stored for, and the version lets a device tell that a reset
/// elsewhere has replaced the key under it (docs/e2ee.md, "The user document").
struct StoredAccountKey: Codable, Equatable {
    let uid: String
    let keyVersion: Int
    let key: Data
}

/// The device's key store (docs/e2ee.md, "Where keys live on each device"): Keychain
/// generic passwords for the account key and the install's `deviceId`, readable after the
/// first unlock so that the share extension, and in phase 4 the notification service
/// extension, can read them while the phone is locked. The `deviceId` also stays on this
/// device (see `deviceId()`).
///
/// The items live in the access group the app and its share extension already share for
/// Firebase Auth, so an extension finds the key where it finds the session. This file is
/// the same in `apps/ios` and `apps/macos`; only the access group differs.
enum AccountKeyStore {
    private static let service = "com.makerocketgonow.pushthat.e2ee"
    private static let accountKeyItem = "accountKey"
    private static let deviceIdItem = "deviceId"

    enum StoreError: LocalizedError {
        case keychain(OSStatus)

        var errorDescription: String? {
            switch self {
            case .keychain(let status):
                return "This device could not keep your encryption key (Keychain error \(status))."
            }
        }
    }

    /// The shared access group, or nil to use the app's default one.
    ///
    /// iOS: the app group, as `AppDelegate` gives it to Firebase. An app group is a keychain
    /// access group without the team prefix, so the literal is the real group name.
    ///
    /// macOS: the app and the extension share `$(TeamIdentifierPrefix)com.makerocketgonow
    /// .pushthatapp` instead (docs/macos.md), and Swift does not expand a build setting in a
    /// string literal, so the group is read from the app's own signed entitlements, where
    /// the prefix has been filled in. An unsigned build has no entitlements and gets nil,
    /// which still compiles and runs; it just cannot share with the extension.
    static let accessGroup: String? = {
        #if os(macOS)
        guard let task = SecTaskCreateFromSelf(nil),
              let groups = SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, nil) as? [String]
        else { return nil }
        return groups.first { $0.hasSuffix(".com.makerocketgonow.pushthatapp") }
        #else
        return "group.com.makerocketgonow.pushthat"
        #endif
    }()

    private static func query(_ item: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: item,
            // On macOS this picks the iOS-style keychain, which is what honours access
            // groups and accessibility; the legacy file keychain would ignore both and
            // prompt for access. On iOS it is the only keychain and the flag changes nothing.
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    private static func read(_ item: String) -> Data? {
        var query = query(item)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private static func write(_ item: String, _ data: Data, accessible: CFString) throws {
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: accessible,
        ]
        var status = SecItemUpdate(query(item) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(item).merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw StoreError.keychain(status) }
    }

    /// The stored key, if there is one for this account.
    static func accountKey(for uid: String) -> StoredAccountKey? {
        guard let data = read(accountKeyItem),
              let stored = try? JSONDecoder().decode(StoredAccountKey.self, from: data),
              stored.uid == uid,
              stored.key.count == E2eeCrypto.accountKeyLength
        else { return nil }
        return stored
    }

    /// `AfterFirstUnlock` without `ThisDeviceOnly`, as the spec has it: a phone restored
    /// from an encrypted backup comes back with the key and needs no password to read its
    /// pushes.
    static func save(_ stored: StoredAccountKey) throws {
        try write(accountKeyItem, JSONEncoder().encode(stored), accessible: kSecAttrAccessibleAfterFirstUnlock)
    }

    /// On sign-out. The device id stays: it belongs to the install, not the account.
    static func clearAccountKey() {
        SecItemDelete(query(accountKeyItem) as CFDictionary)
    }

    /// This install's id, made on first use.
    ///
    /// `ThisDeviceOnly`, unlike the account key: the id names the install, and phase 4
    /// skips a push whose `deviceId` is the device's own (echo suppression). With the key's
    /// accessibility it would travel through a backup, and a phone restored from another's
    /// backup would share its id, so each would hide the other's pushes.
    static func deviceId() throws -> String {
        if let data = read(deviceIdItem), let id = String(data: data, encoding: .utf8), !id.isEmpty {
            return id
        }
        let id = E2eeCrypto.newDeviceId()
        try write(deviceIdItem, Data(id.utf8), accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
        return id
    }
}
