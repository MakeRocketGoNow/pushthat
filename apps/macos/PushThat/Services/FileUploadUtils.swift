import Foundation
import FirebaseAuth
import FirebaseStorage
import FirebaseFirestore
import UniformTypeIdentifiers

/// Errors that can occur during file upload
enum FileUploadError: LocalizedError {
    case fileTooLarge(fileType: String, isPro: Bool)
    case notAuthenticated
    case uploadFailed(underlying: Error)

    var errorDescription: String? {
        switch self {
        case .fileTooLarge(let fileType, let isPro):
            return FileUploadUtils.tooLargeMessage(fileType, isPro: isPro)
        case .notAuthenticated:
            return "Please sign in first"
        case .uploadFailed(let underlying):
            return "Upload failed: \(underlying.localizedDescription)"
        }
    }
}

/// What `getPlan` answers (functions/src/plan.ts): the tier, this month's usage against its limits, and the subscription.
struct PlanReport: Decodable {
    struct Limits: Decodable {
        let url: Int
        let file: Int
        let fileBytes: Int64
        let keepDays: Int
    }
    struct Usage: Decodable {
        let periodKey: String
        let url: Int
        let file: Int
    }
    struct Subscription: Decodable {
        /// `pro` from Stripe, or `comp`.
        let type: String
        let status: String?
        /// ISO 8601.
        let expiresAt: String?
        let cancelsAt: String?
    }
    let tier: String
    let limits: Limits
    let usage: Usage
    let subscription: Subscription?
    let hasCustomer: Bool
    let priceUsd: Int

    var isPro: Bool { tier == "pro" }
}

/// The account's plan, Free or Pro (docs/billing.md at the repository root).
///
/// The app never sells the plan: the App Store forbids selling a subscription in an app
/// through anything but its own billing, so it shows where the account stands and says
/// that plans are managed on the account on the web, with no button that leads there.
/// The tier is read the same way the Firestore rules read it, off
/// `users/{uid}.subscription.expiresAt`, and the full report comes from the `getPlan`
/// function, called over plain HTTPS as a Firebase callable so no further SDK is needed.
enum PlanService {
    private static let mb: Int64 = 1024 * 1024
    static let freeFileBytes: Int64 = 25 * mb
    static let proFileBytes: Int64 = 100 * mb

    private static let getPlanURL = URL(string: "https://us-central1-push-that.cloudfunctions.net/getPlan")!

    /// Pro while the subscription's expiresAt is ahead of the clock: the rules' own test. Free when it cannot be read.
    static func isPro(userId: String? = Auth.auth().currentUser?.uid) async -> Bool {
        guard let userId else { return false }
        guard let snapshot = try? await Firestore.firestore().collection("users").document(userId).getDocument(),
              let expiresAt = snapshot.get("subscription.expiresAt") as? Timestamp else { return false }
        return expiresAt.dateValue() > Date()
    }

    static func maxFileBytes(isPro: Bool) -> Int64 {
        isPro ? proFileBytes : freeFileBytes
    }

    /// `getPlan` for the signed-in account.
    static func fetchReport() async throws -> PlanReport {
        guard let user = Auth.auth().currentUser else { throw FileUploadError.notAuthenticated }
        let token = try await user.getIDToken()
        var request = URLRequest(url: getPlanURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{\"data\":{}}".utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        struct Envelope: Decodable { let result: PlanReport }
        return try JSONDecoder().decode(Envelope.self, from: data).result
    }
}

/// Shared utilities for file uploads used by both the main app and share extension
enum FileUploadUtils {

    // MARK: - Device Name

    /// Get the current device name for macOS
    static func getDeviceName() -> String {
        return Host.current().localizedName ?? "Mac"
    }

    // MARK: - File Size Validation

    /// Check if data exceeds the tier's maximum file size: 100 MB on Pro, 25 MB on Free, which the Storage rules enforce.
    static func exceedsMaxFileSize(_ data: Data, isPro: Bool) -> Bool {
        return Int64(data.count) > PlanService.maxFileBytes(isPro: isPro)
    }

    /// The sentence for a file over the tier's size, naming the limit. Nothing more: a pointer to the
    /// website at the moment a limit is hit is the call to action the store rules forbid.
    static func tooLargeMessage(_ fileType: String, isPro: Bool) -> String {
        let limit = PlanService.maxFileBytes(isPro: isPro) / (1024 * 1024)
        return isPro ? "\(fileType) too large (max \(limit) MB)" : "\(fileType) too large (max \(limit) MB on the free plan)"
    }

    /// Validate file size and throw if too large
    static func validateFileSize(_ data: Data, fileType: String = "File", isPro: Bool) throws {
        if exceedsMaxFileSize(data, isPro: isPro) {
            throw FileUploadError.fileTooLarge(fileType: fileType, isPro: isPro)
        }
    }

    // MARK: - Filename Generation

    /// Generate a timestamp-based filename for images based on UTType
    static func generateImageFileName(for type: UTType) -> String {
        let timestamp = Int(Date().timeIntervalSince1970)
        switch type {
        case .png:
            return "image_\(timestamp).png"
        case .gif:
            return "image_\(timestamp).gif"
        case .heic:
            return "image_\(timestamp).heic"
        case .webP:
            return "image_\(timestamp).webp"
        case .jpeg:
            return "image_\(timestamp).jpg"
        default:
            // Try to get extension from UTType
            if let ext = type.preferredFilenameExtension {
                return "image_\(timestamp).\(ext)"
            }
            return "image_\(timestamp).jpg"
        }
    }

    /// Generate a default image filename (JPEG)
    static func generateDefaultImageFileName() -> String {
        return "image_\(Int(Date().timeIntervalSince1970)).jpg"
    }

    // MARK: - URL Push Document

    /// Create a push document for a URL in Firestore
    static func createURLPushDocument(
        firestore: Firestore,
        url: String,
        userId: String
    ) async throws {
        let deviceName = getDeviceName()
        let title = url // Will be updated by title scraper
        let searchTokens = SearchTokenGenerator.generate(from: title)
        let ext = URL(string: url)?.pathExtension

        var pushData: [String: Any] = [
            "url": url,
            "userId": userId,
            "createdAt": FieldValue.serverTimestamp(),
            "title": title,
            "type": "url",
            "deviceName": deviceName,
            "searchTokens": searchTokens
        ]

        if let ext = ext, !ext.isEmpty {
            pushData["ext"] = ext
        }

        try await firestore.collection("pushes").addDocument(data: pushData)
    }

    /// Callback-based version for share extension compatibility
    static func createURLPushDocument(
        firestore: Firestore,
        url: String,
        userId: String,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        Task {
            do {
                try await createURLPushDocument(firestore: firestore, url: url, userId: userId)
                completion(.success(()))
            } catch {
                completion(.failure(error))
            }
        }
    }

    // MARK: - Complete Upload Flow

    /// Upload file data to Firebase Storage and create a Firestore document
    /// - Returns: The download URL on success
    static func uploadFileAndCreateDocument(
        data: Data,
        fileName: String,
        userId: String,
        type: String = "file",
        storage: Storage,
        firestore: Firestore
    ) async throws -> String {
        // Get unique storage path
        let (storagePath, finalFileName) = await getUniqueStorageRef(
            storage: storage,
            userId: userId,
            fileName: fileName
        )

        // Upload to Storage
        let storageRef = storage.reference().child(storagePath)
        let metadata = StorageMetadata()
        metadata.contentType = mimeType(for: fileName)

        _ = try await storageRef.putDataAsync(data, metadata: metadata)
        let downloadURL = try await storageRef.downloadURL()

        // Create Firestore document
        try await createPushDocument(
            firestore: firestore,
            downloadURL: downloadURL.absoluteString,
            fileName: finalFileName,
            userId: userId,
            type: type
        )

        return downloadURL.absoluteString
    }

    /// Callback-based version for share extension compatibility
    static func uploadFileAndCreateDocument(
        data: Data,
        fileName: String,
        userId: String,
        type: String = "file",
        storage: Storage,
        firestore: Firestore,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        Task {
            do {
                let url = try await uploadFileAndCreateDocument(
                    data: data,
                    fileName: fileName,
                    userId: userId,
                    type: type,
                    storage: storage,
                    firestore: firestore
                )
                completion(.success(url))
            } catch {
                completion(.failure(error))
            }
        }
    }

    /// Create a push document in Firestore
    static func createPushDocument(
        firestore: Firestore,
        downloadURL: String,
        fileName: String,
        userId: String,
        type: String = "file"
    ) async throws {
        let deviceName = getDeviceName()
        let ext = (fileName as NSString).pathExtension
        let searchTokens = SearchTokenGenerator.generate(from: fileName)

        var pushData: [String: Any] = [
            "url": downloadURL,
            "userId": userId,
            "createdAt": FieldValue.serverTimestamp(),
            "title": fileName,
            "type": type,
            "deviceName": deviceName,
            "searchTokens": searchTokens
        ]

        if !ext.isEmpty {
            pushData["ext"] = ext
        }

        try await firestore.collection("pushes").addDocument(data: pushData)
    }

    // MARK: - Unique Filename Generation

    /// Generate a unique filename by appending (1), (2), etc. if the original exists
    /// Handles cases where the name already has a number suffix like "file (1).jpg"
    static func generateUniqueFileName(originalName: String, attempt: Int) -> String {
        if attempt == 0 {
            return originalName
        }

        let name = (originalName as NSString).deletingPathExtension
        let ext = (originalName as NSString).pathExtension

        // Check if name already ends with a number pattern like " (1)" or " (2)"
        // If so, extract base name and add attempt to existing number
        let pattern = #"^(.+) \((\d+)\)$"#
        if let regex = try? NSRegularExpression(pattern: pattern),
           let match = regex.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)),
           let baseRange = Range(match.range(at: 1), in: name),
           let numRange = Range(match.range(at: 2), in: name),
           let existingNum = Int(name[numRange]) {
            let baseName = String(name[baseRange])
            let newNum = existingNum + attempt
            if ext.isEmpty {
                return "\(baseName) (\(newNum))"
            } else {
                return "\(baseName) (\(newNum)).\(ext)"
            }
        }

        // No existing number suffix, just append the attempt
        if ext.isEmpty {
            return "\(name) (\(attempt))"
        } else {
            return "\(name) (\(attempt)).\(ext)"
        }
    }

    /// Check if a file exists at the given storage path
    static func checkFileExists(storage: Storage, storagePath: String) async -> Bool {
        let ref = storage.reference().child(storagePath)
        do {
            _ = try await ref.getMetadata()
            return true
        } catch {
            return false
        }
    }

    /// Get a unique storage reference, trying original name first then (1), (2), etc.
    static func getUniqueStorageRef(storage: Storage, userId: String, fileName: String) async -> (storagePath: String, finalFileName: String) {
        var attempt = 0

        while true {
            let uniqueFileName = generateUniqueFileName(originalName: fileName, attempt: attempt)
            let storagePath = "uploads/\(userId)/\(uniqueFileName)"

            let exists = await checkFileExists(storage: storage, storagePath: storagePath)
            if !exists {
                return (storagePath, uniqueFileName)
            }
            attempt += 1
        }
    }

    /// Callback-based version for share extension compatibility
    static func getUniqueStorageRef(storage: Storage, userId: String, fileName: String, completion: @escaping (String, String) -> Void) {
        Task {
            let result = await getUniqueStorageRef(storage: storage, userId: userId, fileName: fileName)
            completion(result.storagePath, result.finalFileName)
        }
    }

    // MARK: - MIME Type

    /// Get the MIME type for a filename based on its extension
    static func mimeType(for fileName: String) -> String {
        let ext = (fileName as NSString).pathExtension.lowercased()
        let mimeTypes: [String: String] = [
            // Images
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "png": "image/png",
            "gif": "image/gif",
            "heic": "image/heic",
            "heif": "image/heif",
            "webp": "image/webp",
            "tiff": "image/tiff",
            "tif": "image/tiff",
            "bmp": "image/bmp",
            "svg": "image/svg+xml",
            // Videos
            "mp4": "video/mp4",
            "mov": "video/quicktime",
            "m4v": "video/x-m4v",
            "avi": "video/x-msvideo",
            "mkv": "video/x-matroska",
            "webm": "video/webm",
            // Audio
            "mp3": "audio/mpeg",
            "m4a": "audio/mp4",
            "wav": "audio/wav",
            "aac": "audio/aac",
            // Documents
            "pdf": "application/pdf",
            "txt": "text/plain",
            "html": "text/html",
            "json": "application/json",
            "xml": "application/xml",
            // Archives
            "zip": "application/zip",
            "rar": "application/x-rar-compressed",
            "7z": "application/x-7z-compressed",
            // Office
            "doc": "application/msword",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xls": "application/vnd.ms-excel",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "ppt": "application/vnd.ms-powerpoint",
            "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        ]
        return mimeTypes[ext] ?? "application/octet-stream"
    }
}
