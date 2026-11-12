import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif

/// The icon for a pushed link, fetched by this device from the linked site itself.
///
/// The list used to load `google.com/s2/favicons?domain=<host>` for every link, which told
/// Google the domain of everything a user pushed. Pushes are end-to-end encrypted, so that
/// lookup undid part of the point. Now the icon comes from the site the user is about to
/// open anyway: the origin's root page is read for a `<link rel="icon">` (or
/// `apple-touch-icon`), and `/favicon.ico` stands in when it names none. Nothing goes
/// through our server or any third party.
///
/// Results are kept per origin, in memory only, for as long as the process runs, so a row
/// that scrolls back or re-renders shows its icon at once and never fetches it again. Not
/// on disk: a plaintext list of the hosts someone has pushed would sit beside an encrypted
/// push list. `clear()` drops it on sign-out and account deletion.
///
/// This file is the same in `apps/ios` and `apps/macos`.
final class FaviconResolver: @unchecked Sendable {
    static let shared = FaviconResolver()

    /// A decoded icon. A class so it can cross from the fetching task to the view: `NSImage`
    /// is not `Sendable`, and the image is never changed once made.
    final class Icon: @unchecked Sendable {
        let image: PlatformImage
        init(_ image: PlatformImage) { self.image = image }
    }

    private enum Entry {
        case icon(Icon)
        /// Looked up and nothing loaded: the placeholder, without asking again.
        case none
    }

    private let lock = NSLock()
    private var resolved: [String: Entry] = [:]
    private var inFlight: [String: Task<Icon?, Never>] = [:]
    /// Moved on by `clear()`, so a lookup that finishes after a sign-out does not put the
    /// previous account's host back into the cache.
    private var generation = 0

    /// No cookies, no stored credentials, no disk cache: the site learns that this device
    /// wants its icon and nothing that ties the request to a session there. Short timeouts,
    /// since an icon is decoration and a slow site should fall to the placeholder quickly.
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 10
        return URLSession(configuration: config)
    }()

    /// How much of the root page is read for its `<link>` tags, which sit in the `<head>`.
    private static let maxPageBytes = 256 * 1024
    /// An icon larger than this is not an icon worth holding in memory for a 40 pt square.
    private static let maxIconBytes = 1024 * 1024
    /// Declared icons tried before `/favicon.ico`, largest first.
    private static let maxCandidates = 3

    private init() {}

    /// `scheme://host[:port]/` for an http or https link; nil for anything else, which
    /// keeps the placeholder.
    static func origin(of url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty
        else { return nil }
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host.lowercased()
        parts.port = url.port
        parts.path = "/"
        return parts.url
    }

    /// The icon already resolved for this link's origin, without waiting: what a row shows
    /// on its first frame, so that one re-created by the list does not flash the placeholder.
    func cached(for url: URL) -> Icon? {
        guard let key = Self.origin(of: url)?.absoluteString else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if case let .icon(icon) = resolved[key] { return icon }
        return nil
    }

    /// The icon for this link's origin, fetched once per origin however many rows ask at
    /// the same time. Nil when the site offers none that loads.
    func icon(for url: URL) async -> Icon? {
        guard let origin = Self.origin(of: url) else { return nil }
        let key = origin.absoluteString
        let (task, generation) = startOrJoin(key: key, origin: origin)
        guard let task else { return cached(for: url) }
        let icon = await task.value
        finish(key: key, icon: icon, generation: generation)
        return icon
    }

    /// Forgets every origin. On sign-out and account deletion, so the next account on this
    /// device does not inherit the hosts the last one pushed.
    func clear() {
        lock.lock()
        defer { lock.unlock() }
        generation += 1
        inFlight.values.forEach { $0.cancel() }
        inFlight.removeAll()
        resolved.removeAll()
    }

    // MARK: - Bookkeeping

    /// The running lookup for `key`, started if there is none; nil once it has resolved.
    private func startOrJoin(key: String, origin: URL) -> (Task<Icon?, Never>?, Int) {
        lock.lock()
        defer { lock.unlock() }
        if resolved[key] != nil { return (nil, generation) }
        if let running = inFlight[key] { return (running, generation) }
        let task = Task { [session] in await Self.resolve(origin: origin, session: session) }
        inFlight[key] = task
        return (task, generation)
    }

    private func finish(key: String, icon: Icon?, generation: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard generation == self.generation else { return }
        inFlight[key] = nil
        if resolved[key] == nil {
            resolved[key] = icon.map(Entry.icon) ?? Entry.none
        }
    }

    // MARK: - Fetching

    private static func resolve(origin: URL, session: URLSession) async -> Icon? {
        for candidate in await declaredIcons(origin: origin, session: session).prefix(maxCandidates) {
            if Task.isCancelled { return nil }
            if let icon = await loadIcon(candidate, session: session) { return icon }
        }
        guard !Task.isCancelled, let fallback = URL(string: "/favicon.ico", relativeTo: origin)?.absoluteURL else { return nil }
        return await loadIcon(fallback, session: session)
    }

    /// No Referer is ever set (URLSession adds none of its own), so the request says which
    /// site it is for and nothing about where the user found the link.
    private static func request(_ url: URL) -> URLRequest {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // A browser's agent string: some sites answer the default CFNetwork one with an
        // error page, which would hide the icon they serve to everyone else.
        #if os(iOS)
        request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", forHTTPHeaderField: "User-Agent")
        #else
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", forHTTPHeaderField: "User-Agent")
        #endif
        return request
    }

    /// Reads at most `limit` bytes of a 200 response, streamed, so that a site answering
    /// with something huge costs no more than the cap.
    private static func read(_ url: URL, limit: Int, session: URLSession, accept: (HTTPURLResponse) -> Bool) async -> (Data, HTTPURLResponse)? {
        do {
            let (bytes, response) = try await session.bytes(for: request(url))
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, accept(http),
                  isWeb(http.url ?? url)
            else { return nil }
            var data = Data()
            for try await byte in bytes {
                data.append(byte)
                if data.count >= limit { break }
            }
            return (data, http)
        } catch {
            // Nothing logged: the error would carry the site's address.
            return nil
        }
    }

    private static func isWeb(_ url: URL) -> Bool {
        let scheme = url.scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    /// The icons the root page declares, largest first, resolved against the address the
    /// page was finally served from (a redirect to `www.` moves relative paths with it).
    private static func declaredIcons(origin: URL, session: URLSession) async -> [URL] {
        guard let (data, http) = await read(origin, limit: maxPageBytes, session: session, accept: {
            $0.mimeType?.lowercased().contains("html") == true
        }) else { return [] }
        // Lossy on purpose, unlike the title scraper: only ASCII markup is wanted here, and a
        // page cut mid-character at the cap still has its <head> intact.
        let html = String(decoding: data, as: UTF8.self)
        let base = http.url ?? origin
        return iconLinks(in: html)
            .sorted { $0.size > $1.size }
            .compactMap { link in
                guard let url = URL(string: link.href, relativeTo: base)?.absoluteURL, isWeb(url) else { return nil }
                return url
            }
    }

    private static func loadIcon(_ url: URL, session: URLSession) async -> Icon? {
        guard let (data, _) = await read(url, limit: maxIconBytes, session: session, accept: { response in
            // Some servers label icons loosely; refuse only what is plainly a page.
            !(response.mimeType?.lowercased().contains("html") ?? false)
        }), data.count < maxIconBytes, let image = PlatformImage(data: data), image.size.width > 0 else { return nil }
        return Icon(image)
    }

    // MARK: - Parsing

    struct IconLink: Equatable {
        let href: String
        /// The largest edge `sizes` declares; 0 when it declares none.
        let size: Int
    }

    private static let linkTag = try! NSRegularExpression(pattern: "<link\\b[^>]*>", options: .caseInsensitive)
    private static let attribute = try! NSRegularExpression(
        pattern: "([a-zA-Z_:-]+)\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))",
        options: []
    )

    /// `<link>` tags whose `rel` holds `icon` (which covers "shortcut icon") or
    /// `apple-touch-icon`. A regex, as the title scraper's is, rather than an HTML parser:
    /// `<link>` is a void tag with only attributes, which a pattern reads well enough, and a
    /// miss costs no more than the `/favicon.ico` fallback. SVG is skipped, since the
    /// platform images cannot draw it; so is `mask-icon`, a one-colour Safari tab shape.
    static func iconLinks(in html: String) -> [IconLink] {
        let whole = NSRange(html.startIndex..., in: html)
        return linkTag.matches(in: html, range: whole).compactMap { match in
            guard let tagRange = Range(match.range, in: html) else { return nil }
            let tag = String(html[tagRange])
            var attributes: [String: String] = [:]
            for found in attribute.matches(in: tag, range: NSRange(tag.startIndex..., in: tag)) {
                guard let nameRange = Range(found.range(at: 1), in: tag) else { continue }
                let value = (2...4).lazy.compactMap { Range(found.range(at: $0), in: tag) }.first.map { String(tag[$0]) } ?? ""
                attributes[tag[nameRange].lowercased()] = value
            }
            let rel = Set((attributes["rel"] ?? "").lowercased().split(whereSeparator: \.isWhitespace).map(String.init))
            let touch = rel.contains("apple-touch-icon") || rel.contains("apple-touch-icon-precomposed")
            guard rel.contains("icon") || touch else { return nil }
            guard let href = attributes["href"]?.trimmingCharacters(in: .whitespacesAndNewlines).decodingHTMLEntities(),
                  !href.isEmpty
            else { return nil }
            if attributes["type"]?.lowercased().contains("svg") == true || href.lowercased().hasSuffix(".svg") { return nil }
            // An apple-touch-icon with no sizes is 180 px by convention; a plain icon with
            // none is usually a 16 or 32 px favicon, so it loses to any declared size.
            let declared = largestEdge(attributes["sizes"])
            return IconLink(href: href, size: declared ?? (touch ? 180 : 0))
        }
    }

    /// "32x32 64x64" is 64; "any" (a scalable icon) counts as large. Nil when absent.
    private static func largestEdge(_ sizes: String?) -> Int? {
        guard let sizes = sizes?.lowercased(), !sizes.isEmpty else { return nil }
        if sizes.contains("any") { return 1024 }
        let edges = sizes.split(whereSeparator: \.isWhitespace).compactMap { size -> Int? in
            let parts = size.split(separator: "x")
            guard parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]) else { return nil }
            return max(w, h)
        }
        return edges.max()
    }
}

/// A pushed link's site icon, or the placeholder until (and unless) one loads.
struct SiteIconView<Placeholder: View>: View {
    let site: URL
    @ViewBuilder let placeholder: () -> Placeholder

    @State private var icon: FaviconResolver.Icon?

    init(site: URL, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.site = site
        self.placeholder = placeholder
        // Read synchronously, so a resolved icon is there on the first frame.
        _icon = State(initialValue: FaviconResolver.shared.cached(for: site))
    }

    var body: some View {
        Group {
            if let icon {
                platformImage(icon.image)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                placeholder()
            }
        }
        // Keyed by origin, not the full URL: two links to one site share the lookup.
        .task(id: FaviconResolver.origin(of: site)) {
            if let cached = FaviconResolver.shared.cached(for: site) {
                icon = cached
            } else {
                icon = await FaviconResolver.shared.icon(for: site)
            }
        }
    }

    private func platformImage(_ image: PlatformImage) -> Image {
        #if canImport(UIKit)
        Image(uiImage: image)
        #else
        Image(nsImage: image)
        #endif
    }
}
