import Foundation
import FirebaseStorage

/// Fetches an encrypted file push's object and opens it into a local file (docs/e2ee.md,
/// "Files"). The object is read through the Storage SDK by its `objectPath`, with the
/// user's own auth: no download URL is stored for an encrypted push, and the Storage rules
/// already limit reads to the owner.
///
/// The app then presents the file the way it opens a download: QuickLook on iOS,
/// `NSWorkspace` on macOS. This file is the same in `apps/ios` and `apps/macos`.
enum PushFileOpener {
    enum OpenError: LocalizedError {
        case notDecrypted
        case notDownloaded

        var errorDescription: String? {
            switch self {
            case .notDecrypted: return "This file could not be decrypted."
            case .notDownloaded: return "This file could not be downloaded."
            }
        }
    }

    /// Where opened files go. Emptied before each open, so the cache holds at most the file
    /// last opened, which the viewer may still be showing.
    private static var root: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("OpenedPushes", isDirectory: true)
    }

    /// The push's file, decrypted into the cache under its own name. A migrated push
    /// (`legacyPlain`) is the plaintext upload and is only downloaded. Whatever fails, no
    /// partial file is left: `E2eeCrypto.decryptFile` removes its output, and the folder
    /// goes with it.
    static func localFile(file: PushFile, objectPath: String, storage: Storage) async throws -> URL {
        try? FileManager.default.removeItem(at: root)
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let downloaded = folder.appendingPathComponent("download")
        let output = folder.appendingPathComponent(safeName(file.name))

        do {
            _ = try await storage.reference(withPath: objectPath).writeAsync(toFile: downloaded)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            print("Failed to download \(objectPath): \(error)")
            throw OpenError.notDownloaded
        }

        if file.legacyPlain {
            try FileManager.default.moveItem(at: downloaded, to: output)
            return output
        }
        guard let fk = file.fk, let np = file.np else { throw OpenError.notDecrypted }
        do {
            try await Task.detached(priority: .userInitiated) {
                try E2eeCrypto.decryptFile(fk: fk, np: np, source: downloaded, destination: output)
            }.value
            try? FileManager.default.removeItem(at: downloaded)
            return output
        } catch {
            try? FileManager.default.removeItem(at: folder)
            print("Failed to decrypt \(objectPath): \(error)")
            throw OpenError.notDecrypted
        }
    }

    /// The envelope's name as a file name: one path component, never empty.
    static func safeName(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "file" : cleaned
    }
}
