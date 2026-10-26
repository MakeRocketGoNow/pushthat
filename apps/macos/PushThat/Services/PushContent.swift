import Foundation

/// What a push's envelope holds (docs/e2ee.md, "The push envelope"), and the keys this
/// device seals and opens it with. Foundation, CryptoKit and Security only: the app, the
/// share extension, the notification service extension and the tests all compile it, and
/// only the first two have Firestore.
///
/// This file is the same in `apps/ios` and `apps/macos`.
enum PushContent: Equatable {
    case url(url: String, title: String, ext: String)
    case file(PushFile)

    enum ContentError: LocalizedError {
        /// The sealed push is over the rules' bound on `enc.ct`. Only an absurd URL reaches
        /// it once the title is cut, so it is said as the generic push failure.
        case tooLarge
        case malformed

        var errorDescription: String? {
            switch self {
            case .tooLarge: return "This push is too large to send."
            case .malformed: return "This push could not be read."
            }
        }
    }

    /// The longest title a push carries. The page title is display text, and a cut one
    /// keeps a long URL's push inside the rules' bound on the ciphertext.
    static let maxTitleLength = 1000

    var type: String {
        switch self {
        case .url: return "url"
        case .file: return "file"
        }
    }

    /// What the blind index is made from: a URL push's title and URL together, so a push
    /// with no title yet is found by its host and path, and a file push's name.
    var searchText: String {
        switch self {
        case let .url(url, title, _): return title + " " + url
        case let .file(file): return file.name
        }
    }

    /// The envelope's plaintext. The spec fixes no canonical form: this is whatever
    /// `JSONSerialization` writes, and a reader parses whatever it finds.
    func json() throws -> Data {
        let object: [String: Any]
        switch self {
        case let .url(url, title, ext):
            object = ["url": url, "title": String(title.prefix(Self.maxTitleLength)), "ext": ext]
        case let .file(file):
            if let fk = file.fk, let np = file.np {
                object = [
                    "name": file.name, "mime": file.mime, "size": file.size, "ext": file.ext,
                    "fk": E2eeCrypto.base64(fk), "np": E2eeCrypto.base64(np),
                ]
            } else {
                object = ["name": file.name, "mime": file.mime, "size": file.size, "ext": file.ext, "legacyPlain": true]
            }
        }
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// The plaintext of a push of `type` ("url" or "file"), as any client wrote it.
    init(json: Data, type: String) throws {
        guard let object = try JSONSerialization.jsonObject(with: json) as? [String: Any] else { throw ContentError.malformed }
        let ext = object["ext"] as? String ?? ""
        switch type {
        case "url":
            guard let url = object["url"] as? String else { throw ContentError.malformed }
            self = .url(url: url, title: object["title"] as? String ?? "", ext: ext)
        case "file":
            guard let name = object["name"] as? String else { throw ContentError.malformed }
            let mime = object["mime"] as? String ?? ""
            let size = (object["size"] as? NSNumber)?.int64Value ?? 0
            if object["legacyPlain"] as? Bool == true {
                self = .file(PushFile(name: name, mime: mime, size: size, ext: ext, fk: nil, np: nil))
                return
            }
            guard let fkText = object["fk"] as? String, let npText = object["np"] as? String,
                  let fk = try? E2eeCrypto.fromBase64(fkText), let np = try? E2eeCrypto.fromBase64(npText),
                  fk.count == E2eeCrypto.fileKeyLength, np.count == E2eeCrypto.filePrefixLength
            else { throw ContentError.malformed }
            self = .file(PushFile(name: name, mime: mime, size: size, ext: ext, fk: fk, np: np))
        default:
            throw ContentError.malformed
        }
    }

    /// The envelope and the blind index of this content, for the push `pushId` of
    /// `keys.uid`. Refused here when the ciphertext would be over the rules' bound.
    func seal(keys: PushKeys, pushId: String) throws -> (enc: E2eeCrypto.Envelope, searchTokens: [String]) {
        let enc = try E2eeCrypto.sealPush(metaKey: keys.metaKey, userId: keys.uid, pushId: pushId, plaintext: json())
        guard enc.ct.count <= E2eeCrypto.maxEnvelopeCiphertextLength else { throw ContentError.tooLarge }
        let tokens = E2eeCrypto.blindIndex(searchKey: keys.searchKey, tokens: SearchTokenGenerator.generate(from: searchText))
        return (enc, tokens)
    }

    /// Opens a push's envelope, or nil when this device cannot: a push made under another
    /// account key (`keyVersion` differs), or one that does not open or parse. Such a push
    /// is shown locked. The AAD is made from the document's own `userId` and id.
    static func open(keys: PushKeys, userId: String, pushId: String, type: String, keyVersion: Int?, enc: E2eeCrypto.Envelope) -> PushContent? {
        guard keyVersion == keys.keyVersion, userId == keys.uid,
              let plaintext = try? E2eeCrypto.openPush(metaKey: keys.metaKey, userId: userId, pushId: pushId, enc: enc)
        else { return nil }
        return try? PushContent(json: plaintext, type: type)
    }
}

/// A file push's envelope. `fk` and `np` are absent on a file push migrated from plaintext
/// (`legacyPlain`), whose object is still the plaintext upload and opens as it is.
struct PushFile: Equatable {
    let name: String
    /// "application/octet-stream" when unknown; "" on a migrated push.
    let mime: String
    /// Plaintext bytes; 0 on a migrated push.
    let size: Int64
    /// Lowercased, no dot, "" when none.
    let ext: String
    let fk: Data?
    let np: Data?

    var legacyPlain: Bool { fk == nil || np == nil }

    /// The extension as every client writes it: lowercased, no dot, "" when none.
    static func ext(of name: String) -> String {
        (name as NSString).pathExtension.lowercased()
    }
}

/// The keys a push is sealed and opened with, from the account key this device stores
/// (docs/e2ee.md, "Where keys live on each device"). `keyVersion` is the version stored
/// beside the key, never one read fresh from the user document: the rules refuse a push
/// whose version is not the account's current one, and that refusal is what stops a device
/// whose key a reset replaced from writing pushes nobody can open.
struct PushKeys {
    let uid: String
    let keyVersion: Int
    let metaKey: Data
    let searchKey: Data
    /// This install's id, written on every push for echo suppression.
    let deviceId: String

    init(uid: String, keyVersion: Int, accountKey: Data, deviceId: String) {
        let subkeys = E2eeCrypto.accountSubkeys(accountKey)
        self.uid = uid
        self.keyVersion = keyVersion
        metaKey = subkeys.metaKey
        searchKey = subkeys.searchKey
        self.deviceId = deviceId
    }

    /// The keys for `uid`, or nil when this device holds no key for the account (an install
    /// that updated while signed in, before the password is asked for): such a session
    /// does not push.
    static func load(uid: String) -> PushKeys? {
        guard let stored = AccountKeyStore.accountKey(for: uid), let deviceId = try? AccountKeyStore.deviceId() else { return nil }
        return PushKeys(uid: stored.uid, keyVersion: stored.keyVersion, accountKey: stored.key, deviceId: deviceId)
    }

    /// The blind token a search for `term` looks up, or nil for a term with no word in it.
    func searchToken(for term: String) -> String? {
        SearchTokenGenerator.searchWord(term).map { E2eeCrypto.blindToken(searchKey: searchKey, token: $0) }
    }
}

/// A push as it will be written: the id chosen before sealing, and every field of the
/// document but `createdAt`, which is the server's. Kept whole by a retry, so that every
/// attempt writes the same id and the same ciphertext (docs/e2ee.md, "The push envelope":
/// the AAD names the document, so a new id would need a new envelope).
struct PreparedPush: Codable, Equatable {
    let pushId: String
    let userId: String
    let type: String
    let encVersion: Int
    let encNonce: String
    let encCiphertext: String
    let searchTokens: [String]
    let keyVersion: Int
    let deviceId: String
    /// File pushes only: "uploads/{uid}/{objectId}".
    let objectPath: String?

    init(content: PushContent, keys: PushKeys, pushId: String, objectPath: String? = nil) throws {
        let sealed = try content.seal(keys: keys, pushId: pushId)
        self.pushId = pushId
        userId = keys.uid
        type = content.type
        encVersion = sealed.enc.v
        encNonce = sealed.enc.n
        encCiphertext = sealed.enc.ct
        searchTokens = sealed.searchTokens
        keyVersion = keys.keyVersion
        deviceId = keys.deviceId
        self.objectPath = objectPath
    }

    var enc: E2eeCrypto.Envelope { E2eeCrypto.Envelope(v: encVersion, n: encNonce, ct: encCiphertext) }
}
