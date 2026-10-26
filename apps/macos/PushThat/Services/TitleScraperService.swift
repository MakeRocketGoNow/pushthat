import Foundation
import FirebaseFirestore

/// Service for scraping webpage titles
/// Matches the Android TitleScrapingWorker behavior
actor TitleScraperService {
    static let shared = TitleScraperService()

    private let db = Firestore.firestore()

    private init() {}

    /// Scrape the title from a URL and update the Firestore document
    func scrapeAndUpdate(documentId: String, url: String) async {
        guard let title = await scrapeTitle(from: url) else { return }

        // Update the document with the new title
        let searchTokens = SearchTokenGenerator.generate(from: title)

        do {
            try await db.collection("pushes").document(documentId).updateData([
                "title": title,
                "searchTokens": searchTokens
            ])
        } catch {
            print("Failed to update title: \(error)")
        }
    }

    /// Scrape the title from a URL
    func scrapeTitle(from urlString: String) async -> String? {
        guard let url = URL(string: urlString) else { return nil }

        do {
            var request = URLRequest(url: url)
            request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", forHTTPHeaderField: "User-Agent")
            request.timeoutInterval = 10

            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200,
                  let html = String(data: data, encoding: .utf8) else {
                return nil
            }

            return extractTitle(from: html)
        } catch {
            print("Failed to scrape title: \(error)")
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
