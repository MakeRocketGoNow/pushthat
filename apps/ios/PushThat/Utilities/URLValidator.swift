import Foundation

/// URL validation utilities
/// Matches Android's Apache Commons Validator behavior
struct URLValidator {

    /// Validates if a string is a valid HTTP/HTTPS URL
    static func isValidURL(_ string: String) -> Bool {
        var urlString = string.trimmingCharacters(in: .whitespacesAndNewlines)

        // Add https:// if no scheme present
        if !urlString.hasPrefix("http://") && !urlString.hasPrefix("https://") {
            urlString = "https://\(urlString)"
        }

        guard let url = URL(string: urlString) else {
            return false
        }

        // Check for valid scheme
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return false
        }

        // Check for valid host
        guard let host = url.host, !host.isEmpty else {
            return false
        }

        // Basic domain validation
        let hostComponents = host.split(separator: ".")
        guard hostComponents.count >= 2 else {
            return false
        }

        return true
    }

    /// Normalizes a URL string by adding https:// if needed
    static func normalize(_ string: String) -> String {
        var urlString = string.trimmingCharacters(in: .whitespacesAndNewlines)

        if !urlString.hasPrefix("http://") && !urlString.hasPrefix("https://") {
            urlString = "https://\(urlString)"
        }

        return urlString
    }

    /// Extracts the file extension from a URL string
    static func extractExtension(from urlString: String) -> String? {
        guard let url = URL(string: urlString) else { return nil }
        let ext = url.pathExtension
        return ext.isEmpty ? nil : ext.lowercased()
    }

    /// Extracts the host/domain from a URL string
    static func extractHost(from urlString: String) -> String? {
        guard let url = URL(string: urlString) else { return nil }
        return url.host
    }
}
