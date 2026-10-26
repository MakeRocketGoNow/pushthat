import Foundation
import FirebaseFirestore

/// `users/{uid}.e2ee` as it was read: the map whole, so that a rewrite keeps what it did
/// not mean to change (`migratedAt`), and the parts the clients act on.
struct StoredE2ee {
    let raw: [String: Any]
    let keyVersion: Int
    let wraps: [String: E2eeCrypto.Wrap]

    /// Nil when the field is absent or not a map. A map with a wrap that does not parse
    /// keeps the others, and one without a usable `keyVersion` reads as 0, so a rewrite
    /// still goes above whatever the rules compare it with.
    init?(_ value: Any?) {
        guard let raw = value as? [String: Any] else { return nil }
        self.raw = raw
        keyVersion = (raw["keyVersion"] as? Int) ?? 0
        var wraps: [String: E2eeCrypto.Wrap] = [:]
        for (id, value) in (raw["wraps"] as? [String: Any]) ?? [:] {
            if let wrap = E2eeCrypto.Wrap(firestore: value) { wraps[id] = wrap }
        }
        self.wraps = wraps
    }

    func wraps(by: String) -> [String: E2eeCrypto.Wrap] {
        wraps.filter { $0.value.by == by }
    }

    /// The whole map with these wraps, keeping every other stored field.
    func with(keyVersion: Int? = nil, wraps: [String: E2eeCrypto.Wrap]) -> [String: Any] {
        AccountKeyService.e2eeMap(base: raw, keyVersion: keyVersion ?? self.keyVersion, wraps: wraps)
    }
}

/// Reads and writes the account's wrapped keys (docs/e2ee.md, "The user document"). The
/// rules (`isE2ee`, `isE2eeUpdate` in apps/web/firestore.rules) take the map whole, with
/// at most four wraps and a `keyVersion` that never goes down.
enum AccountKeyService {
    enum KeyError: LocalizedError {
        /// The account key was replaced elsewhere (a reset, or new keys on another device)
        /// since this device read it. Whatever it was about to write would wrap a key that
        /// is no longer the account's, so it stops.
        case keysChanged
        /// More wraps than the rules take, which a well-behaved client never leaves.
        case tooManyWraps
        case noKeys

        var errorDescription: String? {
            switch self {
            case .keysChanged: return "Your encryption keys were changed on another device. Sign out and sign in again."
            case .tooManyWraps: return "Your encryption keys could not be updated. Try again."
            case .noKeys: return "This account has no encryption keys yet. Sign out and sign in again."
            }
        }
    }

    static let maxWraps = 4

    private static var db: Firestore { Firestore.firestore() }

    private static func userRef(_ uid: String) -> DocumentReference {
        db.collection("users").document(uid)
    }

    static func e2eeMap(base: [String: Any], keyVersion: Int, wraps: [String: E2eeCrypto.Wrap]) -> [String: Any] {
        var map = base
        map["v"] = 1
        map["kdf"] = E2eeCrypto.kdf
        map["keyVersion"] = keyVersion
        map["wraps"] = wraps.mapValues { $0.firestoreData }
        return map
    }

    /// The stored keys, or nil for an account with none (or none this client can read).
    static func read(uid: String) async throws -> StoredE2ee? {
        let snapshot = try await userRef(uid).getDocument()
        return StoredE2ee(snapshot.data()?["e2ee"])
    }

    /// Writes the `e2ee` map `build` makes from the stored one, read again in the same
    /// transaction. A copy read earlier could be minutes old (the user looking for a
    /// recovery key), and writing the whole map from it would undo whatever changed
    /// meanwhile, which the rules' "keyVersion only goes up" cannot see at an equal
    /// version. If the user document does not exist yet it is created here with `email`,
    /// `createdAt` and the keys: another client (the extension, a token write) can create
    /// it first, which is why this is a transaction and not a blind set. The web app's
    /// `writeKeys` in apps/web/src/services/accountKeys.ts does the same.
    ///
    /// `build` may run more than once, as Firestore retries a transaction that raced
    /// another write, so it must not keep state between runs. Its error is carried out
    /// beside the transaction as well as through Firestore's error pointer: setting the
    /// pointer is what stops Firestore committing, but it makes `runTransaction` throw a
    /// bridged `NSError`, so the catch below swaps the `KeyError` the closure threw back in.
    /// Without that, a caller matching `KeyError.keysChanged` would never see it.
    @discardableResult
    static func write(uid: String, email: String, build: @escaping (StoredE2ee?) throws -> [String: Any]) async throws -> StoredE2ee {
        final class Outcome: @unchecked Sendable {
            var error: Error?
            var written: [String: Any]?
        }
        let outcome = Outcome()
        let ref = userRef(uid)
        do {
            _ = try await db.runTransaction { transaction, errorPointer in
                outcome.error = nil
                do {
                    let snapshot = try transaction.getDocument(ref)
                    let e2ee = try build(StoredE2ee(snapshot.data()?["e2ee"]))
                    if let wraps = e2ee["wraps"] as? [String: Any], wraps.count > maxWraps {
                        throw KeyError.tooManyWraps
                    }
                    if snapshot.exists {
                        transaction.updateData(["e2ee": e2ee], forDocument: ref)
                    } else {
                        transaction.setData(UserDocument.newUserData(email: email, e2ee: e2ee), forDocument: ref)
                    }
                    outcome.written = e2ee
                    return nil
                } catch {
                    outcome.error = error
                    errorPointer?.pointee = error as NSError
                    return nil
                }
            }
        } catch {
            throw outcome.error ?? error
        }
        guard let written = StoredE2ee(outcome.written) else { throw KeyError.noKeys }
        return written
    }

    // MARK: - What a sign-in finds

    enum Resolution {
        /// A password wrap opened: this is the account key.
        case opened(accountKey: Data, keyVersion: Int)
        /// No password wrap opens, but a recovery wrap exists to try.
        case needsRecovery(StoredE2ee)
        /// Nothing to open: a registration, a legacy account, or a document with no usable
        /// wraps. `stored` is passed on so the new keys go above its version.
        case needsNewKeys
    }

    static func resolve(uid: String, masterKey: Data, stored: StoredE2ee?) -> Resolution {
        guard let stored else { return .needsNewKeys }
        for wrap in stored.wraps(by: E2eeCrypto.Wrap.password).values {
            if let accountKey = try? E2eeCrypto.unwrapAccountKey(wrappingKey: masterKey, wrap: wrap, uid: uid) {
                return .opened(accountKey: accountKey, keyVersion: stored.keyVersion)
            }
        }
        if !stored.wraps(by: E2eeCrypto.Wrap.recovery).isEmpty {
            return .needsRecovery(stored)
        }
        return .needsNewKeys
    }

    // MARK: - Writing keys

    struct NewKeys {
        let accountKey: Data
        let keyVersion: Int
        /// The recovery key in its display form, to show once.
        let recoveryKey: String
    }

    /// A new account key and recovery key, with both wraps written together before the key
    /// is shown: a recovery wrap the user never saved costs nothing, and writing it later
    /// would leave an app closed on the key screen with no recovery wrap at all. The
    /// version is one past the stored one, read again as it is written, so a reset
    /// elsewhere in the meantime is passed rather than repeated; an account with no keys
    /// starts at 1.
    static func startNewKeys(uid: String, email: String, masterKey: Data) async throws -> NewKeys {
        let accountKey = E2eeCrypto.newAccountKey()
        let recoveryBytes = E2eeCrypto.newRecoveryKey()
        let wraps = [
            E2eeCrypto.newWrapId(): try E2eeCrypto.wrapAccountKey(wrappingKey: masterKey, accountKey: accountKey, uid: uid, by: E2eeCrypto.Wrap.password),
            E2eeCrypto.newWrapId(): try E2eeCrypto.wrapAccountKey(
                wrappingKey: E2eeCrypto.recoveryWrappingKey(recoveryBytes), accountKey: accountKey, uid: uid, by: E2eeCrypto.Wrap.recovery
            ),
        ]
        let written = try await write(uid: uid, email: email) { stored in
            e2eeMap(base: stored?.raw ?? [:], keyVersion: (stored?.keyVersion ?? 0) + 1, wraps: wraps)
        }
        return NewKeys(accountKey: accountKey, keyVersion: written.keyVersion, recoveryKey: try E2eeCrypto.encodeRecoveryKey(recoveryBytes))
    }

    /// Replaces every recovery wrap with one under a new recovery key, keeping the password
    /// wraps, and returns the new key's display form. Used after a legacy migration that
    /// stopped before the user saw a recovery key, and from "Show a new recovery key".
    static func replaceRecoveryKey(uid: String, email: String, accountKey: Data, keyVersion: Int) async throws -> String {
        let recoveryBytes = E2eeCrypto.newRecoveryKey()
        let wrap = try E2eeCrypto.wrapAccountKey(
            wrappingKey: E2eeCrypto.recoveryWrappingKey(recoveryBytes), accountKey: accountKey, uid: uid, by: E2eeCrypto.Wrap.recovery
        )
        let wrapId = E2eeCrypto.newWrapId()
        try await write(uid: uid, email: email) { stored in
            guard let stored, stored.keyVersion == keyVersion else { throw KeyError.keysChanged }
            var wraps = stored.wraps(by: E2eeCrypto.Wrap.password)
            wraps[wrapId] = wrap
            return stored.with(wraps: wraps)
        }
        return try E2eeCrypto.encodeRecoveryKey(recoveryBytes)
    }

    /// The recovery key the user typed opens none of the account's recovery wraps.
    struct WrongRecoveryKey: LocalizedError {
        var errorDescription: String? { "That recovery key does not open this account's keys." }
    }

    /// With the recovery key, after a password was set somewhere that could not rewrap:
    /// opens the account key and wraps it under the new password's `masterKey`. The old
    /// password wraps go, since nothing opens them now; the recovery wraps stay (at most
    /// three, so the map stays inside the rules' four, the one that opened first), and so
    /// does the version, so every push stays readable. No new recovery key is shown: the
    /// user has just shown they have one.
    static func rewrapWithRecoveryKey(uid: String, email: String, masterKey: Data, stored: StoredE2ee, recoveryText: String) async throws -> (accountKey: Data, keyVersion: Int) {
        guard let recoveryBytes = try? E2eeCrypto.decodeRecoveryKey(recoveryText),
              let wrappingKey = try? E2eeCrypto.recoveryWrappingKey(recoveryBytes)
        else { throw WrongRecoveryKey() }
        var opened: (id: String, key: Data)?
        for (id, wrap) in stored.wraps(by: E2eeCrypto.Wrap.recovery) {
            if let key = try? E2eeCrypto.unwrapAccountKey(wrappingKey: wrappingKey, wrap: wrap, uid: uid) {
                opened = (id, key)
                break
            }
        }
        guard let opened else { throw WrongRecoveryKey() }

        let passwordWrap = try E2eeCrypto.wrapAccountKey(wrappingKey: masterKey, accountKey: opened.key, uid: uid, by: E2eeCrypto.Wrap.password)
        let passwordWrapId = E2eeCrypto.newWrapId()
        let written = try await write(uid: uid, email: email) { current in
            // The key opened above belongs to the version read at sign-in; if a reset
            // elsewhere has replaced it since, its wrap would open the wrong key.
            guard let current, current.keyVersion == stored.keyVersion else { throw KeyError.keysChanged }
            let recovery = current.wraps(by: E2eeCrypto.Wrap.recovery)
            var kept: [String: E2eeCrypto.Wrap] = [:]
            if let first = recovery[opened.id] { kept[opened.id] = first }
            for (id, wrap) in recovery.sorted(by: { $0.key < $1.key }) where kept.count < maxWraps - 1 {
                kept[id] = wrap
            }
            kept[passwordWrapId] = passwordWrap
            return current.with(wraps: kept)
        }
        return (opened.key, written.keyVersion)
    }

    /// The first half of a password change: adds a password wrap under the new password's
    /// `masterKey` beside the current one, and returns the ids of the current password's
    /// wraps for `removeWraps` to delete once Firebase has the new password. In that order
    /// a crash between steps leaves an account that opens with either password, never one
    /// that opens with neither.
    static func addPasswordWrap(uid: String, email: String, device: StoredAccountKey, currentMasterKey: Data, newMasterKey: Data) async throws -> [String] {
        let newWrap = try E2eeCrypto.wrapAccountKey(wrappingKey: newMasterKey, accountKey: device.key, uid: uid, by: E2eeCrypto.Wrap.password)
        let newWrapId = E2eeCrypto.newWrapId()
        // What the transaction's last run found; an earlier run Firestore retried may have
        // read other wraps.
        final class Found: @unchecked Sendable { var ids: Set<String> = [] }
        let found = Found()
        try await write(uid: uid, email: email) { stored in
            guard let stored, stored.keyVersion == device.keyVersion else { throw KeyError.keysChanged }
            var wraps = stored.wraps
            var current: Set<String> = []
            defer { found.ids = current }
            for (id, wrap) in stored.wraps(by: E2eeCrypto.Wrap.password) {
                guard let key = try? E2eeCrypto.unwrapAccountKey(wrappingKey: currentMasterKey, wrap: wrap, uid: uid) else { continue }
                // The current password opens a different key than this device holds: the
                // device's key is stale, and wrapping it again would lose the real one.
                guard key == device.key else { throw KeyError.keysChanged }
                current.insert(id)
            }
            wraps[newWrapId] = newWrap
            // Room for the new wrap: password wraps nothing opens any more go first.
            for (id, wrap) in stored.wraps where wraps.count > maxWraps && wrap.by == E2eeCrypto.Wrap.password && !current.contains(id) {
                wraps[id] = nil
            }
            return stored.with(wraps: wraps)
        }
        return Array(found.ids)
    }

    /// Deletes the given wraps, if they are still there; everything else stays.
    static func removeWraps(uid: String, email: String, ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        try await write(uid: uid, email: email) { stored in
            guard let stored else { throw KeyError.noKeys }
            var wraps = stored.wraps
            for id in ids { wraps[id] = nil }
            return stored.with(wraps: wraps)
        }
    }
}
