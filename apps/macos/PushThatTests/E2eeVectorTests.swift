import XCTest

/// Checks `E2eeCrypto` and `SearchTokenGenerator` against vectors 1 to 6 of
/// `packages/push-test/vectors.json` (docs/e2ee.md, "Test vectors"), byte for byte. The file is copied into the test bundle
/// from the repository rather than duplicated here, so a regenerated vector reaches this
/// test without anyone copying it across.
///
/// The bundle compiles the files it tests itself instead of being hosted by the app: the
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

    // MARK: - Vector 3: the push envelope

    func testPushVector() throws {
        let account = try section("account")
        let push = try section("push")
        let metaKey = try bytes(account, "metaKey")
        let userId = try string(push, "userId")
        let pushId = try string(push, "pushId")
        let plaintext = try bytes(push, "plaintextUtf8")
        let expected = try XCTUnwrap(push["enc"] as? [String: Any])

        XCTAssertEqual(E2eeCrypto.pushAad(userId: userId, pushId: pushId), try bytes(push, "aad"))
        let enc = try E2eeCrypto.sealPush(metaKey: metaKey, userId: userId, pushId: pushId, plaintext: plaintext, nonce: bytes(push, "nonce"))
        XCTAssertEqual(enc.v, expected["v"] as? Int)
        XCTAssertEqual(enc.n, try string(expected, "n"))
        XCTAssertEqual(enc.ct, try string(expected, "ct"))

        let stored = try XCTUnwrap(E2eeCrypto.Envelope(firestore: expected))
        XCTAssertEqual(try E2eeCrypto.openPush(metaKey: metaKey, userId: userId, pushId: pushId, enc: stored), plaintext)
        // The AAD binds the envelope to its document: moved to another, it does not open.
        XCTAssertThrowsError(try E2eeCrypto.openPush(metaKey: metaKey, userId: userId, pushId: "vector-push-0002", enc: stored))
        XCTAssertThrowsError(try E2eeCrypto.openPush(metaKey: metaKey, userId: "vector-uid-0002", pushId: pushId, enc: stored))
        XCTAssertThrowsError(try E2eeCrypto.openPush(metaKey: metaKey, userId: userId, pushId: pushId, enc: .init(v: 2, n: stored.n, ct: stored.ct)))

        // The vector's plaintext parses as the URL push it is.
        XCTAssertEqual(
            try PushContent(json: plaintext, type: "url"),
            .url(url: "https://example.com/docs/report?v=2#summary", title: "Example report", ext: "html")
        )
    }

    /// The REST API gives `v` as a string, the SDK as a number; both read.
    func testEnvelopeReadsEitherForm() {
        XCTAssertEqual(E2eeCrypto.Envelope(firestore: ["v": 1, "n": "a", "ct": "b"]), .init(v: 1, n: "a", ct: "b"))
        XCTAssertEqual(E2eeCrypto.Envelope(firestore: ["v": "1", "n": "a", "ct": "b"]), .init(v: 1, n: "a", ct: "b"))
        XCTAssertNil(E2eeCrypto.Envelope(firestore: ["v": 1, "n": "a"]))
        XCTAssertNil(E2eeCrypto.Envelope(firestore: "not a map"))
    }

    // MARK: - Push content

    private func vectorKeys(keyVersion: Int = 1) throws -> PushKeys {
        let account = try section("account")
        return PushKeys(uid: try string(account, "uid"), keyVersion: keyVersion, accountKey: try bytes(account, "accountKey"), deviceId: "vector-device")
    }

    func testPushContentRoundTrips() throws {
        let keys = try vectorKeys()
        let contents: [PushContent] = [
            .url(url: "https://example.com/a", title: "", ext: ""),
            .url(url: "https://example.com/b.pdf", title: "Example \u{e9}", ext: "pdf"),
            .file(PushFile(name: "Report (final) v2.pdf", mime: "application/pdf", size: 3_145_729, ext: "pdf",
                           fk: E2eeCrypto.newFileKey(), np: E2eeCrypto.newFilePrefix())),
            .file(PushFile(name: "old.txt", mime: "", size: 0, ext: "txt", fk: nil, np: nil)),
        ]
        for content in contents {
            let push = try PreparedPush(content: content, keys: keys, pushId: "push-1", objectPath: content.type == "file" ? "uploads/\(keys.uid)/x" : nil)
            XCTAssertEqual(push.keyVersion, 1)
            XCTAssertEqual(push.deviceId, "vector-device")
            XCTAssertEqual(push.enc.n.count, 16, "a 12-byte nonce is 16 characters, as the rules check")
            XCTAssertEqual(push.searchTokens, E2eeCrypto.blindIndex(searchKey: keys.searchKey, tokens: SearchTokenGenerator.generate(from: content.searchText)))
            XCTAssertEqual(PushContent.open(keys: keys, userId: keys.uid, pushId: "push-1", type: content.type, keyVersion: 1, enc: push.enc), content)
            // Another key version, another document or another account: locked.
            XCTAssertNil(PushContent.open(keys: keys, userId: keys.uid, pushId: "push-1", type: content.type, keyVersion: 2, enc: push.enc))
            XCTAssertNil(PushContent.open(keys: keys, userId: keys.uid, pushId: "push-2", type: content.type, keyVersion: 1, enc: push.enc))
            XCTAssertNil(PushContent.open(keys: keys, userId: "vector-uid-0002", pushId: "push-1", type: content.type, keyVersion: 1, enc: push.enc))
            // A queued push survives the local store byte for byte.
            XCTAssertEqual(try JSONDecoder().decode(PreparedPush.self, from: JSONEncoder().encode(push)), push)
        }
        XCTAssertEqual(PushContent.url(url: "https://example.com", title: "T", ext: "").searchText, "T https://example.com")
    }

    /// A title is cut, and a push over the rules' bound on the ciphertext is refused here.
    func testOversizedPushes() throws {
        let keys = try vectorKeys()
        let long = PushContent.url(url: "https://example.com", title: String(repeating: "t", count: 5000), ext: "")
        let opened = try XCTUnwrap(PushContent.open(keys: keys, userId: keys.uid, pushId: "p", type: "url", keyVersion: 1,
                                                    enc: PreparedPush(content: long, keys: keys, pushId: "p").enc))
        guard case let .url(_, title, _) = opened else { return XCTFail("not a URL push") }
        XCTAssertEqual(title.count, PushContent.maxTitleLength)

        let absurd = PushContent.url(url: "https://example.com/" + String(repeating: "a", count: 13_000), title: "", ext: "")
        XCTAssertThrowsError(try PreparedPush(content: absurd, keys: keys, pushId: "p")) { error in
            XCTAssertEqual(error as? PushContent.ContentError, .tooLarge)
        }
    }

    // MARK: - Vector 4: the blind index

    func testSearchVector() throws {
        let account = try section("account")
        let search = try section("search")
        let searchKey = try bytes(account, "searchKey")
        let tokens = try XCTUnwrap(search["tokens"] as? [String])
        let blind = try XCTUnwrap(search["blind"] as? [String])

        XCTAssertEqual(SearchTokenGenerator.generate(from: try string(search, "text")), tokens)
        XCTAssertEqual(E2eeCrypto.blindIndex(searchKey: searchKey, tokens: tokens), blind)
        for (token, expected) in zip(tokens, blind) {
            XCTAssertEqual(E2eeCrypto.blindToken(searchKey: searchKey, token: token), expected)
        }
    }

    func testTokenizerCases() {
        // NFC: a decomposed and a composed "\u{e9}" are the same tokens, composed.
        XCTAssertEqual(SearchTokenGenerator.generate(from: "Caf\u{65}\u{301}"), SearchTokenGenerator.generate(from: "Caf\u{e9}"))
        XCTAssertEqual(SearchTokenGenerator.generate(from: "Caf\u{e9}"), ["c", "ca", "caf", "caf\u{e9}"])
        // Punctuation and "_" split; digits stay in their word.
        XCTAssertEqual(SearchTokenGenerator.generate(from: "a_b-c.d"), ["a", "b", "c", "d"])
        XCTAssertEqual(SearchTokenGenerator.generate(from: "v2 2024"), ["v", "v2", "2", "20", "202", "2024"])
        // Another script is kept as it is.
        XCTAssertEqual(SearchTokenGenerator.generate(from: "\u{65e5}\u{672c}"), ["\u{65e5}", "\u{65e5}\u{672c}"])
        XCTAssertEqual(SearchTokenGenerator.generate(from: "\u{41f}\u{440}\u{438}"), ["\u{43f}", "\u{43f}\u{440}", "\u{43f}\u{440}\u{438}"])
        // Prefixes count code points, not grapheme clusters: a mark NFC cannot compose is
        // its own step, and a character outside the BMP is one.
        XCTAssertEqual(SearchTokenGenerator.generate(from: "q\u{301}"), ["q", "q\u{301}"])
        XCTAssertEqual(SearchTokenGenerator.generate(from: "\u{20000}x"), ["\u{20000}", "\u{20000}x"])
        // First-seen order, each token once.
        XCTAssertEqual(SearchTokenGenerator.generate(from: "ab a abc"), ["a", "ab", "abc"])
        XCTAssertEqual(SearchTokenGenerator.generate(from: " !! "), [])
        // A word-final capital sigma lowers to the final form, as JavaScript and Kotlin
        // lower it, and not as Swift's lowercased() does.
        XCTAssertEqual(SearchTokenGenerator.generate(from: "\u{39f}\u{394}\u{39f}\u{3a3}").last, "\u{3bf}\u{3b4}\u{3bf}\u{3c2}")
        XCTAssertEqual(SearchTokenGenerator.generate(from: "\u{3a3}\u{391}").last, "\u{3c3}\u{3b1}")
    }

    /// The reference's cut at the rules' bound keeps the first 3000 tokens.
    func testTokenizerStopsAtTheRulesBound() {
        let tokens = SearchTokenGenerator.generate(from: String(repeating: "a", count: 3001) + " b")
        XCTAssertEqual(tokens.count, SearchTokenGenerator.maxTokens)
        XCTAssertEqual(tokens.first, "a")
        XCTAssertEqual(tokens.last, String(repeating: "a", count: 3000))
    }

    func testSearchLooksUpTheFirstWord() throws {
        let keys = try vectorKeys()
        XCTAssertEqual(SearchTokenGenerator.searchWord("GitHub repo"), "github")
        XCTAssertEqual(SearchTokenGenerator.searchWord("  ...Caf\u{65}\u{301}!"), "caf\u{e9}")
        XCTAssertNil(SearchTokenGenerator.searchWord(""))
        XCTAssertNil(SearchTokenGenerator.searchWord(" ?! "))
        let blind = try XCTUnwrap(try section("search")["blind"] as? [String])
        XCTAssertEqual(keys.searchToken(for: "GitHub repo"), blind[5], "the blind token of \"github\"")
        XCTAssertNil(keys.searchToken(for: "--"))
    }

    // MARK: - Vectors 5 and 6: files

    private var temporary: URL!

    override func tearDownWithError() throws {
        if let temporary { try? FileManager.default.removeItem(at: temporary) }
    }

    private func temporaryFile(_ name: String) throws -> URL {
        if temporary == nil {
            temporary = FileManager.default.temporaryDirectory.appendingPathComponent("E2eeVectorTests-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        }
        return temporary.appendingPathComponent(name)
    }

    private func patternFile(length: Int) throws -> URL {
        let url = try temporaryFile("plain-\(length)")
        var bytes = [UInt8](repeating: 0, count: length)
        for i in 0..<length { bytes[i] = UInt8(i % 251) }
        try Data(bytes).write(to: url)
        return url
    }

    func testFileVector() throws {
        let file = try section("file")
        let fk = try bytes(file, "fk")
        let np = try bytes(file, "np")
        let length = try XCTUnwrap(file["length"] as? Int)
        XCTAssertEqual(E2eeCrypto.base64(fk), try string(file, "fkBase64"))
        XCTAssertEqual(E2eeCrypto.base64(np), try string(file, "npBase64"))
        XCTAssertEqual(try E2eeCrypto.fileHeader(prefix: np), try bytes(file, "header"))

        let plain = try patternFile(length: length)
        let sealed = try temporaryFile("sealed")
        try E2eeCrypto.encryptFile(fk: fk, prefix: np, source: plain, destination: sealed)
        let encrypted = try Data(contentsOf: sealed)
        XCTAssertEqual(encrypted.count, file["encryptedLength"] as? Int)
        XCTAssertEqual(E2eeCrypto.hex(E2eeCrypto.sha256(encrypted)), try string(file, "encryptedSha256"))

        // The same bytes from memory, as a picked photo is sealed.
        let fromData = try temporaryFile("sealed-from-data")
        try E2eeCrypto.encryptFile(fk: fk, prefix: np, data: Data(contentsOf: plain), destination: fromData)
        XCTAssertEqual(try Data(contentsOf: fromData), encrypted)

        let opened = try temporaryFile("opened")
        try E2eeCrypto.decryptFile(fk: fk, np: np, source: sealed, destination: opened)
        XCTAssertEqual(E2eeCrypto.hex(E2eeCrypto.sha256(try Data(contentsOf: opened))), try string(file, "plaintextSha256"))

        // A byte changed inside chunk 1's ciphertext.
        var tampered = encrypted
        let offset = try XCTUnwrap(file["tamperOffset"] as? Int)
        tampered[offset] ^= 0x01
        XCTAssertEqual(E2eeCrypto.hex(E2eeCrypto.sha256(tampered)), try string(file, "tamperedSha256"))
        try assertDoesNotDecrypt(tampered, fk: fk, np: np, "tampered")

        // Sealed chunks 0 and 1 swapped.
        let sealedSize = E2eeCrypto.chunkSize + E2eeCrypto.tagLength
        let header = E2eeCrypto.fileHeaderLength
        let reordered = encrypted.prefix(header)
            + encrypted.subdata(in: header + sealedSize..<header + 2 * sealedSize)
            + encrypted.subdata(in: header..<header + sealedSize)
            + encrypted.suffix(from: header + 2 * sealedSize)
        XCTAssertEqual(E2eeCrypto.hex(E2eeCrypto.sha256(reordered)), try string(file, "reorderedSha256"))
        try assertDoesNotDecrypt(reordered, fk: fk, np: np, "reordered")

        // The wrong envelope: another prefix, or another key.
        try assertDoesNotDecrypt(encrypted, fk: fk, np: Data(repeating: 0, count: 8), "wrong np")
        try assertDoesNotDecrypt(encrypted, fk: Data(repeating: 0, count: 32), np: np, "wrong fk")
        // Cut at a chunk boundary, the last chunk is a full one not marked final.
        try assertDoesNotDecrypt(encrypted.prefix(header + 3 * sealedSize), fk: fk, np: np, "truncated")
    }

    /// A file of exactly 2 MiB is two full chunks, the second sealed as final: the
    /// encryptor holds one chunk back so that it never writes an empty final chunk.
    func testWholeChunkFileEndsOnAFullFinalChunk() throws {
        let fk = E2eeCrypto.newFileKey()
        let np = E2eeCrypto.newFilePrefix()
        let plain = try patternFile(length: 2 * E2eeCrypto.chunkSize)
        let sealed = try temporaryFile("sealed")
        try E2eeCrypto.encryptFile(fk: fk, prefix: np, source: plain, destination: sealed)
        let size = try XCTUnwrap(try sealed.resourceValues(forKeys: [.fileSizeKey]).fileSize)
        XCTAssertEqual(size, E2eeCrypto.fileHeaderLength + 2 * (E2eeCrypto.chunkSize + E2eeCrypto.tagLength))
        let opened = try temporaryFile("opened")
        try E2eeCrypto.decryptFile(fk: fk, np: np, source: sealed, destination: opened)
        XCTAssertEqual(try Data(contentsOf: opened), try Data(contentsOf: plain))
    }

    /// The size checked against the tier's limit is the one the Storage rules measure: the
    /// vectors' encrypted lengths, without encrypting anything.
    func testEncryptedFileSizeIsTheSizeOfTheObject() throws {
        let file = try section("file")
        let empty = try section("emptyFile")
        XCTAssertEqual(E2eeCrypto.encryptedFileSize(Int64(try XCTUnwrap(file["length"] as? Int))), Int64(try XCTUnwrap(file["encryptedLength"] as? Int)))
        XCTAssertEqual(E2eeCrypto.encryptedFileSize(0), Int64(try string(empty, "encrypted").count / 2))
        XCTAssertEqual(E2eeCrypto.encryptedFileSize(Int64(E2eeCrypto.chunkSize)), Int64(12 + E2eeCrypto.chunkSize + 16))
    }

    func testEmptyFileVector() throws {
        let empty = try section("emptyFile")
        let fk = try bytes(empty, "fk")
        let np = try bytes(empty, "np")
        let plain = try temporaryFile("empty")
        try Data().write(to: plain)
        let sealed = try temporaryFile("sealed")
        try E2eeCrypto.encryptFile(fk: fk, prefix: np, source: plain, destination: sealed)
        let encrypted = try Data(contentsOf: sealed)
        XCTAssertEqual(encrypted, try bytes(empty, "encrypted"))
        XCTAssertEqual(encrypted.count, 28)
        XCTAssertEqual(E2eeCrypto.hex(E2eeCrypto.sha256(encrypted)), try string(empty, "encryptedSha256"))

        let opened = try temporaryFile("opened")
        try E2eeCrypto.decryptFile(fk: fk, np: np, source: sealed, destination: opened)
        XCTAssertEqual(try Data(contentsOf: opened), Data())
    }

    func testChunkLayoutEdgeCases() throws {
        let header = Int64(E2eeCrypto.fileHeaderLength)
        let tag = Int64(E2eeCrypto.tagLength)
        let sealedSize = Int64(E2eeCrypto.chunkSize) + tag

        XCTAssertEqual(try E2eeCrypto.chunkLayout(length: header + tag), [.init(index: 0, start: header, end: header + tag, final: true)])
        XCTAssertEqual(try E2eeCrypto.chunkLayout(length: header + sealedSize).count, 1)
        XCTAssertEqual(try E2eeCrypto.chunkLayout(length: header + sealedSize + tag + 1).map(\.final), [false, true])
        // An empty final chunk after a full one is the second encoding every client refuses.
        XCTAssertThrowsError(try E2eeCrypto.chunkLayout(length: header + sealedSize + tag))
        // A last chunk shorter than its tag, or no chunk at all.
        XCTAssertThrowsError(try E2eeCrypto.chunkLayout(length: header + sealedSize + tag - 1))
        XCTAssertThrowsError(try E2eeCrypto.chunkLayout(length: header + tag - 1))
        XCTAssertThrowsError(try E2eeCrypto.chunkLayout(length: header))

        // The sealer refuses what the layout refuses.
        let fk = E2eeCrypto.newFileKey()
        let np = E2eeCrypto.newFilePrefix()
        XCTAssertThrowsError(try E2eeCrypto.sealChunk(fk: fk, prefix: np, index: 1, chunk: Data(), final: true))
        XCTAssertThrowsError(try E2eeCrypto.sealChunk(fk: fk, prefix: np, index: 0, chunk: Data(count: 10), final: false))
    }

    /// Fails to decrypt, and leaves no output behind.
    private func assertDoesNotDecrypt(_ encrypted: Data, fk: Data, np: Data, _ message: String) throws {
        let source = try temporaryFile("bad-\(UUID().uuidString)")
        try encrypted.write(to: source)
        let output = try temporaryFile("bad-out-\(UUID().uuidString)")
        XCTAssertThrowsError(try E2eeCrypto.decryptFile(fk: fk, np: np, source: source, destination: output), message)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path), "\(message): partial output left behind")
    }

    /// The envelope of a file push, and of one migrated from plaintext.
    func testFileContentJson() throws {
        let fk = Data(repeating: 1, count: 32)
        let np = Data(repeating: 2, count: 8)
        let json = try PushContent.file(PushFile(name: "a.pdf", mime: "application/pdf", size: 5, ext: "pdf", fk: fk, np: np)).json()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        XCTAssertEqual(object["fk"] as? String, E2eeCrypto.base64(fk))
        XCTAssertEqual(object["np"] as? String, E2eeCrypto.base64(np))
        XCTAssertEqual(object["size"] as? Int, 5)
        XCTAssertNil(object["legacyPlain"])

        let legacy = Data(#"{"name":"old.txt","mime":"","size":0,"ext":"txt","legacyPlain":true}"#.utf8)
        guard case let .file(file) = try PushContent(json: legacy, type: "file") else { return XCTFail("not a file push") }
        XCTAssertTrue(file.legacyPlain)
        XCTAssertEqual(file.name, "old.txt")
        XCTAssertThrowsError(try PushContent(json: Data(#"{"name":"a","fk":"AA=="}"#.utf8), type: "file"))
        XCTAssertEqual(PushFile.ext(of: "Report (final) v2.PDF"), "pdf")
        XCTAssertEqual(PushFile.ext(of: "README"), "")
    }
}
