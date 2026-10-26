import Foundation
import FirebaseAuth
import FirebaseFirestore

@MainActor
class AuthViewModel: ObservableObject {
    /// What stands between a Firebase session and the push list (docs/e2ee.md, "Keys").
    /// RootView shows the screen for each; `.ready` is the list itself, or the sign-in
    /// screen when there is no session.
    enum KeyGate: Equatable {
        case ready
        /// A session with no key on this device (an install that updated while signed in):
        /// ask for the password once and derive.
        case unlock
        /// No password wrap opens but a recovery wrap exists.
        case recovery
        /// A recovery key was just made: shown once, and the app opens on "I saved it".
        case recoveryKey(String)
    }

    @Published var isLoading = false
    @Published var isSigningIn = false
    @Published var isRegistering = false
    @Published var showError = false
    @Published var errorMessage = ""
    @Published var isAuthenticated = false
    @Published var keyGate: KeyGate = .ready

    /// Sign-up's rule and its reason, word for word as every client has it.
    static let newPasswordRule = "Use at least 10 characters. Your password is the key to your pushes, so it has to be hard to guess."
    static let minimumNewPasswordLength = 10

    private let auth = Auth.auth()
    private let db = Firestore.firestore()

    /// Set while a sign-in, registration or recovery runs, so that the auth listener does
    /// not route on the session it sees partway through (signed in, keys not yet written).
    private var keyFlowRunning = false

    /// What the recovery prompt needs from the sign-in that led to it.
    private struct PendingRecovery {
        let uid: String
        let email: String
        let keys: E2eeCrypto.DerivedKeys
        let legacy: Bool
        let stored: StoredE2ee
    }
    private var pendingRecovery: PendingRecovery?

    init() {
        if let user = auth.currentUser {
            isAuthenticated = true
            keyGate = Self.gate(for: AccountKeyStore.accountKey(for: user.uid))
        } else {
            // Signed out while the app was not running (see `sessionChanged`).
            AccountKeyStore.clearAccountKey()
        }

        // Listen for auth state changes
        auth.addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in
                self?.sessionChanged(user)
            }
        }
    }

    /// The signed-in account's email, for the unlock prompt.
    var currentEmail: String { auth.currentUser?.email ?? "" }

    private func sessionChanged(_ user: User?) {
        guard !keyFlowRunning else { return }
        guard let user else {
            // Not only the app's own "Sign out" ends a session: Firebase drops it when the
            // tokens are revoked (a password changed on another device) or the account is
            // disabled. The key goes with it, as `signOut()` takes it, so that no key is
            // left behind for whoever signs in next. Checked against the live session, since
            // this runs from a queued task and a sign-in may have landed since.
            if auth.currentUser == nil {
                AccountKeyStore.clearAccountKey()
            }
            isAuthenticated = false
            keyGate = .ready
            pendingRecovery = nil
            return
        }
        isAuthenticated = true
        if keyGate == .ready {
            keyGate = Self.gate(for: AccountKeyStore.accountKey(for: user.uid))
        }
    }

    /// The screen a session opens on, from what the Keychain holds: the password prompt
    /// with no key, the recovery key screen while a recovery key waits for "I saved it",
    /// the push list otherwise.
    private static func gate(for stored: StoredAccountKey?) -> KeyGate {
        guard let stored else { return .unlock }
        return stored.unsavedRecoveryKey.map { .recoveryKey($0) } ?? .ready
    }

    // MARK: - Sign in

    func signIn(email: String, password: String) {
        guard validateInput(email: email, password: password) else { return }

        isLoading = true
        isSigningIn = true
        Task {
            await runKeyFlow { try await self.signInWithKeys(email: email, password: password) }
            isLoading = false
            isSigningIn = false
        }
    }

    /// The unlock prompt: the same sign-in, for the account already signed in.
    func unlock(password: String) {
        guard !password.isEmpty else {
            showError("Please enter your password")
            return
        }
        isLoading = true
        Task {
            await runKeyFlow { try await self.signInWithKeys(email: self.currentEmail, password: password) }
            isLoading = false
        }
    }

    /// Signs in with `base64url(authKey)`, falling back to the raw password for an account
    /// that has not moved yet, then finds the account key (docs/e2ee.md, "Migration").
    private func signInWithKeys(email: String, password: String) async throws {
        let keys = try await Self.derive(email: email, password: password)

        let result: AuthDataResult
        var legacy = false
        do {
            result = try await auth.signIn(withEmail: email, password: keys.firebasePassword)
        } catch let first where Self.isWrongPassword(first) {
            // Only a wrong password can mean a legacy account: a network error or
            // too-many-requests says nothing about which password Firebase holds. When both
            // fail, the first error is the one reported; the raw password's would say the
            // same thing about a password the user did not knowingly send.
            do {
                result = try await auth.signIn(withEmail: email, password: password)
                legacy = true
            } catch {
                throw first
            }
        }
        let uid = result.user.uid
        let stored = try await AccountKeyService.read(uid: uid)

        switch AccountKeyService.resolve(uid: uid, masterKey: keys.masterKey, stored: stored) {
        case let .opened(accountKey, keyVersion):
            var recoveryKey: String?
            if legacy {
                // An earlier migration wrote the keys and stopped before updatePassword, so
                // the user may never have seen the recovery key: make one they will see.
                recoveryKey = try await AccountKeyService.replaceRecoveryKey(uid: uid, email: email, accountKey: accountKey, keyVersion: keyVersion)
                try await result.user.updatePassword(to: keys.firebasePassword)
            }
            try finish(uid: uid, accountKey: accountKey, keyVersion: keyVersion, recoveryKey: recoveryKey)

        case let .needsRecovery(stored):
            pendingRecovery = PendingRecovery(uid: uid, email: email, keys: keys, legacy: legacy, stored: stored)
            isAuthenticated = true
            keyGate = .recovery

        case .needsNewKeys:
            let new = try await AccountKeyService.startNewKeys(uid: uid, email: email, masterKey: keys.masterKey)
            if legacy {
                // After the keys are written, never before: a crash between leaves an
                // account that still signs in with the raw password and finds its wrap.
                try await result.user.updatePassword(to: keys.firebasePassword)
            }
            try finish(uid: uid, accountKey: new.accountKey, keyVersion: new.keyVersion, recoveryKey: new.recoveryKey)
        }
        // Note: FCM not available on macOS, skip token update
    }

    // MARK: - Register

    func register(email: String, password: String) {
        guard validateInput(email: email, password: password) else { return }
        guard password.count >= Self.minimumNewPasswordLength else {
            showError(Self.newPasswordRule)
            return
        }

        isLoading = true
        isRegistering = true
        Task {
            await runKeyFlow {
                let keys = try await Self.derive(email: email, password: password)
                let result = try await self.auth.createUser(withEmail: email, password: keys.firebasePassword)
                let uid = result.user.uid
                // Creates the user document with the keys, or adds them to one a token
                // write made first.
                let new = try await AccountKeyService.startNewKeys(uid: uid, email: email, masterKey: keys.masterKey)
                try self.finish(uid: uid, accountKey: new.accountKey, keyVersion: new.keyVersion, recoveryKey: new.recoveryKey)
                // Note: FCM not available on macOS, skip token update
            }
            isLoading = false
            isRegistering = false
        }
    }

    // MARK: - Recovery

    func recover(recoveryKey: String) {
        guard let pending = pendingRecovery else { return }
        isLoading = true
        Task {
            await runKeyFlow {
                let opened = try await AccountKeyService.rewrapWithRecoveryKey(
                    uid: pending.uid, email: pending.email, masterKey: pending.keys.masterKey,
                    stored: pending.stored, recoveryText: recoveryKey
                )
                try await self.updatePasswordIfLegacy(pending)
                try self.finish(uid: pending.uid, accountKey: opened.accountKey, keyVersion: opened.keyVersion, recoveryKey: nil)
            }
            isLoading = false
        }
    }

    /// "I don't have it", once the user has confirmed that the old pushes go: a new
    /// account key one version up.
    func startOverWithoutRecoveryKey() {
        guard let pending = pendingRecovery else { return }
        isLoading = true
        Task {
            await runKeyFlow {
                let new = try await AccountKeyService.startNewKeys(uid: pending.uid, email: pending.email, masterKey: pending.keys.masterKey)
                try await self.updatePasswordIfLegacy(pending)
                try self.finish(uid: pending.uid, accountKey: new.accountKey, keyVersion: new.keyVersion, recoveryKey: new.recoveryKey)
            }
            isLoading = false
        }
    }

    private func updatePasswordIfLegacy(_ pending: PendingRecovery) async throws {
        guard pending.legacy, let user = auth.currentUser, user.uid == pending.uid else { return }
        try await user.updatePassword(to: pending.keys.firebasePassword)
    }

    /// "I saved it", on the recovery key screen and on Settings' sheet: the stored key is
    /// saved again without the recovery key, and the app opens on what the Keychain holds.
    /// No key there means the save in `finish` failed, so the password prompt finds it again.
    func recoveryKeySaved() {
        guard let user = auth.currentUser else {
            keyGate = .ready
            return
        }
        guard var stored = AccountKeyStore.accountKey(for: user.uid) else {
            keyGate = .unlock
            return
        }
        if stored.unsavedRecoveryKey != nil {
            stored.unsavedRecoveryKey = nil
            do {
                try AccountKeyStore.save(stored)
            } catch {
                // The worst this leaves is the same recovery key shown again on the next
                // launch, which is better than keeping the user on this screen.
                print("The confirmed recovery key could not be removed from the Keychain: \(error)")
            }
        }
        keyGate = .ready
    }

    // MARK: - The flow around each

    /// Keeps the account key and opens the app, or the recovery key screen first. The
    /// master key and auth key go out of scope with the caller's `keys`.
    ///
    /// When there is a recovery key, its wrap is on the server by now, so a failed Keychain
    /// save still shows it: it is the only copy the user will get. The error is shown too,
    /// and "I saved it" then finds no key and asks for the password.
    private func finish(uid: String, accountKey: Data, keyVersion: Int, recoveryKey: String?) throws {
        do {
            try AccountKeyStore.save(StoredAccountKey(uid: uid, keyVersion: keyVersion, key: accountKey, unsavedRecoveryKey: recoveryKey))
        } catch {
            guard let recoveryKey else { throw error }
            showError(Self.message(for: error))
            pendingRecovery = nil
            isAuthenticated = true
            keyGate = .recoveryKey(recoveryKey)
            return
        }
        _ = try? AccountKeyStore.deviceId()
        pendingRecovery = nil
        isAuthenticated = true
        keyGate = recoveryKey.map { .recoveryKey($0) } ?? .ready
    }

    private func runKeyFlow(_ flow: @escaping () async throws -> Void) async {
        keyFlowRunning = true
        do {
            try await flow()
        } catch {
            showError(Self.message(for: error))
            // Whatever the flow got through, route on what is true now: still signed out,
            // or signed in with no key here (which asks for the password again), or on the
            // recovery prompt it had reached.
            if let user = auth.currentUser {
                isAuthenticated = true
                if AccountKeyStore.accountKey(for: user.uid) == nil, keyGate != .recovery {
                    keyGate = .unlock
                }
            }
        }
        keyFlowRunning = false
    }

    /// PBKDF2 at 600,000 iterations takes about a second on a phone, less on a Mac: off
    /// the main actor, while the screen shows its loading state.
    nonisolated static func derive(email: String, password: String) async throws -> E2eeCrypto.DerivedKeys {
        try await Task.detached(priority: .userInitiated) {
            try E2eeCrypto.deriveKeys(email: email, password: password)
        }.value
    }

    /// Wrong password or, with email enumeration protection on, the invalid credential that
    /// stands in for it. Nothing else may send the raw password to Firebase.
    nonisolated static func isWrongPassword(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == AuthErrorDomain
            && (error.code == AuthErrorCode.wrongPassword.rawValue || error.code == AuthErrorCode.invalidCredential.rawValue)
    }

    nonisolated static func message(for error: Error) -> String {
        if let error = error as? LocalizedError, let description = error.errorDescription {
            return description
        }
        return error.localizedDescription
    }

    // MARK: - Settings

    /// A sentence to show as it is.
    struct Problem: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    /// Change password, in the spec's order (docs/e2ee.md, "The user document"): a new
    /// password wrap beside the current one, then Firebase's password, then the old wrap
    /// deleted. A crash between steps leaves an account that opens with either password,
    /// never one that opens with neither.
    func changePassword(current: String, new: String, again: String) async throws {
        guard let user = auth.currentUser, let email = user.email,
              let device = AccountKeyStore.accountKey(for: user.uid)
        else { throw AccountKeyService.KeyError.noKeys }
        guard new.count >= Self.minimumNewPasswordLength else { throw Problem(Self.newPasswordRule) }
        guard new == again else { throw Problem("The new passwords do not match.") }

        let currentKeys = try await Self.derive(email: email, password: current)
        do {
            _ = try await user.reauthenticate(with: EmailAuthProvider.credential(withEmail: email, password: currentKeys.firebasePassword))
        } catch let error where Self.isWrongPassword(error) {
            throw Problem("That is not your current password.")
        }
        let newKeys = try await Self.derive(email: email, password: new)
        let oldWrapIds = try await AccountKeyService.addPasswordWrap(
            uid: user.uid, email: email, device: device,
            currentMasterKey: currentKeys.masterKey, newMasterKey: newKeys.masterKey
        )
        try await user.updatePassword(to: newKeys.firebasePassword)
        do {
            try await AccountKeyService.removeWraps(uid: user.uid, email: email, ids: oldWrapIds)
        } catch {
            // The password is changed by now, and saying it failed would send the user to
            // change it again. The old wrap opens only with the old password and is read
            // only with the new one; a later change drops it when the map needs the room.
            print("Password changed, but the old password's wrap was not removed: \(error)")
        }
    }

    /// Show a new recovery key: every recovery wrap replaced with one under a new key,
    /// returned in its display form for the same screen sign-up shows. Kept beside the key
    /// until "I saved it" (`recoveryKeySaved`), as sign-up's is: the old key has stopped
    /// working by now, so an app closed on the sheet would otherwise leave none.
    func newRecoveryKey() async throws -> String {
        guard let user = auth.currentUser, let email = user.email,
              var device = AccountKeyStore.accountKey(for: user.uid)
        else { throw AccountKeyService.KeyError.noKeys }
        let recoveryKey = try await AccountKeyService.replaceRecoveryKey(uid: user.uid, email: email, accountKey: device.key, keyVersion: device.keyVersion)
        device.unsavedRecoveryKey = recoveryKey
        do {
            try AccountKeyStore.save(device)
        } catch {
            // The server has the new wrap already, so the key is shown regardless; only a
            // relaunch before "I saved it" would lose it.
            print("The new recovery key could not be kept until it is confirmed: \(error)")
        }
        return recoveryKey
    }

    // MARK: - Sign out

    /// Clears the account key first, so that a sign-out that fails partway never leaves a
    /// key behind for whoever signs in next. The device id stays: it is the install's.
    func signOut() {
        AccountKeyStore.clearAccountKey()
        pendingRecovery = nil
        do {
            try auth.signOut()
            isAuthenticated = false
            keyGate = .ready
        } catch {
            keyGate = .unlock
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
