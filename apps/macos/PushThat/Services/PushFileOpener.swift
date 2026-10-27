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

    /// On sign-out: no decrypted file outlives the session it was opened in, whoever uses the
    /// device next (on a Mac, any account on it).
    static func clear() {
        try? FileManager.default.removeItem(at: root)
    }

    /// The push's file, decrypted into the cache under its own name. A migrated push
    /// (`legacyPlain`) is the plaintext upload and is only downloaded. Whatever fails, no
    /// partial file is left: `E2eeCrypto.decryptFile` removes its output, and the folder
    /// goes with it.
    static func localFile(file: PushFile, objectPath: String, storage: Storage) async throws -> URL {
        try? FileManager.default.removeItem(at: root)
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // Beside the folder, not in it: the folder holds the file under the envelope's name,
        // which comes from another device and can be any name at all, "download" included,
        // and decrypting a file onto itself truncates what it is reading.
        let downloaded = root.appendingPathComponent(UUID().uuidString + ".download")
        let output = folder.appendingPathComponent(safeName(file.name))
        let discard = {
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.removeItem(at: downloaded)
        }

        do {
            _ = try await storage.reference(withPath: objectPath).writeAsync(toFile: downloaded)
        } catch {
            discard()
            // Not the path or the error: a migrated push's path is its file's name.
            print("Failed to download a push's file: \(type(of: error))")
            throw OpenError.notDownloaded
        }

        if file.legacyPlain {
            do {
                try FileManager.default.moveItem(at: downloaded, to: output)
            } catch {
                discard()
                throw OpenError.notDownloaded
            }
            return output
        }
        guard let fk = file.fk, let np = file.np else {
            discard()
            throw OpenError.notDecrypted
        }
        do {
            try await Task.detached(priority: .userInitiated) {
                try E2eeCrypto.decryptFile(fk: fk, np: np, source: downloaded, destination: output)
            }.value
            try? FileManager.default.removeItem(at: downloaded)
            return output
        } catch {
            discard()
            print("Failed to decrypt a push's file: \(type(of: error))")
            throw OpenError.notDecrypted
        }
    }

    /// The envelope's name as a file name: one path component, never empty, and short enough
    /// for the file system's 255 bytes, cut before its extension as Android cuts it, so that
    /// an overlong name opens instead of failing as if the file did not decrypt.
    static func safeName(_ name: String) -> String {
        let cleaned = name
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .replacingOccurrences(of: "\0", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty || cleaned.allSatisfy({ $0 == "." }) { return "file" }
        if cleaned.utf8.count <= 120 { return cleaned }
        let ext = prefix((cleaned as NSString).pathExtension, bytes: 32)
        let base = prefix((cleaned as NSString).deletingPathExtension, bytes: 180)
        return ext.isEmpty ? base : base + "." + ext
    }

    /// The longest run of whole characters from the start of `s` that fits in `bytes` of UTF-8.
    private static func prefix(_ s: String, bytes: Int) -> String {
        var out = ""
        var used = 0
        for character in s {
            used += character.utf8.count
            if used > bytes { break }
            out.append(character)
        }
        return out
    }
}
