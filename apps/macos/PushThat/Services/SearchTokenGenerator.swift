import Foundation

/// The search tokens of a push (docs/e2ee.md, "Search"): the rule every client tokenizes
/// by, so that a push made on one platform is found by a search on another once the tokens
/// are blinded. It is the reference's `searchTokens` (packages/push-test/e2ee.mjs), and
/// `PushThatTests` holds it to the vector's list, in order.
///
/// This was the iOS rule before the blind index, with three things pinned that Swift's
/// `String` leaves loose: the text is NFC first, prefixes are counted in Unicode scalars
/// (code points) rather than grapheme clusters, and tokens are deduplicated on their
/// scalars. A `Set<String>` is not used for that, since Swift compares strings by canonical
/// equivalence and would also lose the first-seen order the vector lists.
///
/// The file is the same in `apps/ios` and `apps/macos` and uses Foundation alone, so the
/// test bundle compiles it without the app.
enum SearchTokenGenerator {
    /// The rules' bound on `searchTokens`; only a title and URL of thousands of characters
    /// reach it, and the first tokens are the ones kept.
    static let maxTokens = 3000

    /// Every prefix of every word of `text`, once each, in the order first seen.
    ///
    /// Example: "GitHub Repository" gives
    /// ["g", "gi", "git", "gith", "githu", "github",
    ///  "r", "re", "rep", "repo", "repos", "reposi",
    ///  "reposit", "reposito", "repositor", "repository"]
    static func generate(from text: String) -> [String] {
        var seen = Set<Data>()
        var tokens: [String] = []
        for word in words(text) {
            var prefix = String.UnicodeScalarView()
            for scalar in word {
                prefix.append(scalar)
                let token = String(prefix)
                // The UTF-8 bytes are the scalars exactly; String's own equality is not.
                if seen.insert(Data(token.utf8)).inserted {
                    if tokens.count == maxTokens { return tokens }
                    tokens.append(token)
                }
            }
        }
        return tokens
    }

    /// What a search looks up: the first word of the term, normalized and split by the
    /// same rule, or nil for a term with no word in it, which is no search at all.
    /// "github repo" searches "github", as the single `array-contains` always has.
    static func searchWord(_ term: String) -> String? {
        words(term).first.map { String(String.UnicodeScalarView($0)) }
    }

    /// The text NFC-normalized and lowercased, split on every run of scalars that are not
    /// a letter, a combining mark or a number (`[^\p{L}\p{M}\p{N}]+`), empty words dropped.
    static func words(_ text: String) -> [[Unicode.Scalar]] {
        var words: [[Unicode.Scalar]] = []
        var current: [Unicode.Scalar] = []
        for scalar in lowercase(text.precomposedStringWithCanonicalMapping) {
            if isWordScalar(scalar) {
                current.append(scalar)
            } else if !current.isEmpty {
                words.append(current)
                current = []
            }
        }
        if !current.isEmpty { words.append(current) }
        return words
    }

    private static func isWordScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter,
             .nonspacingMark, .spacingMark, .enclosingMark,
             .decimalNumber, .letterNumber, .otherNumber:
            return true
        default:
            return false
        }
    }

    /// The full Unicode lowercase mapping without a locale, as JavaScript's
    /// `toLowerCase()` and Kotlin's `lowercase()` apply it. Swift's `lowercased()` is that
    /// mapping except for one context: it lowers every capital sigma to "σ", where the
    /// others write a word-final one as "ς" (Unicode's Final_Sigma condition), so a Greek
    /// title would tokenize differently here than on every other client. Each scalar is
    /// lowered on its own, which is the same as lowering the string for every other scalar
    /// (Final_Sigma is the only condition the root locale has), and the sigma is decided
    /// by the rule itself.
    static func lowercase(_ text: String) -> [Unicode.Scalar] {
        let scalars = Array(text.unicodeScalars)
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(scalars.count)
        for (i, scalar) in scalars.enumerated() {
            if scalar.value == 0x03A3 {
                out.append(isFinalSigma(scalars, at: i) ? "\u{03C2}" : "\u{03C3}")
            } else {
                out.append(contentsOf: String(scalar).lowercased().unicodeScalars)
            }
        }
        return out
    }

    /// Final_Sigma (Unicode, Default Case Conversion): the sigma follows a cased letter,
    /// with only case-ignorable scalars between, and is not followed by one the same way.
    private static func isFinalSigma(_ scalars: [Unicode.Scalar], at index: Int) -> Bool {
        var before = index - 1
        while before >= 0, scalars[before].properties.isCaseIgnorable { before -= 1 }
        guard before >= 0, scalars[before].properties.isCased else { return false }
        var after = index + 1
        while after < scalars.count, scalars[after].properties.isCaseIgnorable { after += 1 }
        return !(after < scalars.count && scalars[after].properties.isCased)
    }
}
