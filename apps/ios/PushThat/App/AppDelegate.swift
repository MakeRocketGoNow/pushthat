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
//
// An encrypted push arrives as `{pushId, type, deviceId, keyVersion}` and an APNs alert of
// "New push", which `PushThatNotificationService` has already replaced with the decrypted
// title and body (and the URL, in `userInfo`) by the time either method below sees it,
// unless it could not. A push made before encryption still carries `{title, url,
// deviceName, ...}` and is handled as it always was.
extension AppDelegate: UNUserNotificationCenterDelegate {

    // Handle foreground notifications
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let userInfo = notification.request.content.userInfo
        if userInfo["keyVersion"] != nil, let deviceId = userInfo["deviceId"] as? String,
           deviceId == (try? AccountKeyStore.deviceId()) {
            // This install's own push: the extension cannot drop it, but the app can keep it
            // off the screen while it is in front.
            completionHandler([])
            return
        }
        if isFromAnotherDevice(userInfo) {
            NotificationCenter.default.post(name: .pushReceived, object: nil)
        }

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
            completionHandler()
            return
        }

        // "New push": the extension could not read it (offline, out of time). The app is
        // open now, so it reads the push itself and opens its URL; a file push, or one that
        // still does not open, leaves the app on its list.
        guard let pushId = userInfo["pushId"] as? String, userInfo["type"] as? String == "url" else {
            completionHandler()
            return
        }
        Task { @MainActor in
            if let url = await Self.decryptedURL(pushId: pushId) {
                await UIApplication.shared.open(url)
            }
            completionHandler()
        }
    }

    /// Echo suppression: by the install's `deviceId` for an encrypted push, by the device's
    /// name for one sent before encryption.
    private func isFromAnotherDevice(_ userInfo: [AnyHashable: Any]) -> Bool {
        if userInfo["keyVersion"] != nil, let deviceId = userInfo["deviceId"] as? String {
            return deviceId != (try? AccountKeyStore.deviceId())
        }
        guard let deviceName = userInfo["deviceName"] as? String else { return false }
        return deviceName != UIDevice.current.name
    }

    private static func decryptedURL(pushId: String) async -> URL? {
        guard let uid = Auth.auth().currentUser?.uid, let keys = PushKeys.load(uid: uid),
              let snapshot = try? await Firestore.firestore().collection("pushes").document(pushId).getDocument(),
              let item = PushItem(document: snapshot, keys: keys),
              item.type == .url, !item.isLocked
        else { return nil }
        return URL(string: item.url)
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
