import Foundation
import FirebaseFirestore
import FirebaseStorage

/// Writes encrypted pushes and their files (docs/e2ee.md, "The push envelope" and
/// "Files"), for the app and the share extension alike. The document is exactly what the
/// rules' encrypted shape takes (`isEncryptedPushFields` in apps/web/firestore.rules):
/// userId, type, createdAt, deviceId, keyVersion, enc, searchTokens and, on a file push,
/// objectPath. Nothing in plaintext beside them: no url, title, deviceName or ext.
///
/// This file is the same in `apps/ios` and `apps/macos`.
enum PushDocuments {
    enum PushError: LocalizedError {
        /// A session with no account key on this device does not push.
        case noKey
        /// The rules refused the create, and the push could not be read back to tell whether
        /// an earlier attempt of it had landed (`create`).
        case unconfirmed

        var errorDescription: String? {
            switch self {
            case .noKey: return "Open PushThat and sign in to unlock your pushes, then try again."
            case .unconfirmed: return "Could not confirm that this push was saved. Check your pushes before trying again."
            }
        }
    }

    static func keys(for uid: String) throws -> PushKeys {
        guard let keys = PushKeys.load(uid: uid) else { throw PushError.noKey }
        return keys
    }

    // MARK: - URL pushes

    /// A URL push, sealed under a new id. The title is empty until a scraper fills it in;
    /// the list shows the URL until then.
    static func prepareURLPush(firestore: Firestore, keys: PushKeys, url: String, title: String = "", ext: String) throws -> PreparedPush {
        let pushId = firestore.collection("pushes").document().documentID
        return try PreparedPush(content: .url(url: url, title: title, ext: ext), keys: keys, pushId: pushId)
    }

    /// Creates the push document with `set` on its chosen id.
    ///
    /// A permission refusal is not always what it says. The SDK resends a write whose
    /// acknowledgement was lost, and once the first attempt has landed the resend of a
    /// create is an update, which the rules refuse. So after a refusal the push is read
    /// back from the server. Found, it landed, and this returns as if the write had been
    /// acknowledged. Refused, it does not exist (the read rule checks the owner of the
    /// document, and a missing one has none), and the refusal is thrown: it is final.
    /// Any other failure of the read leaves it unknown, `PushError.unconfirmed`, and the
    /// caller keeps whatever the push points at, which may belong to a push that exists.
    static func create(_ push: PreparedPush, firestore: Firestore) async throws {
        let document = firestore.collection("pushes").document(push.pushId)
        do {
            try await document.setData(firestoreData(push))
        } catch where isPermissionDenied(error) {
            let landed: Bool
            do {
                landed = try await document.getDocument(source: .server).exists
            } catch where isPermissionDenied(error) {
                landed = false
            } catch {
                throw PushError.unconfirmed
            }
            if !landed { throw error }
        }
    }

    static func firestoreData(_ push: PreparedPush) -> [String: Any] {
        var data: [String: Any] = [
            "userId": push.userId,
            "type": push.type,
            "createdAt": FieldValue.serverTimestamp(),
            "deviceId": push.deviceId,
            // An Int, which Firestore stores as an integer: the rules check `is int`, and a
            // Double or a String here would be refused.
            "keyVersion": push.keyVersion,
            "enc": push.enc.firestoreData,
            "searchTokens": push.searchTokens,
        ]
        if let objectPath = push.objectPath {
            data["objectPath"] = objectPath
        }
        return data
    }

    // MARK: - Files

    /// Encrypts the file to a temporary file, uploads that as
    /// `uploads/{uid}/{objectId}` (`application/octet-stream`, a random name, so the
    /// object says nothing about the file), then creates the push. A push the rules refuse
    /// takes its object with it, so nothing is left for the orphan sweep, unless `create`
    /// could not tell whether it landed: then the object stays, since deleting it could
    /// leave a push that exists with no file. The temporary file is deleted either way.
    ///
    /// `encrypt` writes the sealed file to the URL it is given, from wherever the bytes are
    /// (`E2eeCrypto.encryptFile(fk:prefix:source:destination:)` or `data:`); it runs off
    /// the main thread.
    @discardableResult
    static func uploadFilePush(
        keys: PushKeys,
        name: String,
        mime: String,
        size: Int64,
        storage: Storage,
        firestore: Firestore,
        encrypt: @escaping @Sendable (_ fk: Data, _ prefix: Data, _ destination: URL) throws -> Void
    ) async throws -> PreparedPush {
        let fk = E2eeCrypto.newFileKey()
        let prefix = E2eeCrypto.newFilePrefix()
        let objectPath = "uploads/\(keys.uid)/\(E2eeCrypto.newObjectId())"
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("pushthat-upload-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: temp) }

        try await Task.detached(priority: .userInitiated) {
            try encrypt(fk, prefix, temp)
        }.value

        let object = storage.reference(withPath: objectPath)
        let metadata = StorageMetadata()
        metadata.contentType = "application/octet-stream"
        _ = try await object.putFileAsync(from: temp, metadata: metadata)

        let file = PushFile(name: name, mime: mime.isEmpty ? "application/octet-stream" : mime, size: size, ext: PushFile.ext(of: name), fk: fk, np: prefix)
        do {
            let pushId = firestore.collection("pushes").document().documentID
            let push = try PreparedPush(content: .file(file), keys: keys, pushId: pushId, objectPath: objectPath)
            try await create(push, firestore: firestore)
            return push
        } catch {
            if case PushError.unconfirmed = error {} else {
                try? await object.delete()
            }
            throw error
        }
    }

    // MARK: - Titles

    /// The scraped title written back to an encrypted URL push: exactly `enc` and
    /// `searchTokens` (`isEncryptedRetitle` in the rules), the URL and ext as they were, the
    /// new title under a fresh nonce. Only under the push's own key version, and only when
    /// that is the one this device holds: a push made under another key is not ours to
    /// rewrite. Last write wins.
    static func retitle(
        firestore: Firestore,
        keys: PushKeys,
        pushId: String,
        userId: String,
        keyVersion: Int?,
        url: String,
        ext: String,
        title: String
    ) async throws {
        guard keyVersion == keys.keyVersion, userId == keys.uid else { return }
        let sealed = try PushContent.url(url: url, title: title, ext: ext).seal(keys: keys, pushId: pushId)
        try await firestore.collection("pushes").document(pushId).updateData([
            "enc": sealed.enc.firestoreData,
            "searchTokens": sealed.searchTokens,
        ])
    }

    // MARK: - Errors

    /// A refusal by the rules, which no retry changes.
    static func isPermissionDenied(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == FirestoreErrorDomain && error.code == FirestoreErrorCode.permissionDenied.rawValue
    }
}
