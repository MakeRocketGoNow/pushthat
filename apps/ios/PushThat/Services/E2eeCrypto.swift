import Foundation
import CryptoKit
import CommonCrypto
import Security

/// The key constructions of docs/e2ee.md ("Keys" and "The recovery key"), checked byte for
/// byte against `packages/push-test/vectors.json` by `PushThatTests`. The reference is
/// `packages/push-test/e2ee.mjs`; a change here that changes a byte is a change to the
/// specification and belongs in the document first.
///
/// This file is the same in `apps/ios` and `apps/macos` (a copy each, as the apps are
/// forks) and uses nothing but Foundation, CryptoKit, CommonCrypto and Security, so the
/// test bundle compiles it on its own without the app or Firebase. The notification
/// service extension and the share extension compile it too, for the same reason.
enum E2eeCrypto {
    static let kdf = "pbkdf2-sha256-600000"
    static let pbkdf2Iterations: UInt32 = 600_000
    static let nonceLength = 12
    static let tagLength = 16
    static let accountKeyLength = 32
    static let recoveryKeyLength = 20

    enum CryptoError: Error {
        case derivationFailed
        case notBase64
        case badLength
        case notARecoveryKey
        case unknownWrap
        case unknownEnvelope
        case notAFile
        case prefixMismatch
    }

    struct DerivedKeys {
        let salt: Data
        let stretched: Data
        /// What Firebase Auth sees, as `firebasePassword`; never the password itself.
        let authKey: Data
        /// Wraps the account key; never leaves the device and is dropped once the key is open.
        let masterKey: Data
        let firebasePassword: String
    }

    struct AccountSubkeys {
        let metaKey: Data
        let searchKey: Data
    }

    /// One entry of `users/{uid}.e2ee.wraps`: `by` is "password" or "recovery", `n` the
    /// nonce and `ct` the ciphertext with its tag, both base64 with padding.
    struct Wrap: Equatable {
        let by: String
        let n: String
        let ct: String

        static let password = "password"
        static let recovery = "recovery"

        var firestoreData: [String: String] { ["by": by, "n": n, "ct": ct] }

        /// A wrap as Firestore returns it, or nil for anything not shaped like one.
        init?(firestore value: Any?) {
            guard let map = value as? [String: Any],
                  let by = map["by"] as? String,
                  let n = map["n"] as? String,
                  let ct = map["ct"] as? String,
                  by == Wrap.password || by == Wrap.recovery
            else { return nil }
            self.init(by: by, n: n, ct: ct)
        }

        init(by: String, n: String, ct: String) {
            self.by = by
            self.n = n
            self.ct = ct
        }
    }

    // MARK: - Encodings

    static func utf8(_ s: String) -> Data { Data(s.utf8) }

    /// Standard base64 with padding, as `n` and `ct` carry it in a document.
    static func base64(_ data: Data) -> String { data.base64EncodedString() }

    /// Strict, as the reference is: a field edited by hand fails here and not on a tag.
    /// Foundation's decoder already refuses characters outside the alphabet unless asked
    /// to ignore them; the length check is the reference's.
    static func fromBase64(_ s: String) throws -> Data {
        guard s.count % 4 == 0, let data = Data(base64Encoded: s) else { throw CryptoError.notBase64 }
        return data
    }

    /// Unpadded base64url, for the strings a user or a URL might see: the Firebase
    /// password, wrap ids, the device id.
    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        // SecRandomCopyBytes does not fail on a working system; if it ever did, carrying on
        // with zeros would make every new key the same, so this stops instead.
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        precondition(status == errSecSuccess, "SecRandomCopyBytes failed: \(status)")
        return Data(bytes)
    }

    // MARK: - Primitives

    static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    static func hmacSha256(key: Data, message: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key)))
    }

    /// HKDF-SHA256 with an empty salt and one block of output, written out as the spec
    /// writes it: extract with 32 zero bytes, then expand with `label || 0x01`. CryptoKit's
    /// `HKDF` would give the same bytes, but writing the two HMACs keeps the construction
    /// visible beside the other platforms', which have to write it by hand.
    static func hkdfOneBlock(ikm: Data, label: String) -> Data {
        let prk = hmacSha256(key: Data(count: 32), message: ikm)
        return hmacSha256(key: prk, message: utf8(label) + Data([0x01]))
    }

    static func aesGcmSeal(key: Data, nonce: Data, plaintext: Data, aad: Data) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    /// Throws on a bad tag, a bad AAD or a ciphertext shorter than its tag.
    static func aesGcmOpen(key: Data, nonce: Data, ciphertext: Data, aad: Data) throws -> Data {
        guard nonce.count == nonceLength, ciphertext.count >= tagLength else { throw CryptoError.badLength }
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertext.prefix(ciphertext.count - tagLength),
            tag: ciphertext.suffix(tagLength)
        )
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }

    // MARK: - Keys from the password and the email

    /// NFC, then trim space, tab, CR and LF only, then A-Z to a-z only. Foundation's
    /// `lowercased()` and `trimmingCharacters(in: .whitespacesAndNewlines)` are not used
    /// because they are Unicode-wide: they would lowercase an "É" and trim a no-break space,
    /// and the salt would then differ from every other client's. Done on Unicode scalars,
    /// not Characters, since Swift reads "\r\n" as one Character.
    static func normalizeEmail(_ email: String) -> String {
        let trimmed: Set<UInt32> = [0x20, 0x09, 0x0D, 0x0A]
        var scalars = Array(email.precomposedStringWithCanonicalMapping.unicodeScalars)
        while let first = scalars.first, trimmed.contains(first.value) { scalars.removeFirst() }
        while let last = scalars.last, trimmed.contains(last.value) { scalars.removeLast() }
        var out = String.UnicodeScalarView()
        for scalar in scalars {
            if (0x41...0x5A).contains(scalar.value), let lower = Unicode.Scalar(scalar.value + 0x20) {
                out.append(lower)
            } else {
                out.append(scalar)
            }
        }
        return String(out)
    }

    static func emailSalt(_ email: String) -> Data {
        sha256(utf8("pushthat/salt/v1:" + normalizeEmail(email)))
    }

    /// The password's bytes as the KDF takes them: NFC, UTF-8, not trimmed.
    static func passwordBytes(_ password: String) -> Data {
        utf8(password.precomposedStringWithCanonicalMapping)
    }

    /// PBKDF2-HMAC-SHA256, 600,000 iterations, 32 bytes. CommonCrypto is handed the UTF-8
    /// bytes and their count rather than a C string, so a password is never cut at a NUL
    /// and the bytes it stretches are the ones the vector pins.
    static func stretchPassword(_ password: String, salt: Data) throws -> Data {
        let bytes = [UInt8](passwordBytes(password))
        let saltBytes = [UInt8](salt)
        var derived = [UInt8](repeating: 0, count: 32)
        // A pointer to one byte stands in for an empty password, whose array may have no
        // base address; the length passed is still zero.
        let buffer: [UInt8] = bytes.isEmpty ? [0] : bytes
        let status = buffer.withUnsafeBufferPointer { passwordBuffer in
            passwordBuffer.baseAddress!.withMemoryRebound(to: CChar.self, capacity: buffer.count) { passwordPointer in
                CCKeyDerivationPBKDF(
                    CCPBKDFAlgorithm(kCCPBKDF2),
                    passwordPointer,
                    bytes.count,
                    saltBytes,
                    saltBytes.count,
                    CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                    pbkdf2Iterations,
                    &derived,
                    derived.count
                )
            }
        }
        guard status == kCCSuccess else { throw CryptoError.derivationFailed }
        return Data(derived)
    }

    /// About a second on a phone: call it off the main actor.
    static func deriveKeys(email: String, password: String) throws -> DerivedKeys {
        let salt = emailSalt(email)
        let stretched = try stretchPassword(password, salt: salt)
        let authKey = hkdfOneBlock(ikm: stretched, label: "pushthat/auth/v1")
        let masterKey = hkdfOneBlock(ikm: stretched, label: "pushthat/master/v1")
        return DerivedKeys(salt: salt, stretched: stretched, authKey: authKey, masterKey: masterKey, firebasePassword: base64url(authKey))
    }

    // MARK: - The account key

    static func newAccountKey() -> Data { randomBytes(accountKeyLength) }

    static func accountSubkeys(_ accountKey: Data) -> AccountSubkeys {
        AccountSubkeys(
            metaKey: hkdfOneBlock(ikm: accountKey, label: "pushthat/meta/v1"),
            searchKey: hkdfOneBlock(ikm: accountKey, label: "pushthat/search/v1")
        )
    }

    static func newWrapId() -> String { base64url(randomBytes(8)) }
    static func newDeviceId() -> String { base64url(randomBytes(16)) }

    static func wrapAad(uid: String) -> Data { utf8("pushthat/wrap/v1:" + uid) }

    /// The nonce parameter exists for the vectors; callers never pass one.
    static func wrapAccountKey(wrappingKey: Data, accountKey: Data, uid: String, by: String, nonce: Data = randomBytes(nonceLength)) throws -> Wrap {
        guard accountKey.count == accountKeyLength else { throw CryptoError.badLength }
        guard by == Wrap.password || by == Wrap.recovery else { throw CryptoError.unknownWrap }
        let ct = try aesGcmSeal(key: wrappingKey, nonce: nonce, plaintext: accountKey, aad: wrapAad(uid: uid))
        return Wrap(by: by, n: base64(nonce), ct: base64(ct))
    }

    /// Throws when the key is not the one the wrap was made with, or the uid is not the
    /// one it was made for.
    static func unwrapAccountKey(wrappingKey: Data, wrap: Wrap, uid: String) throws -> Data {
        let accountKey = try aesGcmOpen(key: wrappingKey, nonce: fromBase64(wrap.n), ciphertext: fromBase64(wrap.ct), aad: wrapAad(uid: uid))
        guard accountKey.count == accountKeyLength else { throw CryptoError.badLength }
        return accountKey
    }

    // MARK: - The recovery key

    /// Crockford's alphabet in RFC 4648 bit order: 20 bytes are exactly 32 symbols.
    private static let crockford = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ".unicodeScalars)

    static func newRecoveryKey() -> Data { randomBytes(recoveryKeyLength) }

    /// Eight groups of four symbols joined by hyphens.
    static func encodeRecoveryKey(_ bytes: Data) throws -> String {
        guard bytes.count == recoveryKeyLength else { throw CryptoError.badLength }
        var acc: UInt32 = 0
        var bits = 0
        var symbols = String.UnicodeScalarView()
        for byte in bytes {
            acc = ((acc << 8) | UInt32(byte)) & 0xFFFF
            bits += 8
            while bits >= 5 {
                symbols.append(crockford[Int((acc >> UInt32(bits - 5)) & 31)])
                bits -= 5
            }
        }
        let text = Array(String(symbols))
        return stride(from: 0, to: text.count, by: 4).map { String(text[$0..<$0 + 4]) }.joined(separator: "-")
    }

    /// Lenient, which is the point of the alphabet: case does not matter, hyphens and
    /// spaces are dropped, I and L read as 1 and O as 0. `uppercased()` is Unicode-wide on
    /// purpose here, as the reference's `toUpperCase` is, so a key typed on any keyboard
    /// decodes the same on every client.
    static func decodeRecoveryKey(_ text: String) throws -> Data {
        var symbols: [Unicode.Scalar] = []
        for scalar in text.uppercased().unicodeScalars {
            switch scalar {
            case "-", " ": continue
            case "I", "L": symbols.append("1")
            case "O": symbols.append("0")
            default: symbols.append(scalar)
            }
        }
        guard symbols.count == 32 else { throw CryptoError.notARecoveryKey }
        var out = Data()
        var acc: UInt32 = 0
        var bits = 0
        for symbol in symbols {
            guard let value = crockford.firstIndex(of: symbol) else { throw CryptoError.notARecoveryKey }
            acc = ((acc << 5) | UInt32(value)) & 0xFFFF
            bits += 5
            if bits >= 8 {
                out.append(UInt8((acc >> UInt32(bits - 8)) & 0xFF))
                bits -= 8
            }
        }
        return out
    }

    /// Over the 20 raw bytes, never the text.
    static func recoveryWrappingKey(_ recoveryBytes: Data) throws -> Data {
        guard recoveryBytes.count == recoveryKeyLength else { throw CryptoError.badLength }
        return hkdfOneBlock(ikm: recoveryBytes, label: "pushthat/recovery/v1")
    }
}

// MARK: - The push envelope

extension E2eeCrypto {
    /// `enc` on a push document: AES-256-GCM under `metaKey`, `n` the 12-byte nonce and `ct`
    /// the ciphertext with its tag, both base64 with padding (docs/e2ee.md, "The push
    /// envelope").
    struct Envelope: Equatable {
        static let version = 1

        let v: Int
        let n: String
        let ct: String

        var firestoreData: [String: Any] { ["v": v, "n": n, "ct": ct] }

        /// An envelope as a document holds it, or nil for anything not shaped like one.
        /// `v` is read as any integer type, since Firestore's SDK hands back an `Int` and
        /// the REST API (the notification service extension) a string.
        init?(firestore value: Any?) {
            guard let map = value as? [String: Any],
                  let n = map["n"] as? String,
                  let ct = map["ct"] as? String
            else { return nil }
            let v: Int
            switch map["v"] {
            case let int as Int: v = int
            case let int as Int64: v = Int(int)
            case let string as String:
                guard let int = Int(string) else { return nil }
                v = int
            default: return nil
            }
            self.init(v: v, n: n, ct: ct)
        }

        init(v: Int, n: String, ct: String) {
            self.v = v
            self.n = n
            self.ct = ct
        }
    }

    /// The rules' bound on `enc.ct` (`isEnvelope` in apps/web/firestore.rules). A push
    /// whose ciphertext is longer is refused here, before the write the rules would refuse.
    static let maxEnvelopeCiphertextLength = 16384

    static func pushAad(userId: String, pushId: String) -> Data {
        utf8("pushthat/push/v1:" + userId + ":" + pushId)
    }

    /// The nonce parameter exists for the vectors; callers never pass one.
    static func sealPush(metaKey: Data, userId: String, pushId: String, plaintext: Data, nonce: Data = randomBytes(nonceLength)) throws -> Envelope {
        let ct = try aesGcmSeal(key: metaKey, nonce: nonce, plaintext: plaintext, aad: pushAad(userId: userId, pushId: pushId))
        return Envelope(v: Envelope.version, n: base64(nonce), ct: base64(ct))
    }

    /// Throws on an envelope of another version, a bad tag, or a ciphertext moved from
    /// another document (the AAD names the document).
    static func openPush(metaKey: Data, userId: String, pushId: String, enc: Envelope) throws -> Data {
        guard enc.v == Envelope.version else { throw CryptoError.unknownEnvelope }
        return try aesGcmOpen(key: metaKey, nonce: fromBase64(enc.n), ciphertext: fromBase64(enc.ct), aad: pushAad(userId: userId, pushId: pushId))
    }
}

// MARK: - The blind index

extension E2eeCrypto {
    /// `base64url(HMAC-SHA256(searchKey, utf8(token)))`, first 16 characters: 96 bits
    /// exactly, so nothing is cut mid-character. The tokens come from
    /// `SearchTokenGenerator`, which holds the rule every client tokenizes by.
    static func blindToken(searchKey: Data, token: String) -> String {
        String(base64url(hmacSha256(key: searchKey, message: utf8(token))).prefix(16))
    }

    static func blindIndex(searchKey: Data, tokens: [String]) -> [String] {
        tokens.map { blindToken(searchKey: searchKey, token: $0) }
    }
}

// MARK: - Files

extension E2eeCrypto {
    static let chunkSize = 1024 * 1024
    static let fileMagic = Data("PTE1".utf8)
    static let filePrefixLength = 8
    static let fileHeaderLength = 12
    static let fileKeyLength = 32

    /// The size of a file of `plaintextBytes` once encrypted: the header and one tag per
    /// chunk, the empty file's one included. What the Storage rules measure against the
    /// tier's limit, so what the limit is checked against before an upload.
    static func encryptedFileSize(_ plaintextBytes: Int64) -> Int64 {
        let chunks = max(1, (plaintextBytes + Int64(chunkSize) - 1) / Int64(chunkSize))
        return Int64(fileHeaderLength) + plaintextBytes + Int64(tagLength) * chunks
    }

    static func newFileKey() -> Data { randomBytes(fileKeyLength) }
    static func newFilePrefix() -> Data { randomBytes(filePrefixLength) }
    static func newObjectId() -> String { base64url(randomBytes(16)) }

    static func fileHeader(prefix: Data) throws -> Data {
        guard prefix.count == filePrefixLength else { throw CryptoError.badLength }
        return fileMagic + prefix
    }

    static func be32(_ n: Int) -> Data {
        let value = UInt32(n)
        return Data([UInt8(value >> 24 & 0xFF), UInt8(value >> 16 & 0xFF), UInt8(value >> 8 & 0xFF), UInt8(value & 0xFF)])
    }

    private static func chunkNonce(prefix: Data, index: Int) -> Data { prefix + be32(index) }

    private static func chunkAad(index: Int, final: Bool) -> Data {
        utf8("pushthat/file/v1") + be32(index) + Data([final ? 1 : 0])
    }

    /// One sealed chunk: every chunk but the last is exactly 1 MiB, and only the empty
    /// file has an empty final chunk, as the reference's `sealChunk` checks.
    static func sealChunk(fk: Data, prefix: Data, index: Int, chunk: Data, final: Bool) throws -> Data {
        guard final ? chunk.count <= chunkSize : chunk.count == chunkSize else { throw CryptoError.badLength }
        guard !(final && index > 0 && chunk.isEmpty) else { throw CryptoError.badLength }
        return try aesGcmSeal(key: fk, nonce: chunkNonce(prefix: prefix, index: index), plaintext: chunk, aad: chunkAad(index: index, final: final))
    }

    static func openChunk(fk: Data, prefix: Data, index: Int, sealed: Data, final: Bool) throws -> Data {
        let plain = sealed.count - tagLength
        guard final ? plain <= chunkSize : plain == chunkSize else { throw CryptoError.badLength }
        return try aesGcmOpen(key: fk, nonce: chunkNonce(prefix: prefix, index: index), ciphertext: sealed, aad: chunkAad(index: index, final: final))
    }

    struct ChunkRange: Equatable {
        let index: Int
        let start: Int64
        let end: Int64
        let final: Bool
    }

    /// The reference's `chunkLayout`: where each sealed chunk of an encrypted object of
    /// `length` bytes starts and ends. Every chunk but the last is 1 MiB + 16 on disk, so
    /// the boundaries follow from the length alone. A last chunk shorter than its tag, or
    /// an empty final chunk after a full one (what an encryptor that does not hold a chunk
    /// back would write), is not a file: every client refuses the same second encoding.
    static func chunkLayout(length: Int64) throws -> [ChunkRange] {
        let header = Int64(fileHeaderLength)
        let tag = Int64(tagLength)
        guard length >= header + tag else { throw CryptoError.notAFile }
        let sealedSize = Int64(chunkSize + tagLength)
        let body = length - header
        let count = (body + sealedSize - 1) / sealedSize
        let last = body - (count - 1) * sealedSize
        guard last >= tag, !(count > 1 && last == tag) else { throw CryptoError.notAFile }
        return (0..<count).map { i in
            let start = header + i * sealedSize
            let final = i == count - 1
            return ChunkRange(index: Int(i), start: start, end: final ? length : start + sealedSize, final: final)
        }
    }

    /// Encrypts what `read` gives, 1 MiB at a time, into what `write` takes. `read(n)`
    /// returns up to n bytes and empty data at the end. One chunk is held back: the end of
    /// the source is only known when a read comes back empty, and the last full chunk of a
    /// file whose size is a multiple of 1 MiB has to be sealed as final, since an empty
    /// final chunk after it is refused by every decryptor.
    static func encryptFile(fk: Data, prefix: Data, read: (Int) throws -> Data, write: (Data) throws -> Void) throws {
        guard fk.count == fileKeyLength else { throw CryptoError.badLength }
        try write(fileHeader(prefix: prefix))
        var current = try readFull(chunkSize, read)
        var index = 0
        while true {
            let next = current.count == chunkSize ? try readFull(chunkSize, read) : Data()
            let final = next.isEmpty
            try autoreleasepool {
                try write(sealChunk(fk: fk, prefix: prefix, index: index, chunk: current, final: final))
            }
            if final { return }
            current = next
            index += 1
        }
    }

    /// A read that only comes back short at the end of the source, whatever the source
    /// hands back per call.
    private static func readFull(_ count: Int, _ read: (Int) throws -> Data) throws -> Data {
        var out = Data()
        while out.count < count {
            let part = try autoreleasepool { try read(count - out.count) }
            if part.isEmpty { break }
            out.append(part)
        }
        return out
    }

    /// Encrypts the file at `source` into a new file at `destination`, never holding more
    /// than two chunks of it. A failure removes what was written.
    static func encryptFile(fk: Data, prefix: Data, source: URL, destination: URL) throws {
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        try encryptFile(fk: fk, prefix: prefix, read: { try input.read(upToCount: $0) ?? Data() }, to: destination)
    }

    /// The same from bytes already in memory (a photo the picker handed over as data), so
    /// that the ciphertext goes to disk rather than becoming a second copy beside them.
    static func encryptFile(fk: Data, prefix: Data, data: Data, destination: URL) throws {
        var offset = 0
        try encryptFile(fk: fk, prefix: prefix, read: { count in
            let end = min(offset + count, data.count)
            defer { offset = end }
            return data.subdata(in: data.startIndex + offset..<data.startIndex + end)
        }, to: destination)
    }

    private static func encryptFile(fk: Data, prefix: Data, read: (Int) throws -> Data, to destination: URL) throws {
        guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
        do {
            let output = try FileHandle(forWritingTo: destination)
            defer { try? output.close() }
            try encryptFile(fk: fk, prefix: prefix, read: read, write: { try output.write(contentsOf: $0) })
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }

    /// Decrypts the object at `source` into `destination`, chunk by chunk by
    /// `chunkLayout`. The magic must be there and the header's prefix must be the
    /// envelope's `np`, which ties the object to its push. Any failure removes the partial
    /// output: a file that does not open is never left behind looking like one that did.
    static func decryptFile(fk: Data, np: Data, source: URL, destination: URL) throws {
        do {
            guard np.count == filePrefixLength, fk.count == fileKeyLength else { throw CryptoError.badLength }
            let input = try FileHandle(forReadingFrom: source)
            defer { try? input.close() }
            let length = try input.seekToEnd()
            let layout = try chunkLayout(length: Int64(length))
            try input.seek(toOffset: 0)
            let header = try input.read(upToCount: fileHeaderLength) ?? Data()
            guard header.count == fileHeaderLength, header.prefix(fileMagic.count) == fileMagic else { throw CryptoError.notAFile }
            let prefix = Data(header.suffix(filePrefixLength))
            guard prefix == np else { throw CryptoError.prefixMismatch }

            guard FileManager.default.createFile(atPath: destination.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
            let output = try FileHandle(forWritingTo: destination)
            defer { try? output.close() }
            for range in layout {
                try autoreleasepool {
                    let sealed = try readFull(Int(range.end - range.start)) { try input.read(upToCount: $0) ?? Data() }
                    guard sealed.count == Int(range.end - range.start) else { throw CryptoError.notAFile }
                    try output.write(contentsOf: openChunk(fk: fk, prefix: prefix, index: range.index, sealed: sealed, final: range.final))
                }
            }
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }
}
