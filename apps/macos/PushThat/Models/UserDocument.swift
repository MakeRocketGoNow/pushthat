import Foundation
import FirebaseFirestore

/// Represents a user document in Firestore
/// Matches the Android Firestore schema exactly
struct UserDocument: Codable {
    let email: String
    let createdAt: Date?
    var fcmTokens: [String]

    enum CodingKeys: String, CodingKey {
        case email
        case createdAt
        case fcmTokens
    }

    init(email: String, createdAt: Date? = nil, fcmTokens: [String] = []) {
        self.email = email
        self.createdAt = createdAt
        self.fcmTokens = fcmTokens
    }

    /// Creates a Firestore-compatible dictionary for new user creation
    static func newUserData(email: String) -> [String: Any] {
        return [
            "email": email,
            "createdAt": FieldValue.serverTimestamp(),
            "fcmTokens": []
        ]
    }

    /// A new user document, made with the account's keys in the same transaction that
    /// writes them (`AccountKeyService.write`): `email`, `createdAt` and `e2ee`, as the web
    /// sign-up and the reset page make it. `fcmTokens` is left to the token write that
    /// follows a sign-in, which adds the field with `arrayUnion`.
    static func newUserData(email: String, e2ee: [String: Any]) -> [String: Any] {
        return [
            "email": email,
            "createdAt": FieldValue.serverTimestamp(),
            "e2ee": e2ee
        ]
    }
}
