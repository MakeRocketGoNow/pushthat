import SwiftUI

struct RootView: View {
    @EnvironmentObject var authViewModel: AuthViewModel

    var body: some View {
        Group {
            if !authViewModel.isAuthenticated {
                LoginView()
            } else {
                // A session is not enough to show pushes: the device also needs the
                // account key, and a new recovery key is seen before the app opens.
                switch authViewModel.keyGate {
                case .ready:
                    MainView()
                case .unlock:
                    UnlockView()
                case .recovery:
                    RecoveryPromptView()
                case .recoveryKey(let recoveryKey):
                    RecoveryKeyView(recoveryKey: recoveryKey, onSaved: authViewModel.recoveryKeySaved)
                }
            }
        }
        .animation(.easeInOut, value: authViewModel.isAuthenticated)
        .animation(.easeInOut, value: authViewModel.keyGate)
        // Here rather than on LoginView, so that the unlock and recovery screens show the
        // sign-in's errors too.
        .alert("Notice", isPresented: $authViewModel.showError) {
            Button("OK") {}
        } message: {
            Text(authViewModel.errorMessage)
        }
        .preferredColorScheme(.dark)
    }
}

#Preview {
    RootView()
        .environmentObject(AuthViewModel())
}
