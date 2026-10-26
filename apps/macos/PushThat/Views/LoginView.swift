import SwiftUI

struct LoginView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @State private var email = ""
    @State private var password = ""
    @FocusState private var focusedField: Field?

    enum Field {
        case email, password
    }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Logo
            Image("Logo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 96, height: 96)

            // Title
            Text("Sign in to PushThat")
                .font(.title)
                .fontWeight(.bold)

            // Input fields
            VStack(spacing: 16) {
                TextField("Email", text: $email)
                    .textFieldStyle(PushThatTextFieldStyle())
                    .textContentType(.emailAddress)
                    .disableAutocorrection(true)
                    .focused($focusedField, equals: .email)
                    .onSubmit { focusedField = .password }

                SecureField("Password", text: $password)
                    .textFieldStyle(PushThatTextFieldStyle())
                    .textContentType(.password)
                    .focused($focusedField, equals: .password)
                    .onSubmit { signIn() }

                // Under the field rather than only as the error, so that a new account
                // picks a long password before Register refuses a short one. Sign-in keeps
                // taking shorter ones, which existing accounts have.
                Text(AuthViewModel.newPasswordRule)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: 300)

            // Forgot password
            Button("Forgot your password?") {
                authViewModel.resetPassword(email: email)
            }
            .font(.subheadline)
            .foregroundColor(.secondary)
            .buttonStyle(.plain)

            // Action buttons
            VStack(spacing: 12) {
                Button(action: signIn) {
                    Text(authViewModel.isSigningIn ? "Signing in..." : "Sign In")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.pink200)
                        .foregroundColor(.white)
                        .cornerRadius(8)
                }
                .buttonStyle(.plain)
                .disabled(authViewModel.isLoading)

                Button(action: register) {
                    Text(authViewModel.isRegistering ? "Creating account..." : "Register")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .foregroundColor(.pink200)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(Color.pink200, lineWidth: 2)
                        )
                }
                .buttonStyle(.plain)
                .disabled(authViewModel.isLoading)
            }
            .frame(maxWidth: 300)

            Spacer()
        }
        .padding()
    }

    private func signIn() {
        focusedField = nil
        authViewModel.signIn(email: email, password: password)
    }

    private func register() {
        focusedField = nil
        authViewModel.register(email: email, password: password)
    }
}

// MARK: - Custom Text Field Style
struct PushThatTextFieldStyle: TextFieldStyle {
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration
            .padding()
            .background(Color.inputBackground)
            .cornerRadius(8)
    }
}

#Preview {
    LoginView()
        .environmentObject(AuthViewModel())
}
