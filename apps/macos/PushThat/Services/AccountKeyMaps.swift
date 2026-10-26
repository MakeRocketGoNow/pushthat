import Foundation

/// The decisions behind `AccountKeyService`, with nothing from Firebase: what a sign-in
/// makes of the stored keys, and what each write makes of the map its transaction read.
/// They are here, apart from the reads and writes in AccountKeyService.swift, so that the
/// test bundle can compile them and check them without Firestore (PushThatTests is not
/// hosted by the app; see E2eeVectorTests). This file is the same in `apps/ios` and
/// `apps/macos`.

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

    /// Whether two reads hold the same keys: the same version and the same wraps. Nil (no
    /// keys) matches only nil.
    static func same(_ a: StoredE2ee?, _ b: StoredE2ee?) -> Bool {
        a?.keyVersion == b?.keyVersion && a.map { Set($0.wraps.keys) } == b.map { Set($0.wraps.keys) }
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

    static func e2eeMap(base: [String: Any], keyVersion: Int, wraps: [String: E2eeCrypto.Wrap]) -> [String: Any] {
        var map = base
        map["v"] = 1
        map["kdf"] = E2eeCrypto.kdf
        map["keyVersion"] = keyVersion
        map["wraps"] = wraps.mapValues { $0.firestoreData }
        return map
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

    // MARK: - What each write makes of the stored map

    /// `startNewKeys`: the new wraps in place of every stored one, one version up, written
    /// only over the keys the caller decided from (see `startNewKeys`).
    static func newKeysMap(stored: StoredE2ee?, decidedFrom: StoredE2ee?, wraps: [String: E2eeCrypto.Wrap]) throws -> [String: Any] {
        guard StoredE2ee.same(stored, decidedFrom) else { throw KeyError.keysChanged }
        return e2eeMap(base: stored?.raw ?? [:], keyVersion: (stored?.keyVersion ?? 0) + 1, wraps: wraps)
    }

    /// `replaceRecoveryKey`: the password wraps kept and every recovery wrap replaced by
    /// the new one, for the account key at `keyVersion` only.
    static func replacedRecoveryMap(stored: StoredE2ee?, keyVersion: Int, wrapId: String, wrap: E2eeCrypto.Wrap) throws -> [String: Any] {
        guard let stored, stored.keyVersion == keyVersion else { throw KeyError.keysChanged }
        var wraps = stored.wraps(by: E2eeCrypto.Wrap.password)
        wraps[wrapId] = wrap
        return stored.with(wraps: wraps)
    }

    /// `rewrapWithRecoveryKey`: the new password wrap and at most three recovery wraps,
    /// the one that opened first.
    static func rewrappedMap(current: StoredE2ee?, keyVersion: Int, openedId: String, passwordWrapId: String, passwordWrap: E2eeCrypto.Wrap) throws -> [String: Any] {
        // The key opened belongs to the version read at sign-in; if a reset elsewhere has
        // replaced it since, its wrap would open the wrong key.
        guard let current, current.keyVersion == keyVersion else { throw KeyError.keysChanged }
        let recovery = current.wraps(by: E2eeCrypto.Wrap.recovery)
        var kept: [String: E2eeCrypto.Wrap] = [:]
        if let first = recovery[openedId] { kept[openedId] = first }
        for (id, wrap) in recovery.sorted(by: { $0.key < $1.key }) where kept.count < maxWraps - 1 {
            kept[id] = wrap
        }
        kept[passwordWrapId] = passwordWrap
        return current.with(wraps: kept)
    }

    /// `addPasswordWrap`: the new password's wrap added, room made for it, and the ids of
    /// the wraps the current password opens, for `removeWraps` once Firebase has the new
    /// password.
    static func addedPasswordWrapMap(
        stored: StoredE2ee?, uid: String, deviceKey: Data, keyVersion: Int,
        currentMasterKey: Data, newWrapId: String, newWrap: E2eeCrypto.Wrap
    ) throws -> (e2ee: [String: Any], currentIds: Set<String>) {
        guard let stored, stored.keyVersion == keyVersion else { throw KeyError.keysChanged }
        var wraps = stored.wraps
        var current: Set<String> = []
        for (id, wrap) in stored.wraps(by: E2eeCrypto.Wrap.password) {
            guard let key = try? E2eeCrypto.unwrapAccountKey(wrappingKey: currentMasterKey, wrap: wrap, uid: uid) else { continue }
            // The current password opens a different key than this device holds: the
            // device's key is stale, and wrapping it again would lose the real one.
            guard key == deviceKey else { throw KeyError.keysChanged }
            current.insert(id)
        }
        wraps[newWrapId] = newWrap
        // Room for the new wrap, least needed first: password wraps nothing opens (their
        // password is gone), then the current password's beyond one (it only has to
        // last until Firebase has the new password), then recovery wraps. Pruning only
        // the first kind, as an earlier version did, left 1 password + 3 recovery wraps (what a
        // recovery can leave) at five, which the rules refuse, so the change could never
        // succeed. Several recovery wraps come only from clients racing, and nothing
        // says which of their keys the user holds, so the order among them is just a
        // stable one; dropping one is better than a password that cannot change.
        let password = stored.wraps(by: E2eeCrypto.Wrap.password).keys.sorted()
        let room = password.filter { !current.contains($0) }
            + password.filter { current.contains($0) }.dropFirst()
            + stored.wraps(by: E2eeCrypto.Wrap.recovery).keys.sorted().reversed()
        for id in room where wraps.count > maxWraps {
            wraps[id] = nil
        }
        return (stored.with(wraps: wraps), current)
    }

    /// `removeWraps`: the given wraps gone, if they are still there; everything else stays.
    static func removedWrapsMap(stored: StoredE2ee?, ids: [String]) throws -> [String: Any] {
        guard let stored else { throw KeyError.noKeys }
        var wraps = stored.wraps
        for id in ids { wraps[id] = nil }
        return stored.with(wraps: wraps)
    }
}
