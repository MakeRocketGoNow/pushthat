import Foundation
import FirebaseFirestore

/// A push as the list shows it, read from either shape of push document (docs/e2ee.md):
/// an encrypted one, opened with this device's key, or a plaintext one from before the
/// migration, read as it always was. Clients read both until phase 5.
///
/// This file is the same in `apps/ios` and `apps/macos`.
struct PushItem: Identifiable, Equatable {
    let id: String?
    let userId: String
    let createdAt: Date?
    let type: PushType
    /// The page's title or the file's name; "" for a URL push not yet titled.
    let title: String
    /// The URL of a URL push. A plaintext file push's download URL; "" for an encrypted one,
    /// which has no URL at all.
    let url: String
    let ext: String?
    let source: Source
    /// The push's `keyVersion`, which a retitle has to match.
    let keyVersion: Int?

    enum PushType: String {
        case url
        case file
    }

    enum Source: Equatable {
        /// A document without `enc`.
        case plaintext
        /// Opened with this device's key. A file push carries its envelope, which says how
        /// to fetch and open the object.
        case encrypted(file: PushFile?, objectPath: String?)
        /// Encrypted under a key this device does not hold (a reset without the recovery
        /// key replaced it), or not openable at all. It can be selected and deleted.
        case locked
    }

    static let lockedTitle = "Locked push"
    static let lockedMessage = "This push was encrypted with a key this account no longer has. It can be deleted but not opened."

    var isLocked: Bool { source == .locked }

    /// The file envelope of an encrypted file push.
    var file: PushFile? {
        if case let .encrypted(file, _) = source { return file }
        return nil
    }

    var objectPath: String? {
        if case let .encrypted(_, objectPath) = source { return objectPath }
        return nil
    }

    /// What the row shows: the title, or the URL while a URL push has none.
    var displayTitle: String {
        if isLocked { return Self.lockedTitle }
        return title.isEmpty ? url : title
    }

    /// What Copy puts on the clipboard: the URL, or a file push's name when it has no URL
    /// (an encrypted one, whose object is reached only through the app). Nothing for a
    /// locked push.
    var copyText: String? {
        if isLocked { return nil }
        if !url.isEmpty { return url }
        return title.isEmpty ? nil : title
    }

    init(
        id: String? = nil,
        url: String,
        userId: String,
        createdAt: Date? = nil,
        title: String,
        type: PushType = .url,
        ext: String? = nil,
        source: Source = .plaintext,
        keyVersion: Int? = nil
    ) {
        self.id = id
        self.url = url
        self.userId = userId
        self.createdAt = createdAt
        self.title = title
        self.type = type
        self.ext = ext
        self.source = source
        self.keyVersion = keyVersion
    }

    /// A push document, opened with `keys` when it is encrypted. Nil for a document that is
    /// not a push at all (no userId or type).
    init?(id: String, data: [String: Any], keys: PushKeys?) {
        guard let userId = data["userId"] as? String,
              let typeName = data["type"] as? String,
              let type = PushType(rawValue: typeName)
        else { return nil }
        let createdAt = (data["createdAt"] as? Timestamp)?.dateValue()
        let keyVersion = (data["keyVersion"] as? NSNumber)?.intValue

        guard data["enc"] != nil else {
            let ext = data["ext"] as? String
            self.init(
                id: id, url: data["url"] as? String ?? "", userId: userId, createdAt: createdAt,
                title: data["title"] as? String ?? "", type: type, ext: ext, source: .plaintext
            )
            return
        }

        guard let keys, let enc = E2eeCrypto.Envelope(firestore: data["enc"]),
              let content = PushContent.open(keys: keys, userId: userId, pushId: id, type: typeName, keyVersion: keyVersion, enc: enc)
        else {
            self.init(id: id, url: "", userId: userId, createdAt: createdAt, title: "", type: type, source: .locked, keyVersion: keyVersion)
            return
        }

        switch content {
        case let .url(url, title, ext):
            self.init(
                id: id, url: url, userId: userId, createdAt: createdAt, title: title, type: .url,
                ext: ext.isEmpty ? nil : ext, source: .encrypted(file: nil, objectPath: nil), keyVersion: keyVersion
            )
        case let .file(file):
            self.init(
                id: id, url: "", userId: userId, createdAt: createdAt, title: file.name, type: .file,
                ext: file.ext.isEmpty ? nil : file.ext, source: .encrypted(file: file, objectPath: data["objectPath"] as? String),
                keyVersion: keyVersion
            )
        }
    }

    init?(document: DocumentSnapshot, keys: PushKeys?) {
        guard let data = document.data() else { return nil }
        self.init(id: document.documentID, data: data, keys: keys)
    }
}
