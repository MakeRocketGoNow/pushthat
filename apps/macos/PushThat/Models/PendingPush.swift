import Foundation
import SwiftData

/// A push that could not be written yet, kept for a retry.
///
/// A push queued by this version holds the push as it will be written (`prepared`): the
/// id it was sealed for and every field of the document, so that each attempt writes the
/// same id and the same ciphertext (docs/e2ee.md, "The push envelope": the envelope's AAD
/// names the document). One queued before the encryption update has only the plaintext
/// fields and no id; it is sealed at retry time under a new id once this device holds the
/// account key, and kept until it does.
///
/// The plaintext fields stay in the model so that SwiftData can still read the rows an
/// earlier version wrote; `pushId` and `prepared` are optional for the same reason, which
/// lets the store migrate without a schema version of its own.
///
/// This file is the same in `apps/ios` and `apps/macos`.
@Model
final class PendingPush {
    var id: UUID
    var url: String
    var userId: String?
    var createdAt: Date
    var title: String
    var type: String
    var deviceName: String
    var ext: String?
    var pushId: String?
    /// A `PreparedPush`, JSON-encoded.
    var prepared: Data?

    init(
        url: String,
        userId: String?,
        title: String = "",
        type: String = "url",
        deviceName: String = "",
        ext: String? = nil
    ) {
        self.id = UUID()
        self.url = url
        self.userId = userId
        self.createdAt = Date()
        self.title = title
        self.type = type
        self.deviceName = deviceName
        self.ext = ext
    }

    /// A prepared push, queued as it will be written. The plaintext fields are left empty:
    /// the content is in the envelope, and the local store is no place to keep a copy.
    convenience init(prepared push: PreparedPush) throws {
        self.init(url: "", userId: push.userId, type: push.type)
        pushId = push.pushId
        prepared = try JSONEncoder().encode(push)
    }

    var preparedPush: PreparedPush? {
        prepared.flatMap { try? JSONDecoder().decode(PreparedPush.self, from: $0) }
    }

    /// A push queued before the encryption update, sealed under a new id with `keys`.
    ///
    /// A file push of that time names its plaintext upload by its title
    /// (`uploads/{uid}/{title}`), as a migrated one does, so it is written the same way: an
    /// envelope with `legacyPlain` and that path.
    func prepareLegacy(keys: PushKeys, pushId: String) throws -> PreparedPush {
        if type == "file" {
            let file = PushFile(name: title, mime: "", size: 0, ext: ext ?? PushFile.ext(of: title), fk: nil, np: nil)
            return try PreparedPush(content: .file(file), keys: keys, pushId: pushId, objectPath: "uploads/\(keys.uid)/\(title)")
        }
        return try PreparedPush(content: .url(url: url, title: title == url ? "" : title, ext: ext ?? ""), keys: keys, pushId: pushId)
    }
}
