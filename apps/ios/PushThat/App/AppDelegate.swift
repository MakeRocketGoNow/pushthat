import UIKit
import FirebaseCore
import FirebaseMessaging
import FirebaseAuth
import FirebaseFirestore
import UserNotifications

class AppDelegate: NSObject, UIApplicationDelegate {

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        FirebaseApp.configure()

        // Configure Firebase Auth to use shared keychain for app extension support
        let keychainAccessGroup = "group.com.makerocketgonow.pushthat"
        do {
            try Auth.auth().useUserAccessGroup(keychainAccessGroup)
        } catch {
            print("Failed to configure shared keychain for Auth: \(error)")
        }

        // Request notification permissions
        UNUserNotificationCenter.current().delegate = self
        let authOptions: UNAuthorizationOptions = [.alert, .badge, .sound]
        UNUserNotificationCenter.current().requestAuthorization(options: authOptions) { _, _ in }
        application.registerForRemoteNotifications()

        Messaging.messaging().delegate = self

        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("Failed to register for remote notifications: \(error)")
    }
}

// MARK: - UNUserNotificationCenterDelegate
extension AppDelegate: UNUserNotificationCenterDelegate {

    // Handle foreground notifications
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let userInfo = notification.request.content.userInfo
        handleNotification(userInfo: userInfo)

        // Show notification even when app is in foreground
        completionHandler([.banner, .sound, .badge])
    }

    // Handle notification tap
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo

        if let urlString = userInfo["url"] as? String,
           let url = URL(string: urlString) {
            UIApplication.shared.open(url)
        }

        completionHandler()
    }

    private func handleNotification(userInfo: [AnyHashable: Any]) {
        guard let deviceName = userInfo["deviceName"] as? String else { return }

        // Only process if from different device (matches Android behavior)
        if deviceName != UIDevice.current.name {
            NotificationCenter.default.post(name: .pushReceived, object: nil)
        }
    }
}

// MARK: - MessagingDelegate
extension AppDelegate: MessagingDelegate {

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        guard let token = fcmToken else { return }

        // Update token in Firestore
        Task {
            await updateFCMToken(token)
        }
    }

    private func updateFCMToken(_ token: String) async {
        guard let userId = Auth.auth().currentUser?.uid else { return }

        do {
            try await Firestore.firestore()
                .collection("users")
                .document(userId)
                .updateData(["fcmTokens": FieldValue.arrayUnion([token])])
        } catch {
            print("Failed to update FCM token: \(error)")
        }
    }
}

// MARK: - Notification Names
extension Notification.Name {
    static let pushReceived = Notification.Name("pushReceived")
}
