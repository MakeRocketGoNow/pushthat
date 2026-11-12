import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What a push's envelope holds (docs/e2ee.md, "The push envelope"), and the keys this
/// device seals and opens it with. Foundation, CryptoKit, Security and ImageIO only: the
/// app, the share extension, the notification service extension and the tests all compile
/// it, and only the first two have Firestore.
///
/// This file is the same in `apps/ios` and `apps/macos`.
enum PushContent: Equatable {
    /// `icon` is the site's icon (`PushIcon`), nil when the push has none. It defaults to
    /// nil so that a push made before a page is read, which is every push at creation, need
    /// not say so.
    case url(url: String, title: String, ext: String, icon: String? = nil)
    case file(PushFile)

    enum ContentError: LocalizedError {
        /// The sealed push is over the rules' bound on `enc.ct`. Only an absurd URL reaches
        /// it once the title is cut, so it is said as the generic push failure.
        case tooLarge
        case malformed

        var errorDescription: String? {
            switch self {
            case .tooLarge: return "This push is too large to send."
            case .malformed: return "This push could not be read."
            }
        }
    }

    /// The longest title a push carries. The page title is display text, and a cut one
    /// keeps a long URL's push inside the rules' bound on the ciphertext.
    static let maxTitleLength = 1000

    var type: String {
        switch self {
        case .url: return "url"
        case .file: return "file"
        }
    }

    /// What the blind index is made from: a URL push's title and URL together, so a push
    /// with no title yet is found by its host and path, and a file push's name. The title is
    /// cut as the envelope cuts it, so no push is found by words it does not hold, and an
    /// overlong title cannot crowd the URL's tokens out of the 3000.
    var searchText: String {
        switch self {
        case let .url(url, title, _, _): return String(title.prefix(Self.maxTitleLength)) + " " + url
        case let .file(file): return file.name
        }
    }

    /// The envelope's plaintext. The spec fixes no canonical form: this is whatever
    /// `JSONSerialization` writes, and a reader parses whatever it finds.
    func json() throws -> Data {
        let object: [String: Any]
        switch self {
        case let .url(url, title, ext, icon):
            var fields: [String: Any] = ["url": url, "title": String(title.prefix(Self.maxTitleLength)), "ext": ext]
            // Left out rather than written empty when there is none, which is how every
            // push before icons reads and what the vectors' URL envelope holds.
            if let icon, !icon.isEmpty { fields["icon"] = icon }
            object = fields
        case let .file(file):
            if let fk = file.fk, let np = file.np {
                object = [
                    "name": file.name, "mime": file.mime, "size": file.size, "ext": file.ext,
                    "fk": E2eeCrypto.base64(fk), "np": E2eeCrypto.base64(np),
                ]
            } else {
                object = ["name": file.name, "mime": file.mime, "size": file.size, "ext": file.ext, "legacyPlain": true]
            }
        }
        return try JSONSerialization.data(withJSONObject: object)
    }

    /// The plaintext of a push of `type` ("url" or "file"), as any client wrote it.
    init(json: Data, type: String) throws {
        guard let object = try JSONSerialization.jsonObject(with: json) as? [String: Any] else { throw ContentError.malformed }
        let ext = object["ext"] as? String ?? ""
        switch type {
        case "url":
            guard let url = object["url"] as? String else { throw ContentError.malformed }
            // Absent on a push from before icons, and "" means none as well (docs/e2ee.md,
            // "Icons"), so both read as nil and nothing downstream tells them apart.
            let icon = (object["icon"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            self = .url(url: url, title: object["title"] as? String ?? "", ext: ext, icon: icon)
        case "file":
            guard let name = object["name"] as? String else { throw ContentError.malformed }
            let mime = object["mime"] as? String ?? ""
            let size = (object["size"] as? NSNumber)?.int64Value ?? 0
            if object["legacyPlain"] as? Bool == true {
                self = .file(PushFile(name: name, mime: mime, size: size, ext: ext, fk: nil, np: nil))
                return
            }
            guard let fkText = object["fk"] as? String, let npText = object["np"] as? String,
                  let fk = try? E2eeCrypto.fromBase64(fkText), let np = try? E2eeCrypto.fromBase64(npText),
                  fk.count == E2eeCrypto.fileKeyLength, np.count == E2eeCrypto.filePrefixLength
            else { throw ContentError.malformed }
            self = .file(PushFile(name: name, mime: mime, size: size, ext: ext, fk: fk, np: np))
        default:
            throw ContentError.malformed
        }
    }

    /// The envelope and the blind index of this content, for the push `pushId` of
    /// `keys.uid`. Refused here when the ciphertext would be over the rules' bound.
    func seal(keys: PushKeys, pushId: String) throws -> (enc: E2eeCrypto.Envelope, searchTokens: [String]) {
        let enc = try E2eeCrypto.sealPush(metaKey: keys.metaKey, userId: keys.uid, pushId: pushId, plaintext: json())
        guard enc.ct.count <= E2eeCrypto.maxEnvelopeCiphertextLength else { throw ContentError.tooLarge }
        let tokens = E2eeCrypto.blindIndex(searchKey: keys.searchKey, tokens: SearchTokenGenerator.generate(from: searchText))
        return (enc, tokens)
    }

    /// The rewrite of a URL push after its page was scraped (docs/e2ee.md, "Titles" and
    /// "Icons"), or nil when there is nothing to write: the rules Android's
    /// `PushDocument.retitle` follows. It is rewritten when the title changed or an icon was
    /// found for a push that had none, and a push keeps the icon it has. When the envelope
    /// with an icon would be over the rules' bound the title is written alone, since the
    /// title is what the row is read by. With no new title that leaves nothing to write:
    /// sealing the same title again cost every listening device a write, and for a page with
    /// no title, one on every launch. Still too large without the icon, it throws `tooLarge`
    /// as before icons.
    static func rescraped(_ current: PushContent, title: String?, icon: String?, keys: PushKeys, pushId: String) throws -> (enc: E2eeCrypto.Envelope, searchTokens: [String])? {
        guard case let .url(url, oldTitle, ext, oldIcon) = current else { return nil }
        // Cut as the envelope cuts it, so a long title read again is not taken for a change.
        let newTitle = title
            .map { String($0.prefix(maxTitleLength)) }
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || $0 == oldTitle ? nil : $0 }
        let hadIcon = !(oldIcon ?? "").isEmpty
        let newIcon = icon.flatMap { $0.isEmpty || hadIcon ? nil : $0 }
        guard newTitle != nil || newIcon != nil else { return nil }
        let keptIcon = newIcon ?? oldIcon
        do {
            return try PushContent.url(url: url, title: newTitle ?? oldTitle, ext: ext, icon: keptIcon).seal(keys: keys, pushId: pushId)
        } catch ContentError.tooLarge where !(keptIcon ?? "").isEmpty {
            // The icon goes even when it was the push's own: the URL and new title did not
            // fit beside it, and the title is worth more than the picture.
            guard let newTitle else { return nil }
            return try PushContent.url(url: url, title: newTitle, ext: ext).seal(keys: keys, pushId: pushId)
        }
    }

    /// Opens a push's envelope, or nil when this device cannot: a push made under another
    /// account key (`keyVersion` differs), or one that does not open or parse. Such a push
    /// is shown locked. The AAD is made from the document's own `userId` and id.
    static func open(keys: PushKeys, userId: String, pushId: String, type: String, keyVersion: Int?, enc: E2eeCrypto.Envelope) -> PushContent? {
        guard keyVersion == keys.keyVersion, userId == keys.uid,
              let plaintext = try? E2eeCrypto.openPush(metaKey: keys.metaKey, userId: userId, pushId: pushId, enc: enc)
        else { return nil }
        return try? PushContent(json: plaintext, type: type)
    }
}

/// A file push's envelope. `fk` and `np` are absent on a file push migrated from plaintext
/// (`legacyPlain`), whose object is still the plaintext upload and opens as it is.
struct PushFile: Equatable {
    let name: String
    /// "application/octet-stream" when unknown; "" on a migrated push.
    let mime: String
    /// Plaintext bytes; 0 on a migrated push.
    let size: Int64
    /// Lowercased, no dot, "" when none.
    let ext: String
    let fk: Data?
    let np: Data?

    var legacyPlain: Bool { fk == nil || np == nil }

    /// The extension as every client writes it: lowercased, no dot, "" when none.
    static func ext(of name: String) -> String {
        (name as NSString).pathExtension.lowercased()
    }
}

/// The keys a push is sealed and opened with, from the account key this device stores
/// (docs/e2ee.md, "Where keys live on each device"). `keyVersion` is the version stored
/// beside the key, never one read fresh from the user document: the rules refuse a push
/// whose version is not the account's current one, and that refusal is what stops a device
/// whose key a reset replaced from writing pushes nobody can open.
struct PushKeys {
    let uid: String
    let keyVersion: Int
    let metaKey: Data
    let searchKey: Data
    /// This install's id, written on every push for echo suppression.
    let deviceId: String

    init(uid: String, keyVersion: Int, accountKey: Data, deviceId: String) {
        let subkeys = E2eeCrypto.accountSubkeys(accountKey)
        self.uid = uid
        self.keyVersion = keyVersion
        metaKey = subkeys.metaKey
        searchKey = subkeys.searchKey
        self.deviceId = deviceId
    }

    /// The keys for `uid`, or nil when this device holds no key for the account (an install
    /// that updated while signed in, before the password is asked for): such a session
    /// does not push.
    static func load(uid: String) -> PushKeys? {
        guard let stored = AccountKeyStore.accountKey(for: uid), let deviceId = try? AccountKeyStore.deviceId() else { return nil }
        return PushKeys(uid: stored.uid, keyVersion: stored.keyVersion, accountKey: stored.key, deviceId: deviceId)
    }

    /// The blind token a search for `term` looks up, or nil for a term with no word in it.
    func searchToken(for term: String) -> String? {
        SearchTokenGenerator.searchWord(term).map { E2eeCrypto.blindToken(searchKey: searchKey, token: $0) }
    }
}

/// A push as it will be written: the id chosen before sealing, and every field of the
/// document but `createdAt`, which is the server's. Kept whole by a retry, so that every
/// attempt writes the same id and the same ciphertext (docs/e2ee.md, "The push envelope":
/// the AAD names the document, so a new id would need a new envelope).
struct PreparedPush: Codable, Equatable {
    let pushId: String
    let userId: String
    let type: String
    let encVersion: Int
    let encNonce: String
    let encCiphertext: String
    let searchTokens: [String]
    let keyVersion: Int
    let deviceId: String
    /// File pushes only: "uploads/{uid}/{objectId}".
    let objectPath: String?

    init(content: PushContent, keys: PushKeys, pushId: String, objectPath: String? = nil) throws {
        let sealed = try content.seal(keys: keys, pushId: pushId)
        self.pushId = pushId
        userId = keys.uid
        type = content.type
        encVersion = sealed.enc.v
        encNonce = sealed.enc.n
        encCiphertext = sealed.enc.ct
        searchTokens = sealed.searchTokens
        keyVersion = keys.keyVersion
        deviceId = keys.deviceId
        self.objectPath = objectPath
    }

    var enc: E2eeCrypto.Envelope { E2eeCrypto.Envelope(v: encVersion, n: encNonce, ct: encCiphertext) }
}

/// A URL push's icon (docs/e2ee.md, "Icons"): the standard base64 of a PNG no larger than
/// 64 by 64 pixels and no more than 4096 bytes, carried in the envelope with the title so
/// that no device asks anyone for it in order to draw the list. Google's favicon service
/// drew it before, and so learned the host of every pushed link each time a list was drawn.
///
/// What needs no network is here rather than in `TitleScraperService`, which does the
/// fetching: this file is compiled by both apps and by the tests (which have no Firebase,
/// and a new file would mean a new entry in each project), so the candidate order, the
/// bounds and the decoding for display are written once per app and checked. ImageIO
/// rather than UIImage or NSImage for the same reason: it opens ICO and PNG on iOS and
/// macOS alike, so this is the same in both apps.
enum PushIcon {
    /// The longest side, in pixels, an icon is stored at.
    static let maxSide = 64
    /// The side tried once more when the PNG at `maxSide` is over `maxBytes`.
    static let fallbackSide = 32
    /// The most bytes of PNG an icon may be, 5464 characters of base64: with a URL and a
    /// title it still fits `enc.ct`'s 16384 for every ordinary link.
    static let maxBytes = 4096
    /// How much of each candidate is read. A larger file is passed over rather than cut,
    /// since a truncated image can still decode, with its lower part missing.
    static let maxDownloadBytes = 256 * 1024
    /// Frames longer than this on a side are passed over: a frame is decoded whole to be
    /// shrunk, and 256 KiB of PNG can hold a frame that would take hundreds of megabytes.
    /// No icon worth drawing at 64 pixels is that large.
    static let maxSourceSide = 2048
    /// The most `<link>` candidates tried before `/favicon.ico`. A page names a handful at
    /// most; the cap keeps one that names hundreds from turning a scrape into hundreds of
    /// requests. The same on every client (docs/e2ee.md, "Icons").
    static let maxLinkCandidates = 8

    // MARK: Candidates

    /// The URLs to try, best first, for the page whose HTML is `html` and whose final URL
    /// (after redirects) is `pageURL`: every `apple-touch-icon` link, then every `icon`
    /// link (`shortcut icon` included) that is not SVG by its type or its path, then
    /// `/favicon.ico` at the page's origin. Only http and https, each once, and at most
    /// `maxLinkCandidates` links. A `<base href>` is not followed, as on every client: the
    /// final URL is what all of them agree on.
    ///
    /// SVG is left out because ImageIO does not draw it: fetching one would be a request
    /// the site sees for nothing. The spec leaves the `apple-touch-icon` links unfiltered,
    /// and so does this; one that does not decode is simply passed over.
    static func candidates(html: String, pageURL: URL) -> [URL] {
        var touchIcons: [URL] = []
        var icons: [URL] = []
        for attributes in linkTags(in: html) {
            guard let rel = attributes["rel"], let href = attributes["href"],
                  let url = resolve(href, against: pageURL)
            else { continue }
            let rels = Set(rel.lowercased().split(whereSeparator: \.isWhitespace).map(String.init))
            if rels.contains("apple-touch-icon") || rels.contains("apple-touch-icon-precomposed") {
                touchIcons.append(url)
            } else if rels.contains("icon") {
                let type = attributes["type"]?.trimmingCharacters(in: .whitespaces).lowercased()
                guard type != "image/svg+xml", url.pathExtension.lowercased() != "svg" else { continue }
                icons.append(url)
            }
        }
        var seen = Set<URL>()
        var all = Array((touchIcons + icons).filter { seen.insert($0).inserted }.prefix(maxLinkCandidates))
        if let favicon = favicon(of: pageURL), !all.contains(favicon) { all.append(favicon) }
        return all
    }

    /// The attributes of every `<link>` tag, names lowercased, values unquoted and their
    /// common entities decoded. A scanner rather than a parser, as the scraper finds the
    /// `<title>`: a link's attributes are all an icon needs, and there is no HTML parser in
    /// the project to lean on. It takes attributes in any order, quoted either way or not at
    /// all, in any case, and a quoted value holding a `>`.
    static func linkTags(in html: String) -> [[String: String]] {
        linkPattern.matches(in: html, range: NSRange(html.startIndex..., in: html)).compactMap { match in
            guard let range = Range(match.range(at: 1), in: html) else { return nil }
            let tag = String(html[range])
            var attributes: [String: String] = [:]
            for attribute in attributePattern.matches(in: tag, range: NSRange(tag.startIndex..., in: tag)) {
                guard let name = Range(attribute.range(at: 1), in: tag) else { continue }
                let value = (2...4).lazy.compactMap { Range(attribute.range(at: $0), in: tag) }.first.map { String(tag[$0]) } ?? ""
                let key = tag[name].lowercased()
                // The first of a repeated attribute counts, as it does in a browser.
                if attributes[key] == nil { attributes[key] = decodeEntities(value) }
            }
            return attributes
        }
    }

    private static let linkPattern = try! NSRegularExpression(
        pattern: #"<link\b((?:[^>"']|"[^"]*"|'[^']*')*)>"#, options: .caseInsensitive
    )
    private static let attributePattern = try! NSRegularExpression(
        pattern: #"([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?"#
    )

    /// The entities an `href` holds in practice, `&amp;` between query parameters above
    /// all. `&amp;` goes last so that `&amp;lt;` reads as the text `&lt;`.
    private static func decodeEntities(_ value: String) -> String {
        guard value.contains("&") else { return value }
        var out = value
        for (entity, text) in [("&quot;", "\""), ("&#34;", "\""), ("&apos;", "'"), ("&#39;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("&#38;", "&"), ("&amp;", "&")] {
            out = out.replacingOccurrences(of: entity, with: text, options: .caseInsensitive)
        }
        return out
    }

    private static func resolve(_ href: String, against page: URL) -> URL? {
        let href = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !href.isEmpty, let url = URL(string: href, relativeTo: page)?.absoluteURL,
              isWeb(url.scheme), url.host != nil
        else { return nil }
        return url
    }

    /// `/favicon.ico` at the page's origin: its scheme, host and port, nothing else.
    private static func favicon(of page: URL) -> URL? {
        guard isWeb(page.scheme), let host = page.host else { return nil }
        var components = URLComponents()
        components.scheme = page.scheme?.lowercased()
        components.host = host
        components.port = page.port
        components.path = "/favicon.ico"
        return components.url
    }

    private static func isWeb(_ scheme: String?) -> Bool {
        let scheme = scheme?.lowercased()
        return scheme == "http" || scheme == "https"
    }

    // MARK: Encoding

    /// What a candidate's bytes came to.
    enum Encoded: Equatable {
        /// The icon, within the bounds.
        case icon(String)
        /// ImageIO could not open them (or they are over `maxDownloadBytes`): the next
        /// candidate is tried.
        case undecodable
        /// They opened, but the PNG is over `maxBytes` at 32 by 32 as well. The first
        /// candidate that decodes decides, so there is no icon and no further candidate
        /// is tried, as on every client (docs/e2ee.md, "Icons").
        case tooLarge
    }

    static func encode(_ data: Data) -> Encoded {
        guard data.count <= maxDownloadBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let index = bestFrame(of: source),
              let image = CGImageSourceCreateImageAtIndex(source, index, nil)
        else { return .undecodable }
        for side in [maxSide, fallbackSide] {
            guard let png = png(of: image, fitting: side) else { return .undecodable }
            if png.count <= maxBytes { return .icon(png.base64EncodedString()) }
        }
        return .tooLarge
    }

    /// The frame to shrink, by its longer side: the smallest of at least `maxSide`, so an
    /// ICO's 64-pixel frame, drawn for that size, wins over its 256 one shrunk; else the
    /// largest there is. The first wins a tie, which takes an animated GIF's first frame.
    private static func bestFrame(of source: CGImageSource) -> Int? {
        var best: (index: Int, side: Int)?
        for index in 0..<CGImageSourceGetCount(source) {
            guard let side = longerSide(source, index), side <= maxSourceSide else { continue }
            guard let current = best else {
                best = (index, side)
                continue
            }
            let better = side >= maxSide
                ? current.side < maxSide || side < current.side
                : current.side < maxSide && side > current.side
            if better { best = (index, side) }
        }
        return best?.index
    }

    private static func pixelSize(_ source: CGImageSource, _ index: Int) -> (width: Int, height: Int)? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0
        else { return nil }
        return (width, height)
    }

    private static func longerSide(_ source: CGImageSource, _ index: Int) -> Int? {
        pixelSize(source, index).map { max($0.width, $0.height) }
    }

    /// `image` scaled down to fit `side` by `side` with its aspect kept, never up, as PNG.
    /// Drawn into a context of exactly the target size rather than through ImageIO's
    /// thumbnails, whose handling of an image already smaller than the limit is not
    /// documented. Drawn in sRGB, so an icon in another color space (a CMYK JPEG, a P3 PNG)
    /// comes out as every platform will show it; ImageIO marks that with a short `sRGB`
    /// chunk, not a whole ICC profile, so it costs a few bytes of the 4096.
    private static func png(of image: CGImage, fitting side: Int) -> Data? {
        let scale = min(1, Double(side) / Double(max(image.width, image.height)))
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        let height = max(1, Int((Double(image.height) * scale).rounded()))
        guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB), let context = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, scaled, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    // MARK: Showing

    /// The image to draw for a push's `icon`, or nil when it is not a PNG within the
    /// bounds, which draws the placeholder. Decoded once per icon and kept, failures too: a
    /// row's body is evaluated far more often than its push changes.
    static func image(_ icon: String) -> CGImage? {
        let key = icon as NSString
        if let decoded = cache.object(forKey: key) { return decoded.image }
        let image = decode(icon)
        cache.setObject(Decoded(image), forKey: key)
        return image
    }

    /// Opens an `icon` as the spec bounds it. Only PNG, and only up to 64 by 64, checked
    /// before any pixel is decoded: whatever wrote the envelope, a small file must not
    /// become a large image in a list of them.
    static func decode(_ icon: String) -> CGImage? {
        guard let data = Data(base64Encoded: icon), data.count <= maxBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == UTType.png.identifier,
              let size = pixelSize(source, 0), size.width <= maxSide, size.height <= maxSide
        else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    private final class Decoded {
        let image: CGImage?
        init(_ image: CGImage?) { self.image = image }
    }

    private static let cache: NSCache<NSString, Decoded> = {
        let cache = NSCache<NSString, Decoded>()
        cache.countLimit = 500
        return cache
    }()
}

/// A page's title as every client stores it: the text of its first `<title>`, character
/// references decoded, whitespace collapsed to single spaces and trimmed.
///
/// Here rather than in `TitleScraperService` for the reason `PushIcon` is: this file is
/// compiled by both apps and by the tests, so the decoding is written once per app and
/// checked. The title is stored in the envelope and read by every device, so the aim is
/// the title Android's Jsoup gives for the same page (`doc.title()`): references decoded
/// before the whitespace is collapsed, as a parser does, and numeric ones decoded as a
/// browser decodes them.
enum PushTitle {
    static func extract(from html: String) -> String? {
        guard let match = titlePattern.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
              let range = Range(match.range(at: 1), in: html)
        else { return nil }
        // Decoded first, so a `&nbsp;` or `&#10;` is collapsed with the rest of the
        // whitespace, as Jsoup collapses the text it has already decoded. Jsoup also drops
        // the soft hyphen and the zero-width space as it collapses, however they were
        // written, so they are dropped here too.
        //
        // Jsoup's whitespace, not Unicode's: it collapses only these six, so a thin space
        // (`&thinsp;`), the narrow no-break space French puts before `!` or an ideographic
        // space is kept as written. `\s` and `.whitespacesAndNewlines` would flatten them to a
        // space and store a different title from Android's. Then Java's `trim()`, which
        // takes everything up to U+0020 off the ends and nothing above it.
        return decodingEntities(String(html[range]))
            .replacingOccurrences(of: "[\\u00AD\\u200B]", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[ \\t\\n\\f\\r\\u00A0]+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: javaTrimmed)
    }

    private static let javaTrimmed = CharacterSet(charactersIn: "\u{0000}"..."\u{0020}")

    private static let titlePattern = try! NSRegularExpression(
        pattern: "<title[^>]*>([^<]+)</title>", options: .caseInsensitive
    )

    /// Decodes the named references in `named` and every decimal (`&#8217;`) and hex
    /// (`&#x2019;`) one, in a single pass from the left, so the text a reference decodes
    /// to is never read again: `&amp;#39;` is the text `&#39;`, not an apostrophe. A
    /// reference this does not know, or a numeric one that names no character (zero, a
    /// surrogate, past U+10FFFF, or no digits at all), is left as it was written.
    ///
    /// Jsoup parts from this on those numbers: it makes U+FFFD of one past U+10FFFF and a
    /// lone surrogate of one in that range (which a Swift `String` cannot hold). No page
    /// means either, so the text as written was kept over copying Jsoup's answer.
    ///
    /// A name needs its `;`, except the 106 in `legacy`, which HTML reads without one, as
    /// Jsoup and browsers do: hand-written titles hold `&copy 2024` and `Fish &amp Chips`.
    ///
    /// The numeric ones used to be deleted, so a title with a typographic apostrophe lost
    /// it, and every device then read the title with the letter missing.
    static func decodingEntities(_ text: String) -> String {
        guard text.contains("&") else { return text }
        let scalars = Array(text.unicodeScalars)
        var out = String.UnicodeScalarView()
        var index = 0
        while index < scalars.count {
            if scalars[index] == "&", let (decoded, length) = reference(in: scalars, at: index) {
                out.append(contentsOf: decoded.unicodeScalars)
                index += length
            } else {
                out.append(scalars[index])
                index += 1
            }
        }
        return String(out)
    }

    /// The references a title is decoded for by name: HTML 4's 252 and `&apos;`, by code
    /// point. Jsoup knows HTML5's two thousand, but nearly all of those are mathematical
    /// symbols no title uses, while these hold every one a page writes in practice
    /// (`&rsquo;`, `&hellip;`, `&eacute;`). `&lang;` and `&rang;` take HTML5's code points,
    /// which replaced HTML 4's, as Jsoup does. Each decodes to its own character: a few once
    /// became ASCII stand-ins (`-` for both dashes, `(c)`), which disagreed with Jsoup and
    /// with the same character written as a number. HTML5's uppercase aliases of six of
    /// them (`&AMP;`, `&COPY;`) are here too, being among the legacy names in `legacy`.
    private static let named: [String: Unicode.Scalar] = [
        "AMP": "\u{0026}", "COPY": "\u{00A9}", "GT": "\u{003E}", "LT": "\u{003C}", "QUOT": "\u{0022}", "REG": "\u{00AE}",
        "quot": "\u{0022}", "amp": "\u{0026}", "apos": "\u{0027}", "lt": "\u{003C}", "gt": "\u{003E}",
        "nbsp": "\u{00A0}", "iexcl": "\u{00A1}", "cent": "\u{00A2}", "pound": "\u{00A3}", "curren": "\u{00A4}",
        "yen": "\u{00A5}", "brvbar": "\u{00A6}", "sect": "\u{00A7}", "uml": "\u{00A8}", "copy": "\u{00A9}",
        "ordf": "\u{00AA}", "laquo": "\u{00AB}", "not": "\u{00AC}", "shy": "\u{00AD}", "reg": "\u{00AE}",
        "macr": "\u{00AF}", "deg": "\u{00B0}", "plusmn": "\u{00B1}", "sup2": "\u{00B2}", "sup3": "\u{00B3}",
        "acute": "\u{00B4}", "micro": "\u{00B5}", "para": "\u{00B6}", "middot": "\u{00B7}", "cedil": "\u{00B8}",
        "sup1": "\u{00B9}", "ordm": "\u{00BA}", "raquo": "\u{00BB}", "frac14": "\u{00BC}", "frac12": "\u{00BD}",
        "frac34": "\u{00BE}", "iquest": "\u{00BF}", "Agrave": "\u{00C0}", "Aacute": "\u{00C1}", "Acirc": "\u{00C2}",
        "Atilde": "\u{00C3}", "Auml": "\u{00C4}", "Aring": "\u{00C5}", "AElig": "\u{00C6}", "Ccedil": "\u{00C7}",
        "Egrave": "\u{00C8}", "Eacute": "\u{00C9}", "Ecirc": "\u{00CA}", "Euml": "\u{00CB}", "Igrave": "\u{00CC}",
        "Iacute": "\u{00CD}", "Icirc": "\u{00CE}", "Iuml": "\u{00CF}", "ETH": "\u{00D0}", "Ntilde": "\u{00D1}",
        "Ograve": "\u{00D2}", "Oacute": "\u{00D3}", "Ocirc": "\u{00D4}", "Otilde": "\u{00D5}", "Ouml": "\u{00D6}",
        "times": "\u{00D7}", "Oslash": "\u{00D8}", "Ugrave": "\u{00D9}", "Uacute": "\u{00DA}", "Ucirc": "\u{00DB}",
        "Uuml": "\u{00DC}", "Yacute": "\u{00DD}", "THORN": "\u{00DE}", "szlig": "\u{00DF}", "agrave": "\u{00E0}",
        "aacute": "\u{00E1}", "acirc": "\u{00E2}", "atilde": "\u{00E3}", "auml": "\u{00E4}", "aring": "\u{00E5}",
        "aelig": "\u{00E6}", "ccedil": "\u{00E7}", "egrave": "\u{00E8}", "eacute": "\u{00E9}", "ecirc": "\u{00EA}",
        "euml": "\u{00EB}", "igrave": "\u{00EC}", "iacute": "\u{00ED}", "icirc": "\u{00EE}", "iuml": "\u{00EF}",
        "eth": "\u{00F0}", "ntilde": "\u{00F1}", "ograve": "\u{00F2}", "oacute": "\u{00F3}", "ocirc": "\u{00F4}",
        "otilde": "\u{00F5}", "ouml": "\u{00F6}", "divide": "\u{00F7}", "oslash": "\u{00F8}", "ugrave": "\u{00F9}",
        "uacute": "\u{00FA}", "ucirc": "\u{00FB}", "uuml": "\u{00FC}", "yacute": "\u{00FD}", "thorn": "\u{00FE}",
        "yuml": "\u{00FF}", "OElig": "\u{0152}", "oelig": "\u{0153}", "Scaron": "\u{0160}", "scaron": "\u{0161}",
        "Yuml": "\u{0178}", "fnof": "\u{0192}", "circ": "\u{02C6}", "tilde": "\u{02DC}", "Alpha": "\u{0391}",
        "Beta": "\u{0392}", "Gamma": "\u{0393}", "Delta": "\u{0394}", "Epsilon": "\u{0395}", "Zeta": "\u{0396}",
        "Eta": "\u{0397}", "Theta": "\u{0398}", "Iota": "\u{0399}", "Kappa": "\u{039A}", "Lambda": "\u{039B}",
        "Mu": "\u{039C}", "Nu": "\u{039D}", "Xi": "\u{039E}", "Omicron": "\u{039F}", "Pi": "\u{03A0}",
        "Rho": "\u{03A1}", "Sigma": "\u{03A3}", "Tau": "\u{03A4}", "Upsilon": "\u{03A5}", "Phi": "\u{03A6}",
        "Chi": "\u{03A7}", "Psi": "\u{03A8}", "Omega": "\u{03A9}", "alpha": "\u{03B1}", "beta": "\u{03B2}",
        "gamma": "\u{03B3}", "delta": "\u{03B4}", "epsilon": "\u{03B5}", "zeta": "\u{03B6}", "eta": "\u{03B7}",
        "theta": "\u{03B8}", "iota": "\u{03B9}", "kappa": "\u{03BA}", "lambda": "\u{03BB}", "mu": "\u{03BC}",
        "nu": "\u{03BD}", "xi": "\u{03BE}", "omicron": "\u{03BF}", "pi": "\u{03C0}", "rho": "\u{03C1}",
        "sigmaf": "\u{03C2}", "sigma": "\u{03C3}", "tau": "\u{03C4}", "upsilon": "\u{03C5}", "phi": "\u{03C6}",
        "chi": "\u{03C7}", "psi": "\u{03C8}", "omega": "\u{03C9}", "thetasym": "\u{03D1}", "upsih": "\u{03D2}",
        "piv": "\u{03D6}", "ensp": "\u{2002}", "emsp": "\u{2003}", "thinsp": "\u{2009}", "zwnj": "\u{200C}",
        "zwj": "\u{200D}", "lrm": "\u{200E}", "rlm": "\u{200F}", "ndash": "\u{2013}", "mdash": "\u{2014}",
        "lsquo": "\u{2018}", "rsquo": "\u{2019}", "sbquo": "\u{201A}", "ldquo": "\u{201C}", "rdquo": "\u{201D}",
        "bdquo": "\u{201E}", "dagger": "\u{2020}", "Dagger": "\u{2021}", "bull": "\u{2022}", "hellip": "\u{2026}",
        "permil": "\u{2030}", "prime": "\u{2032}", "Prime": "\u{2033}", "lsaquo": "\u{2039}", "rsaquo": "\u{203A}",
        "oline": "\u{203E}", "frasl": "\u{2044}", "euro": "\u{20AC}", "image": "\u{2111}", "weierp": "\u{2118}",
        "real": "\u{211C}", "trade": "\u{2122}", "alefsym": "\u{2135}", "larr": "\u{2190}", "uarr": "\u{2191}",
        "rarr": "\u{2192}", "darr": "\u{2193}", "harr": "\u{2194}", "crarr": "\u{21B5}", "lArr": "\u{21D0}",
        "uArr": "\u{21D1}", "rArr": "\u{21D2}", "dArr": "\u{21D3}", "hArr": "\u{21D4}", "forall": "\u{2200}",
        "part": "\u{2202}", "exist": "\u{2203}", "empty": "\u{2205}", "nabla": "\u{2207}", "isin": "\u{2208}",
        "notin": "\u{2209}", "ni": "\u{220B}", "prod": "\u{220F}", "sum": "\u{2211}", "minus": "\u{2212}",
        "lowast": "\u{2217}", "radic": "\u{221A}", "prop": "\u{221D}", "infin": "\u{221E}", "ang": "\u{2220}",
        "and": "\u{2227}", "or": "\u{2228}", "cap": "\u{2229}", "cup": "\u{222A}", "int": "\u{222B}",
        "there4": "\u{2234}", "sim": "\u{223C}", "cong": "\u{2245}", "asymp": "\u{2248}", "ne": "\u{2260}",
        "equiv": "\u{2261}", "le": "\u{2264}", "ge": "\u{2265}", "sub": "\u{2282}", "sup": "\u{2283}",
        "nsub": "\u{2284}", "sube": "\u{2286}", "supe": "\u{2287}", "oplus": "\u{2295}", "otimes": "\u{2297}",
        "perp": "\u{22A5}", "sdot": "\u{22C5}", "lceil": "\u{2308}", "rceil": "\u{2309}", "lfloor": "\u{230A}",
        "rfloor": "\u{230B}", "loz": "\u{25CA}", "spades": "\u{2660}", "clubs": "\u{2663}", "hearts": "\u{2665}",
        "diams": "\u{2666}", "lang": "\u{27E8}", "rang": "\u{27E9}",
    ]

    /// The names HTML reads without their `;`, kept from before HTML required one: Latin-1
    /// and the four that `&` and markup need, with the uppercase aliases. Every one is in
    /// `named`. HTML5 lists them, and Jsoup reads them so.
    private static let legacy: Set<String> = [
        "Aacute", "aacute", "Acirc", "acirc", "acute", "AElig", "aelig", "Agrave", "agrave", "AMP",
        "amp", "Aring", "aring", "Atilde", "atilde", "Auml", "auml", "brvbar", "Ccedil", "ccedil",
        "cedil", "cent", "COPY", "copy", "curren", "deg", "divide", "Eacute", "eacute", "Ecirc",
        "ecirc", "Egrave", "egrave", "ETH", "eth", "Euml", "euml", "frac12", "frac14", "frac34",
        "GT", "gt", "Iacute", "iacute", "Icirc", "icirc", "iexcl", "Igrave", "igrave", "iquest",
        "Iuml", "iuml", "laquo", "LT", "lt", "macr", "micro", "middot", "nbsp", "not", "Ntilde",
        "ntilde", "Oacute", "oacute", "Ocirc", "ocirc", "Ograve", "ograve", "ordf", "ordm",
        "Oslash", "oslash", "Otilde", "otilde", "Ouml", "ouml", "para", "plusmn", "pound", "QUOT",
        "quot", "raquo", "REG", "reg", "sect", "shy", "sup1", "sup2", "sup3", "szlig", "THORN",
        "thorn", "times", "Uacute", "uacute", "Ucirc", "ucirc", "Ugrave", "ugrave", "uml", "Uuml",
        "uuml", "Yacute", "yacute", "yen", "yuml",
    ]

    private static let longestLegacyName = legacy.map(\.count).max()!

    /// What the code points 0x80 to 0x9F mean in a numeric reference: HTML reads them as
    /// Windows-1252, as Jsoup and every browser do, so the `&#146;` an old page wrote for an
    /// apostrophe is one. Those that Windows-1252 leaves undefined stay as they are.
    private static let windows1252: [UInt32] = [
        0x20AC, 0x0081, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
        0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008D, 0x017D, 0x008F,
        0x0090, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
        0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x009D, 0x017E, 0x0178,
    ]

    /// The reference starting at the `&` at `start`: what it decodes to and how many
    /// scalars it takes, or nil to leave the `&` as text.
    private static func reference(in scalars: [Unicode.Scalar], at start: Int) -> (String, Int)? {
        var index = start + 1
        guard index < scalars.count else { return nil }
        guard scalars[index] == "#" else { return namedReference(in: scalars, at: start) }
        index += 1
        var radix: UInt32 = 10
        if index < scalars.count, scalars[index] == "x" || scalars[index] == "X" {
            radix = 16
            index += 1
        }
        let digitsStart = index
        var value: UInt32 = 0
        while index < scalars.count, let digit = digitValue(scalars[index], radix: radix) {
            // Held just past the last code point, so a long run of digits cannot overflow
            // and still reads as out of range.
            value = min(value * radix + digit, 0x110000)
            index += 1
        }
        guard index > digitsStart else { return nil }
        // The `;` is optional, as it is for a browser and for Jsoup: `&#8217s` is an
        // apostrophe and an s.
        if index < scalars.count, scalars[index] == ";" { index += 1 }
        if (0x80...0x9F).contains(value) { value = windows1252[Int(value - 0x80)] }
        // `Unicode.Scalar` refuses surrogates and anything past U+10FFFF.
        guard value != 0, let scalar = Unicode.Scalar(value) else { return nil }
        return (String(Character(scalar)), index - start)
    }

    /// A name and its `;` from `named`, or else the longest start of the name that is in
    /// `legacy`, the rest of it left as text. That is how HTML reads a name in a title, and
    /// how Jsoup does: `&notin;` is the one character, `&notit;` is `¬it;`, `&copy2024` is
    /// `©2024`, while `&hellip` without its `;` stays as written.
    private static func namedReference(in scalars: [Unicode.Scalar], at start: Int) -> (String, Int)? {
        var end = start + 1
        while end < scalars.count, isASCIIAlphanumeric(scalars[end]) { end += 1 }
        func name(_ length: Int) -> String { String(String.UnicodeScalarView(scalars[(start + 1)..<(start + 1 + length)])) }
        let length = end - start - 1
        if end < scalars.count, scalars[end] == ";", let scalar = named[name(length)] {
            return (String(Character(scalar)), length + 2)
        }
        for prefix in stride(from: min(length, longestLegacyName), through: 2, by: -1) {
            if legacy.contains(name(prefix)), let scalar = named[name(prefix)] {
                return (String(Character(scalar)), prefix + 1)
            }
        }
        return nil
    }

    private static func isASCIIAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    /// ASCII digits only: `Character.wholeNumberValue` would also take other scripts' digits,
    /// which no parser reads in a reference.
    private static func digitValue(_ scalar: Unicode.Scalar, radix: UInt32) -> UInt32? {
        switch scalar {
        case "0"..."9": return scalar.value - 0x30
        case "a"..."f" where radix == 16: return scalar.value - 0x61 + 10
        case "A"..."F" where radix == 16: return scalar.value - 0x41 + 10
        default: return nil
        }
    }
}
