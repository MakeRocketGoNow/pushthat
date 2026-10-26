import SwiftUI

/// App color definitions matching Android color scheme
extension Color {
    /// Primary pink color (#FFA9E7)
    static let pink200 = Color(red: 255/255, green: 169/255, blue: 231/255)

    /// Darker pink for accents (#C2185B)
    static let pink700 = Color(red: 194/255, green: 24/255, blue: 91/255)

    /// Teal accent color (#03DAC5)
    static let teal200 = Color(red: 3/255, green: 218/255, blue: 197/255)

    /// Bright teal for logo (#2EFFFC)
    static let tealBright = Color(red: 46/255, green: 255/255, blue: 252/255)

    /// Input field background (adapts to dark/light mode)
    static let inputBackground = Color(UIColor { traitCollection in
        traitCollection.userInterfaceStyle == .dark
            ? UIColor(white: 1.0, alpha: 0.1)
            : UIColor(red: 245/255, green: 245/255, blue: 245/255, alpha: 1.0)
    })

    /// Text input hint color
    static let inputHint = Color(UIColor { traitCollection in
        traitCollection.userInterfaceStyle == .dark
            ? UIColor(white: 1.0, alpha: 0.7)
            : UIColor(red: 117/255, green: 117/255, blue: 117/255, alpha: 1.0)
    })
}

/// UIColor extensions for use in UIKit contexts
extension UIColor {
    static let pink200 = UIColor(red: 255/255, green: 169/255, blue: 231/255, alpha: 1.0)
    static let pink700 = UIColor(red: 194/255, green: 24/255, blue: 91/255, alpha: 1.0)
    static let teal200 = UIColor(red: 3/255, green: 218/255, blue: 197/255, alpha: 1.0)
}
