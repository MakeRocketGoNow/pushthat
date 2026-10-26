import Foundation
import SwiftData

/// Local cache entity for failed uploads
/// Will be retried by background task
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

    /// Converts to Firestore-compatible dictionary
    func toFirestoreData() -> [String: Any] {
        var data: [String: Any] = [
            "url": url,
            "userId": userId ?? "",
            "createdAt": createdAt,
            "title": title,
            "type": type,
            "deviceName": deviceName,
            "searchTokens": SearchTokenGenerator.generate(from: title)
        ]

        if let ext = ext {
            data["ext"] = ext
        }

        return data
    }
}
