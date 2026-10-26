import Foundation

extension Date {
    /// Formats the date as a relative time string
    /// Examples: "just now", "2 minutes ago", "3 hours ago", "yesterday"
    func relativeFormatted() -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named

        return formatter.localizedString(for: self, relativeTo: Date())
    }

    /// Formats the date for display with both relative and absolute time
    /// Returns relative time with full date on separate line for accessibility
    func formattedWithDetails() -> (relative: String, absolute: String) {
        let relative = relativeFormatted()

        let dateFormatter = DateFormatter()
        dateFormatter.dateStyle = .medium
        dateFormatter.timeStyle = .short
        let absolute = dateFormatter.string(from: self)

        return (relative, absolute)
    }
}
