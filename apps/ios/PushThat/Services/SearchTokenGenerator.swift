import Foundation

/// Generates search tokens from text
/// Matches the Android implementation exactly for cross-platform compatibility
struct SearchTokenGenerator {

    /// Generates search tokens from text
    /// Creates complete words and all their prefixes for flexible prefix-based search
    ///
    /// Example: "GitHub Repository" generates:
    /// ["g", "gi", "git", "gith", "githu", "github",
    ///  "r", "re", "rep", "repo", "repos", "reposi",
    ///  "reposit", "reposito", "repositor", "repository"]
    static func generate(from text: String) -> [String] {
        // Step 1: Normalize - lowercase and split by non-alphanumeric characters
        let words = text
            .lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }

        var tokens = Set<String>()

        for word in words {
            // Step 2: Add complete word
            tokens.insert(word)

            // Step 3: Add all prefixes (substrings from position 0)
            for i in 1...word.count {
                let prefix = String(word.prefix(i))
                tokens.insert(prefix)
            }
        }

        return Array(tokens)
    }
}
