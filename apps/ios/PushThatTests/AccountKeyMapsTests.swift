import XCTest

/// The decisions in AccountKeyMaps.swift: what a sign-in makes of the stored keys, and what
/// each write makes of the map its transaction read, above all that no write leaves more
/// wraps than the rules' four. Real wraps under random keys, so that "opens" means what it
/// means in the app; no Firestore, which the bundle does not link.
final class AccountKeyMapsTests: XCTestCase {
    private let uid = "test-uid"
    private let accountKey = E2eeCrypto.newAccountKey()
    private let masterKey = E2eeCrypto.randomBytes(32)
    private let otherMasterKey = E2eeCrypto.randomBytes(32)
    private let recoveryWrappingKey = E2eeCrypto.randomBytes(32)

    private func wrap(_ wrappingKey: Data, by: String, key: Data? = nil) throws -> E2eeCrypto.Wrap {
        try E2eeCrypto.wrapAccountKey(wrappingKey: wrappingKey, accountKey: key ?? accountKey, uid: uid, by: by)
    }

    private func stored(keyVersion: Int = 1, _ wraps: [String: E2eeCrypto.Wrap], extra: [String: Any] = [:]) throws -> StoredE2ee {
        let map = AccountKeyService.e2eeMap(base: extra, keyVersion: keyVersion, wraps: wraps)
        return try XCTUnwrap(StoredE2ee(map))
    }

    /// What a write's map reads back as, as the next transaction would see it.
    private func read(_ map: [String: Any]) throws -> StoredE2ee {
        try XCTUnwrap(StoredE2ee(map))
    }

    private func assertKeysChanged(_ body: () throws -> Any, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            guard case AccountKeyService.KeyError.keysChanged = error else {
                return XCTFail("expected keysChanged, got \(error)", file: file, line: line)
            }
        }
    }

    // MARK: - StoredE2ee

    func testWithKeepsOtherFieldsAndSetsTheFormat() throws {
        let before = try stored(keyVersion: 3, ["p": wrap(masterKey, by: "password")], extra: ["migratedAt": 1234])
        let map = before.with(wraps: [:])
        XCTAssertEqual(map["migratedAt"] as? Int, 1234)
        XCTAssertEqual(map["v"] as? Int, 1)
        XCTAssertEqual(map["kdf"] as? String, E2eeCrypto.kdf)
        XCTAssertEqual(map["keyVersion"] as? Int, 3)
        XCTAssertEqual((map["wraps"] as? [String: Any])?.count, 0)
        XCTAssertEqual(before.with(keyVersion: 4, wraps: [:])["keyVersion"] as? Int, 4)
    }

    func testAWrapThatDoesNotParseIsDroppedAndTheOthersKept() throws {
        let good = try wrap(masterKey, by: "password")
        let parsed = try XCTUnwrap(StoredE2ee(["keyVersion": 2, "wraps": ["good": good.firestoreData, "bad": ["by": "other"]]]))
        XCTAssertEqual(Array(parsed.wraps.keys), ["good"])
        XCTAssertNil(StoredE2ee(nil))
        XCTAssertEqual(StoredE2ee([String: Any]())?.keyVersion, 0)
    }

    func testSameComparesTheVersionAndTheWrapIds() throws {
        let a = try stored(["p": wrap(masterKey, by: "password")])
        XCTAssertTrue(StoredE2ee.same(nil, nil))
        XCTAssertTrue(StoredE2ee.same(a, try stored(["p": wrap(otherMasterKey, by: "password")])))
        XCTAssertFalse(StoredE2ee.same(a, nil))
        XCTAssertFalse(StoredE2ee.same(nil, a))
        XCTAssertFalse(StoredE2ee.same(a, try stored(keyVersion: 2, ["p": wrap(masterKey, by: "password")])))
        XCTAssertFalse(StoredE2ee.same(a, try stored(["q": wrap(masterKey, by: "password")])))
    }

    // MARK: - resolve

    func testNoKeysNeedsNewKeys() {
        guard case .needsNewKeys = AccountKeyService.resolve(uid: uid, masterKey: masterKey, stored: nil) else {
            return XCTFail("expected needsNewKeys")
        }
    }

    /// The legacy account whose migration wrote the keys and stopped before the password
    /// change: its wrap opens, and the sign-in replaces the recovery wrap at the same version.
    func testLegacyAccountWhoseWrapOpensGetsANewRecoveryWrapAtTheSameVersion() throws {
        let keys = try stored(keyVersion: 2, ["p": wrap(masterKey, by: "password"), "r": wrap(recoveryWrappingKey, by: "recovery")])
        guard case let .opened(opened, keyVersion) = AccountKeyService.resolve(uid: uid, masterKey: masterKey, stored: keys) else {
            return XCTFail("expected opened")
        }
        XCTAssertEqual(opened, accountKey)
        XCTAssertEqual(keyVersion, 2)

        let newRecovery = try wrap(E2eeCrypto.randomBytes(32), by: "recovery")
        let after = try read(AccountKeyService.replacedRecoveryMap(stored: keys, keyVersion: keyVersion, wrapId: "r2", wrap: newRecovery))
        XCTAssertEqual(after.keyVersion, 2)
        XCTAssertEqual(Set(after.wraps.keys), ["p", "r2"])
    }

    func testNoPasswordWrapOpensAndARecoveryWrapAsksForTheRecoveryKey() throws {
        let keys = try stored(["p": wrap(otherMasterKey, by: "password"), "r": wrap(recoveryWrappingKey, by: "recovery")])
        guard case let .needsRecovery(found) = AccountKeyService.resolve(uid: uid, masterKey: masterKey, stored: keys) else {
            return XCTFail("expected needsRecovery")
        }
        XCTAssertTrue(StoredE2ee.same(found, keys))
    }

    func testNoPasswordWrapOpensAndNoRecoveryWrapNeedsNewKeys() throws {
        let keys = try stored(["p": wrap(otherMasterKey, by: "password")])
        guard case .needsNewKeys = AccountKeyService.resolve(uid: uid, masterKey: masterKey, stored: keys) else {
            return XCTFail("expected needsNewKeys")
        }
    }

    // MARK: - New keys

    func testNewKeysForAnAccountWithNoneStartAtVersionOne() throws {
        let wraps = ["p": try wrap(masterKey, by: "password"), "r": try wrap(recoveryWrappingKey, by: "recovery")]
        let after = try read(AccountKeyService.newKeysMap(stored: nil, decidedFrom: nil, wraps: wraps))
        XCTAssertEqual(after.keyVersion, 1)
        XCTAssertEqual(Set(after.wraps.keys), ["p", "r"])
    }

    func testNewKeysReplaceEveryWrapOneVersionUpAndKeepOtherFields() throws {
        let before = try stored(keyVersion: 3, [
            "p": wrap(otherMasterKey, by: "password"), "r": wrap(recoveryWrappingKey, by: "recovery"),
        ], extra: ["migratedAt": 1234])
        let wraps = ["p2": try wrap(masterKey, by: "password"), "r2": try wrap(recoveryWrappingKey, by: "recovery")]
        let map = try AccountKeyService.newKeysMap(stored: before, decidedFrom: before, wraps: wraps)
        XCTAssertEqual(map["migratedAt"] as? Int, 1234)
        let after = try read(map)
        XCTAssertEqual(after.keyVersion, 4)
        XCTAssertEqual(Set(after.wraps.keys), ["p2", "r2"])
    }

    /// Two devices migrating the same legacy account: the second finds the first's keys
    /// where it decided from none, and must not write over them.
    func testNewKeysRefuseKeysWrittenSinceTheDecision() throws {
        let wraps = ["p": try wrap(masterKey, by: "password")]
        let firstDevice = try stored(["a": wrap(masterKey, by: "password"), "b": wrap(recoveryWrappingKey, by: "recovery")])
        assertKeysChanged { try AccountKeyService.newKeysMap(stored: firstDevice, decidedFrom: nil, wraps: wraps) }

        let shown = try stored(["a": wrap(otherMasterKey, by: "password"), "b": wrap(recoveryWrappingKey, by: "recovery")])
        let reset = try stored(keyVersion: 2, ["c": wrap(otherMasterKey, by: "password"), "d": wrap(recoveryWrappingKey, by: "recovery")])
        assertKeysChanged { try AccountKeyService.newKeysMap(stored: reset, decidedFrom: shown, wraps: wraps) }
    }

    // MARK: - Recovery

    func testReplacingTheRecoveryKeyRefusesAnotherVersion() throws {
        let keys = try stored(keyVersion: 2, ["p": wrap(masterKey, by: "password")])
        assertKeysChanged {
            try AccountKeyService.replacedRecoveryMap(stored: keys, keyVersion: 1, wrapId: "r", wrap: self.wrap(self.recoveryWrappingKey, by: "recovery"))
        }
        assertKeysChanged {
            try AccountKeyService.replacedRecoveryMap(stored: nil, keyVersion: 1, wrapId: "r", wrap: self.wrap(self.recoveryWrappingKey, by: "recovery"))
        }
    }

    func testRewrapKeepsTheOpenedRecoveryWrapAndStaysWithinFour() throws {
        let keys = try stored(keyVersion: 5, [
            "p": wrap(otherMasterKey, by: "password"),
            "r1": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
            "r2": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
            "r3": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
        ])
        // r3 sorts last, so it is kept only because it is the one that opened.
        let after = try read(AccountKeyService.rewrappedMap(
            current: keys, keyVersion: 5, openedId: "r3", passwordWrapId: "new", passwordWrap: wrap(masterKey, by: "password")
        ))
        XCTAssertLessThanOrEqual(after.wraps.count, AccountKeyService.maxWraps)
        XCTAssertEqual(after.keyVersion, 5)
        XCTAssertNotNil(after.wraps["r3"])
        XCTAssertNotNil(after.wraps["new"])
        XCTAssertNil(after.wraps["p"])
        XCTAssertEqual(after.wraps(by: "recovery").count, 3)

        assertKeysChanged {
            try AccountKeyService.rewrappedMap(current: keys, keyVersion: 4, openedId: "r3", passwordWrapId: "new", passwordWrap: self.wrap(self.masterKey, by: "password"))
        }
    }

    // MARK: - Password change

    private func addPasswordWrap(_ keys: StoredE2ee?, deviceKey: Data? = nil, keyVersion: Int = 1) throws -> (e2ee: [String: Any], currentIds: Set<String>) {
        try AccountKeyService.addedPasswordWrapMap(
            stored: keys, uid: uid, deviceKey: deviceKey ?? accountKey, keyVersion: keyVersion,
            currentMasterKey: masterKey, newWrapId: "new", newWrap: wrap(otherMasterKey, by: "password")
        )
    }

    /// What a recovery can leave: one password wrap and three recovery wraps. The change
    /// has to fit the new wrap beside the current one in four.
    func testPasswordChangeAfterARecoveryStaysWithinFourWraps() throws {
        let keys = try stored([
            "p": wrap(masterKey, by: "password"),
            "r1": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
            "r2": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
            "r3": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
        ])
        let added = try addPasswordWrap(keys)
        let after = try read(added.e2ee)
        XCTAssertLessThanOrEqual(after.wraps.count, AccountKeyService.maxWraps)
        XCTAssertNotNil(after.wraps["p"], "the current password's wrap stays until Firebase has the new one")
        XCTAssertNotNil(after.wraps["new"])
        XCTAssertEqual(after.wraps(by: "recovery").count, 2)
        XCTAssertEqual(added.currentIds, ["p"])

        // Then the old wrap goes, and the next change fits without dropping anything.
        let removed = try read(AccountKeyService.removedWrapsMap(stored: after, ids: Array(added.currentIds)))
        XCTAssertEqual(Set(removed.wraps.keys), ["new", "r1", "r2"])
    }

    func testPasswordChangeDropsAWrapNothingOpensBeforeARecoveryWrap() throws {
        let keys = try stored([
            "p": wrap(masterKey, by: "password"),
            "stale": wrap(E2eeCrypto.randomBytes(32), by: "password"),
            "r1": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
            "r2": wrap(E2eeCrypto.randomBytes(32), by: "recovery"),
        ])
        let after = try read(addPasswordWrap(keys).e2ee)
        XCTAssertEqual(Set(after.wraps.keys), ["p", "new", "r1", "r2"])
    }

    func testPasswordChangeWithRoomKeepsEveryWrap() throws {
        let keys = try stored(["p": wrap(masterKey, by: "password"), "r": wrap(recoveryWrappingKey, by: "recovery")])
        let after = try read(addPasswordWrap(keys).e2ee)
        XCTAssertEqual(Set(after.wraps.keys), ["p", "new", "r"])
    }

    func testPasswordChangeRefusesAStaleDeviceKey() throws {
        let keys = try stored(["p": wrap(masterKey, by: "password")])
        assertKeysChanged { try self.addPasswordWrap(keys, deviceKey: E2eeCrypto.newAccountKey()) }
        assertKeysChanged { try self.addPasswordWrap(keys, keyVersion: 2) }
        assertKeysChanged { try self.addPasswordWrap(nil) }
    }
}
