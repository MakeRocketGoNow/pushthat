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
        /// The session the open started in ended before it finished (`clear()`). Nothing
        /// it wrote is left, and the caller shows nothing: not the file, and no error to
        /// whoever is at the device now.
        case signedOut

        var errorDescription: String? {
            switch self {
            case .notDecrypted: return "This file could not be decrypted."
            case .notDownloaded: return "This file could not be downloaded."
            case .signedOut: return "You signed out before this file opened."
            }
        }
    }

    /// Where opened files go. Emptied before each open, so the cache holds at most the file
    /// last opened, which the viewer may still be showing.
    private static var root: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("OpenedPushes", isDirectory: true)
    }

    /// Moved on by every `clear()`. An open notes it when it starts and checks it after the
    /// download and after the decrypt: either can finish after a sign-out has emptied the
    /// cache, and without the check it would write a decrypted file into whatever session
    /// came next, and the app would show it there. A cancelled task would not do: the
    /// decrypt runs detached and does not look at cancellation, and sign-out does not know
    /// which open to cancel.
    ///
    /// On the main actor, as `clear()` and the callers are, so that the check after the
    /// decrypt and the caller's use of the file are not split by a sign-out.
    @MainActor private(set) static var session = 0

    /// On sign-out: no decrypted file outlives the session it was opened in, whoever uses the
    /// device next (on a Mac, any account on it), and no open still running writes one.
    @MainActor static func clear() {
        session += 1
        try? FileManager.default.removeItem(at: root)
    }

    /// The push's file, decrypted into the cache under its own name. A migrated push
    /// (`legacyPlain`) is the plaintext upload and is only downloaded. Whatever fails, no
    /// partial file is left: `E2eeCrypto.decryptFile` removes its output, and the folder
    /// goes with it. An open a sign-out overtook (`session`) removes what it wrote and
    /// throws `OpenError.signedOut`.
    @MainActor static func localFile(file: PushFile, objectPath: String, storage: Storage) async throws -> URL {
        let started = session
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
        // Checked in the failure paths too: a sign-out that empties the cache mid-download
        // or mid-decrypt makes that step fail, and the error is not for the next session.
        let checkSession = {
            guard session == started else {
                discard()
                throw OpenError.signedOut
            }
        }

        do {
            _ = try await storage.reference(withPath: objectPath).writeAsync(toFile: downloaded)
        } catch {
            discard()
            try checkSession()
            // Not the path or the error: a migrated push's path is its file's name.
            print("Failed to download a push's file: \(type(of: error))")
            throw OpenError.notDownloaded
        }
        try checkSession()

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
        } catch {
            discard()
            try checkSession()
            print("Failed to decrypt a push's file: \(type(of: error))")
            throw OpenError.notDecrypted
        }
        try checkSession()
        return output
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
