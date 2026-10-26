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

    // MARK: - File Size Validation

    /// Check if data exceeds the tier's maximum file size: 100 MB on Pro, 25 MB on Free, which the Storage rules enforce.
    static func exceedsMaxFileSize(_ data: Data, isPro: Bool) -> Bool {
        return exceedsMaxFileSize(bytes: Int64(data.count), isPro: isPro)
    }

    static func exceedsMaxFileSize(bytes: Int64, isPro: Bool) -> Bool {
        return bytes > PlanService.maxFileBytes(isPro: isPro)
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

    /// Creates an encrypted URL push (docs/e2ee.md, "The push envelope") and returns it, so
    /// a caller can scrape the title for it. The title starts empty and the list shows the
    /// URL until it is known; `ext` is the URL path's extension, as before.
    @discardableResult
    static func createURLPushDocument(
        firestore: Firestore,
        url: String,
        userId: String
    ) async throws -> PreparedPush {
        let keys = try PushDocuments.keys(for: userId)
        let ext = URL(string: url)?.pathExtension ?? ""
        let push = try PushDocuments.prepareURLPush(firestore: firestore, keys: keys, url: url, ext: ext)
        try await PushDocuments.create(push, firestore: firestore)
        return push
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

    /// Encrypts the file with its own key, uploads the ciphertext under a random name, and
    /// creates the encrypted push that carries the key (docs/e2ee.md, "Files"). The bytes
    /// are sealed a chunk at a time into a temporary file, so the ciphertext is never a
    /// second copy of the file in memory.
    static func uploadFileAndCreateDocument(
        data: Data,
        fileName: String,
        userId: String,
        type: String = "file",
        storage: Storage,
        firestore: Firestore
    ) async throws {
        let keys = try PushDocuments.keys(for: userId)
        try await PushDocuments.uploadFilePush(
            keys: keys, name: fileName, mime: mimeType(for: fileName), size: Int64(data.count),
            storage: storage, firestore: firestore
        ) { fk, prefix, destination in
            try E2eeCrypto.encryptFile(fk: fk, prefix: prefix, data: data, destination: destination)
        }
    }

    /// The same, streaming from a file on disk instead of bytes in memory.
    static func uploadFileAndCreateDocument(
        fileURL: URL,
        fileName: String,
        userId: String,
        storage: Storage,
        firestore: Firestore
    ) async throws {
        let keys = try PushDocuments.keys(for: userId)
        let size = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize).flatMap { $0 }.map(Int64.init) ?? 0
        try await PushDocuments.uploadFilePush(
            keys: keys, name: fileName, mime: mimeType(for: fileName), size: size,
            storage: storage, firestore: firestore
        ) { fk, prefix, destination in
            try E2eeCrypto.encryptFile(fk: fk, prefix: prefix, source: fileURL, destination: destination)
        }
    }

    /// Callback-based version for share extension compatibility
    static func uploadFileAndCreateDocument(
        data: Data,
        fileName: String,
        userId: String,
        type: String = "file",
        storage: Storage,
        firestore: Firestore,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        Task {
            do {
                try await uploadFileAndCreateDocument(
                    data: data,
                    fileName: fileName,
                    userId: userId,
                    type: type,
                    storage: storage,
                    firestore: firestore
                )
                completion(.success(()))
            } catch {
                completion(.failure(error))
            }
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
