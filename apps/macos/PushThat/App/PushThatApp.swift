import SwiftUI
import FirebaseCore
import SwiftData

@main
struct PushThatApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var authViewModel = AuthViewModel()
    @StateObject private var ageGate = AgeGate()

    var sharedModelContainer: ModelContainer = {
        let schema = Schema([PendingPush.self])
        let modelConfiguration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)

        do {
            return try ModelContainer(for: schema, configurations: [modelConfiguration])
        } catch {
            fatalError("Could not create ModelContainer: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(authViewModel)
                .environmentObject(ageGate)
                // Here on the root rather than in RootView, whose Group hands its modifiers to
                // each screen in turn: the request would be cancelled each time the screen
                // changed under it.
                .checksAge(with: ageGate)
                // A device the system says belongs to someone under 18 (AgeGate) is signed
                // out, so that nothing more is read or sent for them. Not while
                // a sign-in or registration is mid-step, since stopping one partway can leave
                // an account's keys half written; it signs out once the step is done, or at
                // the next launch.
                .onChange(of: ageGate.isBlocked && authViewModel.isAuthenticated && !authViewModel.isLoading, initial: true) { _, mustSignOut in
                    if mustSignOut { authViewModel.signOutAtAgeGate() }
                }
                .modelContainer(sharedModelContainer)
                .frame(minWidth: 400, minHeight: 500)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 500, height: 700)
    }
}
