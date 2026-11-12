import Foundation

/// The file types with an icon of their own, drawn from the app's asset catalog as
/// `file-<ext>` (copies of `apps/web/public/files/<ext>.png`). Matches the Android list.
///
/// They were loaded from pushthat.link/files, which put the type of every encrypted file a
/// list showed in the hosting logs (docs/e2ee.md, "Icons"); shipped in the app, drawing
/// one asks nobody anything.
struct FileTypeIcons {

    /// The extensions that have an icon. The one list: an extension added here needs its
    /// `file-<ext>` image set in Assets.xcassets, in both apps.
    static let supported: Set<String> = [
        "pproj", "zip", "indd", "csv", "css", "pdf", "aac", "png",
        "xls", "avi", "txt", "mp3", "tiff", "psd", "jpg", "jpeg",
        "mov", "html", "ai", "js", "flac", "mp4", "gif", "doc",
        "xml", "apk"
    ]

    /// The asset catalog name of the icon for `fileExtension`, or nil when it has none.
    static func assetName(for fileExtension: String?) -> String? {
        guard let ext = fileExtension?.lowercased(), supported.contains(ext) else { return nil }
        return "file-\(ext)"
    }

    /// Returns a SF Symbol name appropriate for the file type
    static func systemIcon(for fileExtension: String) -> String {
        let ext = fileExtension.lowercased()

        switch ext {
        // Documents
        case "pdf":
            return "doc.richtext"
        case "doc", "docx":
            return "doc.text"
        case "xls", "xlsx", "csv":
            return "tablecells"
        case "txt":
            return "doc.plaintext"

        // Images
        case "jpg", "jpeg", "png", "gif", "tiff", "psd", "ai":
            return "photo"

        // Audio
        case "mp3", "aac", "flac":
            return "waveform"

        // Video
        case "mp4", "mov", "avi":
            return "film"

        // Code
        case "html", "css", "js", "xml":
            return "chevron.left.forwardslash.chevron.right"

        // Archives
        case "zip":
            return "doc.zipper"

        // Apps
        case "apk":
            return "app"

        // Adobe
        case "pproj", "indd":
            return "square.stack.3d.up"

        default:
            return "doc"
        }
    }
}
