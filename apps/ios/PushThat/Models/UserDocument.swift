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
}
