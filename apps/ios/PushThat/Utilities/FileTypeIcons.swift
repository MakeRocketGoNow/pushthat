import Foundation

/// Maps file extensions to icons hosted on PushThat CDN
/// Matches the Android SUPPORTED_FILE_ICONS list exactly
struct FileTypeIcons {

    /// Set of supported file extensions that have custom icons
    static let supported: Set<String> = [
        "pproj", "zip", "indd", "csv", "css", "pdf", "aac", "png",
        "xls", "avi", "txt", "mp3", "tiff", "psd", "jpg", "jpeg",
        "mov", "html", "ai", "js", "flac", "mp4", "gif", "doc",
        "xml", "apk"
    ]

    /// Returns the URL for a file type icon, or nil if not supported
    static func iconURL(for fileExtension: String) -> URL? {
        let ext = fileExtension.lowercased()
        guard supported.contains(ext) else { return nil }
        return URL(string: "https://pushthat.link/files/\(ext).png")
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
