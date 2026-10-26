import Foundation
import FirebaseFirestore

/// Represents a push item stored in Firestore
/// Matches the Android Firestore schema exactly
struct PushItem: Identifiable, Codable, Equatable {
    @DocumentID var id: String?
    let url: String
    let userId: String
    let createdAt: Date?
    var title: String
    let type: PushType
    let deviceName: String
    let searchTokens: [String]
    let ext: String?

    enum PushType: String, Codable {
        case url
        case file
    }

    enum CodingKeys: String, CodingKey {
        case id
        case url
        case userId
        case createdAt
        case title
        case type
        case deviceName
        case searchTokens
        case ext
    }

    init(
        id: String? = nil,
        url: String,
        userId: String,
        createdAt: Date? = nil,
        title: String,
        type: PushType = .url,
        deviceName: String,
        searchTokens: [String] = [],
        ext: String? = nil
    ) {
        self.id = id
        self.url = url
        self.userId = userId
        self.createdAt = createdAt
        self.title = title
        self.type = type
        self.deviceName = deviceName
        self.searchTokens = searchTokens
        self.ext = ext
    }

    /// Creates a Firestore-compatible dictionary for uploading
    func toFirestoreData() -> [String: Any] {
        var data: [String: Any] = [
            "url": url,
            "userId": userId,
            "createdAt": FieldValue.serverTimestamp(),
            "title": title,
            "type": type.rawValue,
            "deviceName": deviceName,
            "searchTokens": searchTokens
        ]

        if let ext = ext {
            data["ext"] = ext
        }

        return data
    }
}
