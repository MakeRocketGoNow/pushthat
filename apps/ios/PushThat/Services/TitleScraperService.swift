import Foundation
import FirebaseFirestore

/// Fills in the title of an encrypted URL push from the page itself (docs/e2ee.md,
/// "Titles"). No server fetches it, since a server that fetched the URL would know it: a
/// push goes out with an empty title and a native device writes the title back, for its
/// own pushes and for one it received untitled (a web push, which has no way to read a
/// cross-origin page).
///
/// The app calls it for every untitled URL push the list shows, whoever made it, which
/// covers the share extension's pushes (the extension is gone before a page could answer)
/// and those received while the app was not running (the notification service extension
/// has neither the time nor Firestore to do it). Each push is tried once per process, so
/// a page with no title is not fetched on every refresh.
actor TitleScraperService {
    static let shared = TitleScraperService()

    private let db = Firestore.firestore()
    private var attempted = Set<String>()

    private init() {}

    /// Scrapes the page's title and rewrites the push's envelope with it: exactly `enc` and
    /// `searchTokens`, only under the push's own key version (`PushDocuments.retitle`). A
    /// failure is logged; the push keeps showing its URL.
    func scrapeAndUpdate(pushId: String, userId: String, keyVersion: Int?, url: String, ext: String, keys: PushKeys) async {
        guard keyVersion == keys.keyVersion, attempted.insert(pushId).inserted else { return }
        guard let title = await scrapeTitle(from: url), !title.isEmpty else { return }
        do {
            try await PushDocuments.retitle(
                firestore: db, keys: keys, pushId: pushId, userId: userId,
                keyVersion: keyVersion, url: url, ext: ext, title: title
            )
        } catch {
            print("Failed to update title: \(type(of: error))")
        }
    }

    /// How much of a page is read for its title.
    private static let maxPageBytes = 256 * 1024

    /// Scrape the title from a URL
    func scrapeTitle(from urlString: String) async -> String? {
        guard let url = URL(string: urlString) else { return nil }

        do {
            var request = URLRequest(url: url)
            request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
            request.timeoutInterval = 10

            // Streamed, not `data(for:)`: the pushes left untitled are mostly links to files
            // (PDFs, video, archives), which have no title to find, and the list asks for
            // every one it shows. Only an HTML page is read, and only its first 256 KiB, where
            // the <title> is; `timeoutInterval` bounds a stall, not a download, so without the
            // cap a large file would be pulled into memory on every launch.
            let (bytes, response) = try await URLSession.shared.bytes(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200,
                  httpResponse.mimeType?.lowercased().contains("html") == true else {
                return nil
            }

            var data = Data()
            for try await byte in bytes {
                data.append(byte)
                if data.count >= Self.maxPageBytes { break }
            }
            // Lossy, since the cap can cut a UTF-8 sequence in two.
            let html = String(decoding: data, as: UTF8.self)

            return extractTitle(from: html)
        } catch {
            // The error's type only: a URLError carries the page's full URL.
            print("Failed to scrape title: \(type(of: error))")
            return nil
        }
    }

    /// Extract title from HTML using regex
    /// Note: For production, consider using SwiftSoup for proper HTML parsing
    private func extractTitle(from html: String) -> String? {
        // Try to find <title> tag
        let titlePattern = "<title[^>]*>([^<]+)</title>"

        guard let regex = try? NSRegularExpression(pattern: titlePattern, options: .caseInsensitive),
              let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
              let titleRange = Range(match.range(at: 1), in: html) else {
            return nil
        }

        let title = String(html[titleRange])
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)

        // Decode HTML entities
        return title.decodingHTMLEntities()
    }
}

// MARK: - String HTML Entity Decoding
extension String {
    func decodingHTMLEntities() -> String {
        var result = self

        let entities: [String: String] = [
            "&amp;": "&",
            "&lt;": "<",
            "&gt;": ">",
            "&quot;": "\"",
            "&apos;": "'",
            "&#39;": "'",
            "&nbsp;": " ",
            "&ndash;": "-",
            "&mdash;": "-",
            "&copy;": "(c)",
            "&reg;": "(r)"
        ]

        for (entity, replacement) in entities {
            result = result.replacingOccurrences(of: entity, with: replacement)
        }

        // Handle numeric entities like &#8217;
        let numericPattern = "&#(\\d+);"
        if let regex = try? NSRegularExpression(pattern: numericPattern) {
            let range = NSRange(result.startIndex..., in: result)
            result = regex.stringByReplacingMatches(
                in: result,
                range: range,
                withTemplate: ""
            )
        }

        return result
    }
}
