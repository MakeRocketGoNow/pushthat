import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// The recovery key, shown once (docs/e2ee.md, "The recovery key"): at sign-up, after a
/// migration, and from "Show a new recovery key". The copy is word for word what every
/// client shows. This file is the same in `apps/ios` and `apps/macos`.
struct RecoveryKeyView: View {
    let recoveryKey: String
    let onSaved: () -> Void
    @State private var copied = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Text("Your recovery key")
                    .font(.title)
                    .fontWeight(.bold)

                Text("Your password is the key to your pushes. We never see it and cannot reset it for you. Save your recovery key.")
                    .multilineTextAlignment(.center)

                Text("It is shown only once. If you forget your password, it is the only way to keep your pushes.")
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)

                Text(Self.lines(recoveryKey))
                    .font(.system(.title3, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(Color.inputBackground)
                    .cornerRadius(8)

                Button(copied ? "Copied" : "Copy") {
                    copy()
                }
                .foregroundColor(.pink200)

                Button(action: onSaved) {
                    Text("I saved it")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.pink200)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
            }
            .padding(32)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
    }

    /// Two lines of four groups, so that the key fits a phone's width in a monospaced font
    /// without SwiftUI breaking it inside a group.
    static func lines(_ key: String) -> String {
        let groups = key.split(separator: "-").map(String.init)
        guard groups.count == 8 else { return key }
        return groups[0..<4].joined(separator: "-") + "\n" + groups[4..<8].joined(separator: "-")
    }

    /// The key as displayed, with its hyphens, which the decoder reads back as typed.
    private func copy() {
        #if os(iOS)
        UIPasteboard.general.string = recoveryKey
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(recoveryKey, forType: .string)
        #endif
        copied = true
    }
}
