import SwiftUI

/// "Change password" and "Show a new recovery key", from the main screen's menu beside
/// Plan (docs/e2ee.md, "The recovery key"; the web app has no settings page, so these are
/// on the apps only). This file is the same in `apps/ios` and `apps/macos`.
extension View {
    func accountSettings(authViewModel: AuthViewModel, showChangePassword: Binding<Bool>, confirmNewRecoveryKey: Binding<Bool>) -> some View {
        modifier(AccountSettingsModifier(
            authViewModel: authViewModel,
            showChangePassword: showChangePassword,
            confirmNewRecoveryKey: confirmNewRecoveryKey
        ))
    }
}

/// A recovery key on screen, for `.sheet(item:)`.
struct ShownRecoveryKey: Identifiable {
    let id = UUID()
    let key: String
}

private struct AccountSettingsModifier: ViewModifier {
    @ObservedObject var authViewModel: AuthViewModel
    @Binding var showChangePassword: Bool
    @Binding var confirmNewRecoveryKey: Bool
    @State private var shownRecoveryKey: ShownRecoveryKey?
    @State private var problem: String?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showChangePassword) {
                ChangePasswordView()
                    .environmentObject(authViewModel)
                    #if os(macOS)
                    .frame(minWidth: 380, minHeight: 380)
                    #endif
            }
            .sheet(item: $shownRecoveryKey) { shown in
                RecoveryKeyView(recoveryKey: shown.key) { shownRecoveryKey = nil }
                    // Closed only by "I saved it": the old key has stopped working already.
                    .interactiveDismissDisabled()
                    #if os(macOS)
                    .frame(minWidth: 420, minHeight: 480)
                    #endif
            }
            .alert("Your old recovery key will stop working.", isPresented: $confirmNewRecoveryKey) {
                Button("Show a new recovery key") { makeNewRecoveryKey() }
                Button("Cancel", role: .cancel) {}
            }
            .alert("No new recovery key", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK") {}
            } message: {
                Text(problem ?? "")
            }
    }

    private func makeNewRecoveryKey() {
        Task {
            do {
                shownRecoveryKey = ShownRecoveryKey(key: try await authViewModel.newRecoveryKey())
            } catch {
                problem = AuthViewModel.message(for: error)
            }
        }
    }
}

/// Current password, then the new one twice. The new one follows sign-up's rule.
struct ChangePasswordView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var new = ""
    @State private var again = ""
    @State private var isWorking = false
    @State private var problem: String?
    @State private var changed = false

    var body: some View {
        NavigationStack {
            Form {
                if changed {
                    Section {
                        Text("Your password is changed. Sign in with the new one on your other devices.")
                    }
                } else {
                    Section {
                        SecureField("Current password", text: $current)
                            .textContentType(.password)
                    }
                    Section {
                        SecureField("New password", text: $new)
                            .newPasswordContent()
                        SecureField("New password again", text: $again)
                            .newPasswordContent()
                    } footer: {
                        Text(AuthViewModel.newPasswordRule)
                    }
                    if let problem {
                        Section {
                            Text(problem)
                                .foregroundColor(.red)
                        }
                    }
                }
            }
            .navigationTitle("Change password")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                if changed {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                } else {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                            .disabled(isWorking)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        if isWorking {
                            ProgressView()
                        } else {
                            Button("Change") { change() }
                                .disabled(current.isEmpty || new.isEmpty || again.isEmpty)
                        }
                    }
                }
            }
            // Not while it runs: the steps would carry on unseen, and the user would not
            // learn which password is now the one.
            .interactiveDismissDisabled(isWorking)
        }
    }

    private func change() {
        isWorking = true
        problem = nil
        Task {
            do {
                try await authViewModel.changePassword(current: current, new: new, again: again)
                changed = true
            } catch {
                problem = AuthViewModel.message(for: error)
            }
            isWorking = false
        }
    }
}

private extension View {
    /// Lets iOS offer a strong password and save it. macOS 13 has no such content type.
    @ViewBuilder
    func newPasswordContent() -> some View {
        #if os(iOS)
        textContentType(.newPassword)
        #else
        self
        #endif
    }
}
