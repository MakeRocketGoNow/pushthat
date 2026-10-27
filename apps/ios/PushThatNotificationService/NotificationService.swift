import Foundation
import UserNotifications
import FirebaseCore
import FirebaseAuth

/// Shows an encrypted push's content in its notification (docs/e2ee.md, "Notifications").
///
/// The server knows nothing to put in a notification but the push's id, so APNs carries
/// the alert "New push" with `mutable-content` and the data `{pushId, type, deviceId,
/// keyVersion}`; iOS hands it here before showing it. This reads the push document,
/// opens its envelope with the account key from the shared Keychain, and sets the title
/// and body the app showed before encryption: a URL push's title (or the URL's domain
/// while it has none) over its URL, a file push's name over "File". The URL goes into
/// `userInfo`, where the app looks for it when the notification is tapped.
///
/// The document is read over the Firestore REST API with an ID token from FirebaseAuth,
/// not the Firestore SDK: an extension has 24 MB, and the SDK alone is most of it.
///
/// Anything that fails (no session or key, offline, a key a reset replaced, a push that
/// does not open) leaves "New push", whose tap opens the app; the list decrypts there. So
/// does running out of time. An extension cannot drop a notification without Apple's
/// filtering entitlement, so a push this iPhone made itself is shown too, decrypted,
/// where Android skips its own: the app hides it only while it is in the foreground.
final class NotificationService: UNNotificationServiceExtension {
    static let fallbackTitle = "New push"
    static let fileBody = "File"

    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var fallback: UNNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        self.contentHandler = contentHandler
        lock.unlock()

        let userInfo = request.content.userInfo
        // The plaintext shape a push made before encryption still sends carries its own
        // title and URL, and is shown as it came.
        guard let pushId = userInfo["pushId"] as? String, userInfo["keyVersion"] != nil, userInfo["url"] == nil else {
            deliver(request.content)
            return
        }

        let fallback = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        fallback.title = Self.fallbackTitle
        fallback.body = ""
        lock.lock()
        self.fallback = fallback
        lock.unlock()

        work = Task {
            do {
                let content = try await Self.decrypted(pushId: pushId, base: fallback)
                deliver(content)
            } catch {
                print("Push \(pushId) shown as \"\(Self.fallbackTitle)\": \(error)")
                deliver(fallback)
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        lock.lock()
        let fallback = self.fallback
        lock.unlock()
        if let fallback { deliver(fallback) }
    }

    /// Hands the content over once: whichever of the read and the time limit comes first.
    private func deliver(_ content: UNNotificationContent) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        handler?(content)
    }

    // MARK: - Reading the push

    enum ReadError: Error {
        case noSession
        case noKey
        case noProject
        case http(Int)
        case notAPush
        case locked
    }

    private static func decrypted(pushId: String, base: UNMutableNotificationContent) async throws -> UNNotificationContent {
        configureFirebase()
        guard let user = Auth.auth().currentUser else { throw ReadError.noSession }
        guard let stored = AccountKeyStore.accountKey(for: user.uid) else { throw ReadError.noKey }
        let keys = PushKeys(uid: stored.uid, keyVersion: stored.keyVersion, accountKey: stored.key, deviceId: (try? AccountKeyStore.deviceId()) ?? "")
        let token = try await user.getIDToken()
        try Task.checkCancellation()

        let document = try await fetch(pushId: pushId, idToken: token)
        guard let userId = document["userId"] as? String,
              let type = document["type"] as? String,
              let enc = E2eeCrypto.Envelope(firestore: document["enc"])
        else { throw ReadError.notAPush }
        let keyVersion = (document["keyVersion"] as? String).flatMap { Int($0) }
        guard let content = PushContent.open(keys: keys, userId: userId, pushId: pushId, type: type, keyVersion: keyVersion, enc: enc) else {
            throw ReadError.locked
        }

        let result = base.mutableCopy() as! UNMutableNotificationContent
        switch content {
        case let .url(url, title, _):
            result.title = title.isEmpty ? (URL(string: url)?.host ?? url) : title
            result.body = url
            var userInfo = result.userInfo
            userInfo["url"] = url
            result.userInfo = userInfo
        case let .file(file):
            result.title = file.name
            result.body = fileBody
        }
        return result
    }

    /// The app's own configuration, and its session: the shared Keychain group the app and
    /// the share extension keep Firebase Auth's user in.
    private static func configureFirebase() {
        guard FirebaseApp.app() == nil else { return }
        FirebaseApp.configure()
        do {
            try Auth.auth().useUserAccessGroup("group.com.makerocketgonow.pushthat")
        } catch {
            print("Failed to configure shared keychain for Auth: \(error)")
        }
    }

    /// `pushes/{pushId}` over the REST API, as plain values: the typed values Firestore
    /// returns (`{"stringValue": ...}`, `{"integerValue": "1"}`, `{"mapValue": {"fields":
    /// ...}}`) unwrapped into strings and maps. An integer stays the string the API sends.
    ///
    /// Only the fields `decrypted` reads, through a field mask: the whole document carries
    /// up to 3000 search tokens, which would be downloaded and parsed for nothing inside
    /// the extension's 24 MB.
    private static func fetch(pushId: String, idToken: String) async throws -> [String: Any] {
        let mask = ["userId", "type", "enc", "keyVersion"].map { "mask.fieldPaths=\($0)" }.joined(separator: "&")
        guard let projectId = FirebaseApp.app()?.options.projectID,
              let id = pushId.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let url = URL(string: "https://firestore.googleapis.com/v1/projects/\(projectId)/databases/(default)/documents/pushes/\(id)?\(mask)")
        else { throw ReadError.noProject }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ReadError.http(0) }
        guard http.statusCode == 200 else { throw ReadError.http(http.statusCode) }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fields = json["fields"] as? [String: Any]
        else { throw ReadError.notAPush }
        return plainFields(fields)
    }

    static func plainFields(_ fields: [String: Any]) -> [String: Any] {
        fields.compactMapValues { plainValue($0) }
    }

    static func plainValue(_ value: Any) -> Any? {
        guard let typed = value as? [String: Any] else { return nil }
        if let string = typed["stringValue"] as? String { return string }
        if let integer = typed["integerValue"] as? String { return integer }
        if let map = typed["mapValue"] as? [String: Any] {
            return plainFields(map["fields"] as? [String: Any] ?? [:])
        }
        if let array = typed["arrayValue"] as? [String: Any] {
            return (array["values"] as? [Any] ?? []).compactMap { plainValue($0) }
        }
        return typed.values.first
    }
}
