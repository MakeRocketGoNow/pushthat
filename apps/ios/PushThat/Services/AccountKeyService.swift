import Foundation
import FirebaseFirestore

/// The reads and writes of the account's wrapped keys. What a sign-in decides from them and
/// what each write makes of the stored map are in AccountKeyMaps.swift, beside
/// `StoredE2ee` and the rest of `AccountKeyService`, where the tests can reach them.
extension AccountKeyService {
    private static var db: Firestore { Firestore.firestore() }

    private static func userRef(_ uid: String) -> DocumentReference {
        db.collection("users").document(uid)
    }

    /// The stored keys, or nil for an account with none (or none this client can read).
    ///
    /// From the server, never the cache: a sign-in decides from this whether the account
    /// needs new keys, and a cached copy from before another device wrote them (the push
    /// list's own reads fill the cache) would have it replace keys that device is using.
    /// Sign-in needs the network anyway.
    static func read(uid: String) async throws -> StoredE2ee? {
        let snapshot = try await userRef(uid).getDocument(source: .server)
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
    /// version is one past the stored one; an account with no keys starts at 1.
    ///
    /// `decidedFrom` is the read the caller chose new keys from (nil for a registration, or
    /// an account that had none). If the transaction finds other keys, it throws
    /// `keysChanged` rather than writing over them: two devices migrating the same legacy
    /// account a moment apart would otherwise each write a key, and the first would keep
    /// a key and a recovery key that no longer open anything. Going one version past
    /// whatever is there, as this did before, does not prevent that; it only hides it.
    static func startNewKeys(uid: String, email: String, masterKey: Data, decidedFrom: StoredE2ee?) async throws -> NewKeys {
        let accountKey = E2eeCrypto.newAccountKey()
        let recoveryBytes = E2eeCrypto.newRecoveryKey()
        let wraps = [
            E2eeCrypto.newWrapId(): try E2eeCrypto.wrapAccountKey(wrappingKey: masterKey, accountKey: accountKey, uid: uid, by: E2eeCrypto.Wrap.password),
            E2eeCrypto.newWrapId(): try E2eeCrypto.wrapAccountKey(
                wrappingKey: E2eeCrypto.recoveryWrappingKey(recoveryBytes), accountKey: accountKey, uid: uid, by: E2eeCrypto.Wrap.recovery
            ),
        ]
        let written = try await write(uid: uid, email: email) { stored in
            try newKeysMap(stored: stored, decidedFrom: decidedFrom, wraps: wraps)
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
            try replacedRecoveryMap(stored: stored, keyVersion: keyVersion, wrapId: wrapId, wrap: wrap)
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
            try rewrappedMap(current: current, keyVersion: stored.keyVersion, openedId: opened.id, passwordWrapId: passwordWrapId, passwordWrap: passwordWrap)
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
            let added = try addedPasswordWrapMap(
                stored: stored, uid: uid, deviceKey: device.key, keyVersion: device.keyVersion,
                currentMasterKey: currentMasterKey, newWrapId: newWrapId, newWrap: newWrap
            )
            found.ids = added.currentIds
            return added.e2ee
        }
        return Array(found.ids)
    }

    /// Deletes the given wraps, if they are still there; everything else stays.
    static func removeWraps(uid: String, email: String, ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        try await write(uid: uid, email: email) { stored in
            try removedWrapsMap(stored: stored, ids: ids)
        }
    }
}
