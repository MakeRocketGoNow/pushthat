import SwiftUI

/// Before the push list, for a session with no key on this device: an install that updated
/// while signed in (docs/e2ee.md, "Where keys live on each device"). Every account signed in
/// today is legacy, so this is where most of them migrate. This file is the same in
/// `apps/ios` and `apps/macos`.
struct UnlockView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var password = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image("Logo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 96, height: 96)

                Text("PushThat now encrypts your pushes on your devices. Enter your password once to set it up here.")
                    .multilineTextAlignment(.center)

                Text(authViewModel.currentEmail)
                    .font(.headline)

                SecureField("Password", text: $password)
                    .textFieldStyle(PushThatTextFieldStyle())
                    .textContentType(.password)
                    .onSubmit(unlock)

                Button(action: unlock) {
                    Text(authViewModel.isLoading ? "Setting up..." : "Continue")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.pink200)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .disabled(authViewModel.isLoading)

                Button("Sign out") {
                    authViewModel.signOut()
                }
                .foregroundColor(.secondary)
                .disabled(authViewModel.isLoading)
            }
            .padding(32)
            .padding(.top, 48)
            .frame(maxWidth: 400)
            .frame(maxWidth: .infinity)
        }
    }

    private func unlock() {
        authViewModel.unlock(password: password)
    }
}
