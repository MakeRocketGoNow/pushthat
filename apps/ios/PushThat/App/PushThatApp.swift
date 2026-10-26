import SwiftUI
import FirebaseCore
import SwiftData

@main
struct PushThatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject private var authViewModel = AuthViewModel()

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
                .modelContainer(sharedModelContainer)
        }
    }
}
