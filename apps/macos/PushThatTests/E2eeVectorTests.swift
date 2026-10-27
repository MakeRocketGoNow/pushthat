import XCTest

/// Checks `E2eeCrypto` against vectors 1 and 2 of `packages/push-test/vectors.json`
/// (docs/e2ee.md, "Test vectors"), byte for byte. The file is copied into the test bundle
/// from the repository rather than duplicated here, so a regenerated vector reaches this
/// test without anyone copying it across.
///
/// The bundle compiles `E2eeCrypto.swift` itself instead of being hosted by the app: the
/// constructions need nothing from the app, and a hosted test would launch it and
/// configure Firebase to check a hash.
final class E2eeVectorTests: XCTestCase {
    private var vectors: [String: Any] = [:]

    override func setUpWithError() throws {
        let url = try XCTUnwrap(
            Bundle(for: E2eeVectorTests.self).url(forResource: "vectors", withExtension: "json"),
            "vectors.json is not in the test bundle"
        )
        vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func section(_ name: String) throws -> [String: Any] {
        try XCTUnwrap(vectors[name] as? [String: Any], "no \(name) section")
    }

    private func string(_ map: [String: Any], _ key: String) throws -> String {
        try XCTUnwrap(map[key] as? String, "no \(key)")
    }

    private func bytes(_ map: [String: Any], _ key: String) throws -> Data {
        try fromHex(string(map, key))
    }

    private func fromHex(_ hex: String) throws -> Data {
        var out = Data()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2)
            out.append(try XCTUnwrap(UInt8(hex[index..<next], radix: 16), "not hex: \(hex)"))
            index = next
        }
        return out
    }

    // MARK: - Vector 1: keys from the password and the email

    func testKeysVector() throws {
        let keys = try section("keys")
        let email = try string(keys, "email")
        let password = try string(keys, "password")

        XCTAssertEqual(vectors["kdf"] as? String, E2eeCrypto.kdf)
        XCTAssertEqual(keys["iterations"] as? Int, Int(E2eeCrypto.pbkdf2Iterations))
        XCTAssertEqual(E2eeCrypto.normalizeEmail(email), try string(keys, "normalizedEmail"))
        XCTAssertEqual(E2eeCrypto.passwordBytes(password), try bytes(keys, "passwordNfcUtf8"))

        let derived = try E2eeCrypto.deriveKeys(email: email, password: password)
        XCTAssertEqual(derived.salt, try bytes(keys, "salt"))
        XCTAssertEqual(derived.stretched, try bytes(keys, "stretched"))
        XCTAssertEqual(derived.authKey, try bytes(keys, "authKey"))
        XCTAssertEqual(derived.masterKey, try bytes(keys, "masterKey"))
        XCTAssertEqual(derived.firebasePassword, try string(keys, "firebasePassword"))
        XCTAssertEqual(derived.firebasePassword.count, 43)
    }

    /// Not a vector, but the rule the vector's email cannot show on its own: only ASCII
    /// letters are lowercased and only space, tab, CR and LF are trimmed.
    func testEmailNormalizationIsAsciiOnly() {
        XCTAssertEqual(E2eeCrypto.normalizeEmail("\t\r\n ÉMILE@Example.COM \r\n"), "Émile@example.com")
        XCTAssertEqual(E2eeCrypto.normalizeEmail("\u{00A0}a@example.com\u{00A0}"), "\u{00A0}a@example.com\u{00A0}")
        XCTAssertEqual(E2eeCrypto.normalizeEmail("E\u{0301}@example.com"), "\u{00C9}@example.com")
    }

    // MARK: - Vector 2: the account key, its wraps and the recovery key

    func testAccountVector() throws {
        let keys = try section("keys")
        let account = try section("account")
        let uid = try string(account, "uid")
        let accountKey = try bytes(account, "accountKey")
        let masterKey = try bytes(keys, "masterKey")

        let subkeys = E2eeCrypto.accountSubkeys(accountKey)
        XCTAssertEqual(subkeys.metaKey, try bytes(account, "metaKey"))
        XCTAssertEqual(subkeys.searchKey, try bytes(account, "searchKey"))
        XCTAssertEqual(E2eeCrypto.wrapAad(uid: uid), try bytes(account, "wrapAad"))

        let expected = try XCTUnwrap(account["passwordWrap"] as? [String: Any])
        let wrap = try E2eeCrypto.wrapAccountKey(
            wrappingKey: masterKey, accountKey: accountKey, uid: uid, by: "password", nonce: bytes(expected, "nonce")
        )
        XCTAssertEqual(wrap.by, try string(expected, "by"))
        XCTAssertEqual(wrap.n, try string(expected, "n"))
        XCTAssertEqual(wrap.ct, try string(expected, "ct"))
        XCTAssertEqual(try E2eeCrypto.unwrapAccountKey(wrappingKey: masterKey, wrap: wrap, uid: uid), accountKey)

        // The rules' shape: a 12-byte nonce is 16 characters, 48 bytes of ct||tag are 64.
        XCTAssertEqual(wrap.n.count, 16)
        XCTAssertEqual(wrap.ct.count, 64)
    }

    func testRecoveryVector() throws {
        let account = try section("account")
        let uid = try string(account, "uid")
        let accountKey = try bytes(account, "accountKey")
        let recovery = try XCTUnwrap(account["recovery"] as? [String: Any])
        let recoveryBytes = try bytes(recovery, "bytes")
        let display = try string(recovery, "display")

        XCTAssertEqual(try E2eeCrypto.encodeRecoveryKey(recoveryBytes), display)
        XCTAssertEqual(try E2eeCrypto.decodeRecoveryKey(display), recoveryBytes)

        let wrappingKey = try E2eeCrypto.recoveryWrappingKey(recoveryBytes)
        XCTAssertEqual(wrappingKey, try bytes(recovery, "wrappingKey"))

        let expected = try XCTUnwrap(recovery["wrap"] as? [String: Any])
        let wrap = try E2eeCrypto.wrapAccountKey(
            wrappingKey: wrappingKey, accountKey: accountKey, uid: uid, by: "recovery", nonce: bytes(expected, "nonce")
        )
        XCTAssertEqual(wrap.by, try string(expected, "by"))
        XCTAssertEqual(wrap.n, try string(expected, "n"))
        XCTAssertEqual(wrap.ct, try string(expected, "ct"))

        let stored = E2eeCrypto.Wrap(by: try string(expected, "by"), n: try string(expected, "n"), ct: try string(expected, "ct"))
        XCTAssertEqual(try E2eeCrypto.unwrapAccountKey(wrappingKey: wrappingKey, wrap: stored, uid: uid), accountKey)
    }

    /// Reading a key back forgives what a person copying it by hand gets wrong.
    func testRecoveryKeyDecodingIsLenient() throws {
        let recovery = try XCTUnwrap(try section("account")["recovery"] as? [String: Any])
        let recoveryBytes = try bytes(recovery, "bytes")
        let display = try string(recovery, "display")

        let typed = [
            display.lowercased(),
            display.replacingOccurrences(of: "-", with: " "),
            display.replacingOccurrences(of: "-", with: ""),
            display.replacingOccurrences(of: "1", with: "I").replacingOccurrences(of: "0", with: "O"),
            display.replacingOccurrences(of: "1", with: "l").replacingOccurrences(of: "0", with: "o"),
            " " + display.replacingOccurrences(of: "-", with: " - ") + " ",
        ]
        for text in typed {
            XCTAssertEqual(try E2eeCrypto.decodeRecoveryKey(text), recoveryBytes, text)
        }

        XCTAssertThrowsError(try E2eeCrypto.decodeRecoveryKey(String(display.dropLast())), "a symbol short")
        XCTAssertThrowsError(try E2eeCrypto.decodeRecoveryKey(display + "0"), "a symbol over")
        XCTAssertThrowsError(try E2eeCrypto.decodeRecoveryKey("U" + display.dropFirst()), "U is not in the alphabet")
    }

    /// The AAD binds a wrap to its account: the same wrap under another uid does not open.
    func testWrapOpenedUnderAnotherUidFails() throws {
        let keys = try section("keys")
        let account = try section("account")
        let masterKey = try bytes(keys, "masterKey")
        let expected = try XCTUnwrap(account["passwordWrap"] as? [String: Any])
        let wrap = E2eeCrypto.Wrap(by: "password", n: try string(expected, "n"), ct: try string(expected, "ct"))

        XCTAssertNoThrow(try E2eeCrypto.unwrapAccountKey(wrappingKey: masterKey, wrap: wrap, uid: try string(account, "uid")))
        XCTAssertThrowsError(try E2eeCrypto.unwrapAccountKey(wrappingKey: masterKey, wrap: wrap, uid: "vector-uid-0002"))
        XCTAssertThrowsError(try E2eeCrypto.unwrapAccountKey(wrappingKey: Data(count: 32), wrap: wrap, uid: try string(account, "uid")))
    }

    func testRandomIdsHaveTheirLengths() {
        XCTAssertEqual(E2eeCrypto.newWrapId().count, 11)
        XCTAssertEqual(E2eeCrypto.newDeviceId().count, 22)
        XCTAssertNotEqual(E2eeCrypto.newAccountKey(), E2eeCrypto.newAccountKey())
    }
}
