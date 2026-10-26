import SwiftUI

/// After a sign-in whose password opens no wrap while a recovery wrap exists: the password
/// was set somewhere that could not rewrap the account key (a reset through Firebase's own
/// page, or the reset page failing after the password changed). This file is the same in
/// `apps/ios` and `apps/macos`.
struct RecoveryPromptView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var recoveryKey = ""
    @State private var confirmStartOver = false

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                Text("Enter your recovery key")
                    .font(.title)
                    .fontWeight(.bold)
                    .multilineTextAlignment(.center)

                Text("Your password was changed in a way that could not update your encryption keys. Enter your recovery key to keep your pushes.")
                    .multilineTextAlignment(.center)

                recoveryKeyField

                Button(action: recover) {
                    Text(authViewModel.isLoading ? "Checking..." : "Continue")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.pink200)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .disabled(authViewModel.isLoading || recoveryKey.isEmpty)

                Button("I don't have it") {
                    confirmStartOver = true
                }
                .foregroundColor(.pink200)
                .disabled(authViewModel.isLoading)

                Button("Sign out") {
                    authViewModel.signOut()
                }
                .foregroundColor(.secondary)
                .disabled(authViewModel.isLoading)
            }
            .padding(32)
            .padding(.top, 48)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
        // Said before anything is replaced, as the reset page says it: without the key
        // the account starts a new key and the old pushes cannot be opened again.
        .alert("Pushes encrypted before now will not be readable on any device.", isPresented: $confirmStartOver) {
            Button("Continue", role: .destructive) {
                authViewModel.startOverWithoutRecoveryKey()
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var recoveryKeyField: some View {
        let field = TextField("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX", text: $recoveryKey)
            .textFieldStyle(PushThatTextFieldStyle())
            .font(.system(.body, design: .monospaced))
            .autocorrectionDisabled()
            .onSubmit(recover)
        #if os(iOS)
        field.textInputAutocapitalization(.characters)
        #else
        field
        #endif
    }

    private func recover() {
        guard !recoveryKey.isEmpty else { return }
        authViewModel.recover(recoveryKey: recoveryKey)
    }
}
