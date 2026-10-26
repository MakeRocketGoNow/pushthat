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
/// test bundle compiles it on its own without the app or Firebase.
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
