import SwiftUI

/// "Change password", "Show a new recovery key" and "Delete account", from the main
/// screen's menu beside Plan (docs/e2ee.md, "The recovery key"). This file is the same in
/// `apps/ios` and `apps/macos`.
extension View {
    func accountSettings(authViewModel: AuthViewModel, showChangePassword: Binding<Bool>, confirmNewRecoveryKey: Binding<Bool>, showDeleteAccount: Binding<Bool>) -> some View {
        modifier(AccountSettingsModifier(
            authViewModel: authViewModel,
            showChangePassword: showChangePassword,
            confirmNewRecoveryKey: confirmNewRecoveryKey,
            showDeleteAccount: showDeleteAccount
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
    @Binding var showDeleteAccount: Bool
    @State private var shownRecoveryKey: ShownRecoveryKey?
    @State private var problem: String?
    /// While a new recovery key is being made. Each run replaces every recovery wrap, so a
    /// second one started from the menu meanwhile would retire the key the first is about
    /// to show.
    @State private var isMaking = false

    func body(content: Content) -> some View {
        content
            .allowsHitTesting(!isMaking)
            .overlay {
                if isMaking {
                    ProgressView()
                        .padding(24)
                        .background(.regularMaterial)
                        .cornerRadius(12)
                }
            }
            .sheet(isPresented: $showChangePassword) {
                ChangePasswordView()
                    .environmentObject(authViewModel)
                    #if os(macOS)
                    .frame(minWidth: 380, minHeight: 380)
                    #endif
            }
            .sheet(isPresented: $showDeleteAccount) {
                DeleteAccountView()
                    .environmentObject(authViewModel)
                    #if os(macOS)
                    .frame(minWidth: 420, minHeight: 460)
                    #endif
            }
            .sheet(item: $shownRecoveryKey) { shown in
                RecoveryKeyView(recoveryKey: shown.key) {
                    authViewModel.recoveryKeySaved()
                    shownRecoveryKey = nil
                }
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
        guard !isMaking else { return }
        isMaking = true
        Task {
            do {
                shownRecoveryKey = ShownRecoveryKey(key: try await authViewModel.newRecoveryKey())
            } catch {
                problem = AuthViewModel.message(for: error)
            }
            isMaking = false
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

/// What deleting the account takes with it, then the password. A sheet rather than an
/// alert: the consequences need more than an alert's line, the password needs a field, and
/// a wrong password or a refusal from the server has to be shown where it can be retried.
///
/// On success the session ends (`AuthViewModel.deleteAccount`), which replaces the main
/// screen, and this sheet with it, by the sign-in screen.
struct DeleteAccountView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var password = ""
    @State private var isWorking = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("This permanently deletes your PushThat account and its email address, every push and file, and your encryption keys and recovery key. Every device is signed out.")
                    Text("Your pushes are encrypted, so once they are deleted nobody can recover them, including us.")
                    Text("A Pro subscription is cancelled.")
                }
                Section {
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .disabled(isWorking)
                } footer: {
                    Text("Enter your password to confirm.")
                }
                if let problem {
                    Section {
                        Text(problem)
                            .foregroundColor(.red)
                    }
                }
                Section {
                    Button(role: .destructive) { delete() } label: {
                        HStack {
                            Text(isWorking ? "Deleting account…" : "Delete account")
                            if isWorking {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(isWorking || password.isEmpty)
                } footer: {
                    // The call stays open until the server has deleted everything, which
                    // for a large account is minutes. iOS suspends an app soon after it is
                    // put away, and on a Mac quitting the app or the Mac sleeping does the
                    // same: the call is lost, the account is still deleted, and this sheet
                    // can then only say it could not confirm that.
                    if isWorking {
                        Text("Keep PushThat open until this finishes. It can take a few minutes.")
                    }
                }
            }
            .navigationTitle("Delete account")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isWorking)
                }
            }
            // Not while it runs: the deletion carries on on the server either way, and a
            // closed sheet would hide whether it finished.
            .interactiveDismissDisabled(isWorking)
        }
    }

    private func delete() {
        // A second tap while the first runs would re-authenticate and call the server again.
        guard !isWorking else { return }
        isWorking = true
        problem = nil
        Task {
            do {
                try await authViewModel.deleteAccount(password: password)
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
