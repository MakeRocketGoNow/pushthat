import Foundation
import FirebaseAuth
import FirebaseFirestore

@MainActor
class AuthViewModel: ObservableObject {
    @Published var isLoading = false
    @Published var isSigningIn = false
    @Published var isRegistering = false
    @Published var showError = false
    @Published var errorMessage = ""
    @Published var isAuthenticated = false

    private let auth = Auth.auth()
    private let db = Firestore.firestore()

    init() {
        // Check if user is already signed in
        isAuthenticated = auth.currentUser != nil

        // Listen for auth state changes
        auth.addStateDidChangeListener { [weak self] _, user in
            DispatchQueue.main.async {
                self?.isAuthenticated = user != nil
            }
        }
    }

    func signIn(email: String, password: String) {
        guard validateInput(email: email, password: password) else { return }

        isLoading = true
        isSigningIn = true
        Task {
            do {
                try await auth.signIn(withEmail: email, password: password)
                // Note: FCM not available on macOS, skip token update
                isAuthenticated = true
            } catch {
                showError(error.localizedDescription)
            }
            isLoading = false
            isSigningIn = false
        }
    }

    func register(email: String, password: String) {
        guard validateInput(email: email, password: password) else { return }

        isLoading = true
        isRegistering = true
        Task {
            do {
                let result = try await auth.createUser(withEmail: email, password: password)

                // Create user document in Firestore (matches Android behavior)
                let userData = UserDocument.newUserData(email: email)
                try await db.collection("users").document(result.user.uid).setData(userData)

                // Note: FCM not available on macOS, skip token update
                isAuthenticated = true
            } catch {
                showError(error.localizedDescription)
            }
            isLoading = false
            isRegistering = false
        }
    }

    func signOut() {
        do {
            try auth.signOut()
            isAuthenticated = false
        } catch {
            showError(error.localizedDescription)
        }
    }

    func resetPassword(email: String) {
        guard !email.isEmpty else {
            showError("Please enter your email address")
            return
        }

        isLoading = true
        Task {
            do {
                try await auth.sendPasswordReset(withEmail: email)
                showError("Password reset email sent")
            } catch {
                showError(error.localizedDescription)
            }
            isLoading = false
        }
    }

    private func validateInput(email: String, password: String) -> Bool {
        if email.isEmpty {
            showError("Please enter your email")
            return false
        }

        if password.isEmpty {
            showError("Please enter your password")
            return false
        }

        if password.count < 6 {
            showError("Password must be at least 6 characters")
            return false
        }

        return true
    }

    private func showError(_ message: String) {
        errorMessage = message
        showError = true
    }
}
