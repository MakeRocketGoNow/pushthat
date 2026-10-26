import AppKit
import FirebaseCore
import FirebaseAuth

class AppDelegate: NSObject, NSApplicationDelegate {

    func applicationDidFinishLaunching(_ notification: Notification) {
        FirebaseApp.configure()

        // Configure Firebase Auth to use shared keychain for app extension support
        // Use team-based keychain group (not app group) to avoid permission popups
        let keychainAccessGroup = "$(TeamIdentifierPrefix)com.makerocketgonow.pushthatapp"
        do {
            try Auth.auth().useUserAccessGroup(keychainAccessGroup)
        } catch {
            print("Failed to configure shared keychain for Auth: \(error)")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Clean up if needed
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }
}
