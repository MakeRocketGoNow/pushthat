import Foundation
import FirebaseFirestore

/// Encrypts an account's plaintext pushes in place (docs/e2ee.md, "Migration"), once the
/// account key is on this device: at start with a key, and when sign-in or unlock has just
/// stored one. Once per account per process, in the background, and silently: failures
/// are logged, and a pass that stopped on an error lets the next one run.
///
/// In place rather than recreated, because a create would fire `onNewPushCreated` and
/// count against the month. Each push is one `update` (`isMigration` in the rules), not a
/// batch, so that one refused push does not hold back the rest of its page.
///
/// This file is the same in `apps/ios` and `apps/macos`.
actor PushMigration {
    static let shared = PushMigration()

    private var started = Set<String>()
    private let pageSize = 50

    /// What stays on a migrated push besides what the migration writes. Every other field
    /// an old client wrote (`url`, `title`, `deviceName`, `ext`, and anything older) is
    /// deleted, which is what the rules check: the result holds only the encrypted shape.
    private static let keptFields: Set<String> = [
        "userId", "type", "createdAt", "expiresAt", "deviceId", "keyVersion", "enc", "searchTokens", "objectPath",
    ]

    /// The uid is marked before the pass so that a second caller does not start another
    /// beside it. A pass that threw (offline at launch, say: its reads are from the server)
    /// takes the mark off again, or no pass would run until the app restarts. One that got
    /// through with some updates refused keeps it: the rules would refuse them again, and
    /// the next start retries them.
    func runIfNeeded(uid: String) async {
        guard started.insert(uid).inserted else { return }
        do {
            try await run(uid: uid)
        } catch {
            started.remove(uid)
            print("Push migration stopped: \(error)")
        }
    }

    private func run(uid: String) async throws {
        let db = Firestore.firestore()
        guard let keys = PushKeys.load(uid: uid) else { return }

        let user = try await db.collection("users").document(uid).getDocument(source: .server)
        guard let e2ee = user.data()?["e2ee"] as? [String: Any] else { return }
        if e2ee["migratedAt"] != nil { return }
        // A device whose key a reset replaced would write pushes nobody can open (and the
        // rules would refuse them); it leaves the migration to a device with the current key.
        guard (e2ee["keyVersion"] as? NSNumber)?.intValue == keys.keyVersion else { return }

        var failed = 0
        var last: DocumentSnapshot?
        while true {
            var query = db.collection("pushes")
                .whereField("userId", isEqualTo: uid)
                .order(by: "createdAt", descending: true)
                .limit(to: pageSize)
            // After the last document of the page, not the last migrated one, so that a page
            // of pushes already encrypted still moves the query on.
            if let last { query = query.start(afterDocument: last) }
            let page = try await query.getDocuments(source: .server)
            if page.documents.isEmpty { break }
            for document in page.documents where document.data()["enc"] == nil {
                // A push that can never migrate (a file push whose title cannot be its
                // object's name, an unknown type, a content over the rules' bound) is left
                // plaintext and counts as done: holding the mark back for it would page
                // through the whole history on every start, for good. Only an update that
                // was tried and failed keeps the mark off.
                guard let update = Self.migration(of: document, keys: keys) else { continue }
                do {
                    try await document.reference.updateData(update)
                } catch {
                    failed += 1
                    print("Failed to migrate push \(document.documentID): \(error)")
                }
            }
            last = page.documents.last
        }

        // Pushes with no createdAt are not in the ordered query and stay plaintext, which is
        // accepted; everything else is encrypted now or never can be, or the mark waits.
        guard failed == 0 else { return }
        try await db.collection("users").document(uid).updateData(["e2ee.migratedAt": FieldValue.serverTimestamp()])
    }

    /// The update that encrypts one plaintext push, or nil for one that cannot be.
    static func migration(of document: DocumentSnapshot, keys: PushKeys) -> [AnyHashable: Any]? {
        guard let data = document.data(), let userId = data["userId"] as? String, userId == keys.uid else { return nil }
        let ext = data["ext"] as? String ?? ""
        let content: PushContent
        var objectPath: String?
        switch data["type"] as? String {
        case "url":
            content = .url(url: data["url"] as? String ?? "", title: data["title"] as? String ?? "", ext: ext)
        case "file":
            // The bytes are still the plaintext upload, named by the title; the envelope
            // says so, and the push names that object so the delete trigger still finds it.
            // The rules hold the path to `uploads/{uid}/{title}`, one segment deep, so a
            // title that is missing, empty or holds a "/" cannot be migrated.
            guard let title = data["title"] as? String, !title.isEmpty, !title.contains("/") else { return nil }
            content = .file(PushFile(name: title, mime: "", size: 0, ext: ext, fk: nil, np: nil))
            objectPath = "uploads/" + userId + "/" + title
        default:
            return nil
        }
        guard let sealed = try? content.seal(keys: keys, pushId: document.documentID) else { return nil }

        var update: [AnyHashable: Any] = [
            "enc": sealed.enc.firestoreData,
            "searchTokens": sealed.searchTokens,
            "keyVersion": keys.keyVersion,
            "deviceId": keys.deviceId,
        ]
        if let objectPath {
            update["objectPath"] = objectPath
        } else if data["objectPath"] != nil {
            // Only a file push may name an object.
            update["objectPath"] = FieldValue.delete()
        }
        // As field paths: a string key is read as a dotted path, so a field an old client
        // named with a dot would never be deleted, and the rules would refuse its push on
        // every start.
        for field in data.keys where !keptFields.contains(field) {
            update[FieldPath([field])] = FieldValue.delete()
        }
        return update
    }
}
