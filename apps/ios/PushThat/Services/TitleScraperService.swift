import Foundation
import FirebaseFirestore

/// Fills in the title and the icon of an encrypted URL push from the page itself
/// (docs/e2ee.md, "Titles" and "Icons"). No server fetches them, since a server that
/// fetched the URL would know it: a push goes out with an empty title and a native device
/// writes the title back, for its own pushes and for one it received untitled (a web push,
/// which has no way to read a cross-origin page). The icon comes in the same pass, so that
/// no device has to ask anyone for it in order to draw the list.
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

    /// Scrapes the page and rewrites the push's envelope with what it found
    /// (`PushDocuments.retitle`), only under the push's own key version. A push that already
    /// has an icon does not fetch another, since it keeps the one it has either way. A
    /// failure is logged; the push keeps showing what it showed.
    func scrapeAndUpdate(pushId: String, keyVersion: Int?, url: String, hasIcon: Bool, keys: PushKeys) async {
        guard keyVersion == keys.keyVersion, attempted.insert(pushId).inserted else { return }
        guard let page = await scrape(from: url, withIcon: !hasIcon), page.title != nil || page.icon != nil else { return }
        do {
            try await PushDocuments.retitle(firestore: db, keys: keys, pushId: pushId, title: page.title, icon: page.icon)
        } catch {
            print("Failed to update title: \(type(of: error))")
        }
    }

    /// How much of a page is read for its title and its icon links.
    private static let maxPageBytes = 256 * 1024

    /// How long the icon candidates are tried for, after the page.
    private static let iconBudget: TimeInterval = 30

    /// Sent with the page's request and its icons' alike, so the site sees one browser.
    private static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"

    /// The page's title and, when `withIcon`, its icon (`PushIcon`), or nil when the URL is
    /// not an HTML page that answered. The title is nil when the page has none this reads.
    private func scrape(from urlString: String, withIcon: Bool) async -> (title: String?, icon: String?)? {
        guard let url = URL(string: urlString) else { return nil }

        do {
            var request = URLRequest(url: url)
            request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
            request.timeoutInterval = 10

            // Streamed, not `data(for:)`: the pushes left untitled are mostly links to files
            // (PDFs, video, archives), which have no title to find, and the list asks for
            // every one it shows. Only an HTML page is read, and only its first 256 KiB, where
            // the <title> is; `timeoutInterval` bounds a stall, not a download, so without the
            // cap a large file would be pulled into memory on every launch. Nor is an icon
            // looked for on anything but a page: a link to a file shows its type's icon.
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
            // The header's charset, else UTF-8, decoded strictly: a page in an encoding this
            // cannot read gets no title, rather than a garbled one written into the push for
            // every device. Up to three bytes are dropped first, the most the cap can cut from
            // a character, so a page cut mid-character still reads. Such a page has no icon
            // links to read either, but its origin's /favicon.ico is still a candidate.
            let encoding = httpResponse.textEncodingName
                .map { CFStringConvertIANACharSetNameToEncoding($0 as CFString) }
                .flatMap { $0 == kCFStringEncodingInvalidId ? nil : String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding($0)) }
                ?? .utf8
            let html = (0...3).lazy.compactMap({ String(data: data.dropLast($0), encoding: encoding) }).first ?? ""

            // Icons resolve against the URL the page came from after redirects, as a
            // browser resolves them, not against the one that was pushed.
            let icon = withIcon ? await fetchIcon(from: PushIcon.candidates(html: html, pageURL: httpResponse.url ?? url)) : nil
            return (extractTitle(from: html), icon)
        } catch {
            // The error's type only: a URLError carries the page's full URL.
            print("Failed to scrape title: \(type(of: error))")
            return nil
        }
    }

    /// The icon made from the first candidate that ImageIO opens (`PushIcon.encode`), or
    /// nil when none opens or the one that does is too large even at 32 by 32. One at a
    /// time, best first, so a page whose first candidate is good costs one request more
    /// than its title.
    private func fetchIcon(from candidates: [URL]) async -> String? {
        // A budget for the lot, checked between candidates and while one downloads:
        // `timeoutInterval` bounds a gap between bytes, not a request, so a server sending a
        // byte every few seconds held one open indefinitely, and there can be nine.
        let deadline = Date().addingTimeInterval(Self.iconBudget)
        for candidate in candidates {
            guard !Task.isCancelled, Date() < deadline else { return nil }
            guard let data = await download(candidate, until: deadline) else { continue }
            switch PushIcon.encode(data) {
            case let .icon(icon): return icon
            case .tooLarge: return nil
            case .undecodable: continue
            }
        }
        return nil
    }

    /// A candidate's bytes, or nil when it does not answer 200 or is over
    /// `PushIcon.maxDownloadBytes`. Streamed as the page is, so a large file is given up at
    /// the cap rather than pulled into memory first.
    private func download(_ url: URL, until deadline: Date) async -> Data? {
        var request = URLRequest(url: url)
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 10
        do {
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200,
                  httpResponse.expectedContentLength <= Int64(PushIcon.maxDownloadBytes)
            else { return nil }
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
                if data.count > PushIcon.maxDownloadBytes { return nil }
                if data.count % 4096 == 0, Task.isCancelled || Date() >= deadline { return nil }
            }
            return data
        } catch {
            // The error's type only, as for the page: a URLError carries the full URL.
            print("Failed to fetch icon: \(type(of: error))")
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
