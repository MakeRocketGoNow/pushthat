# iOS app

`apps/ios` is a SwiftUI app with a share extension, on the same Firebase project as every
other client. It needs Xcode 15 or later and runs on iOS 17 or later.

## Building

```bash
cd apps/ios
open PushThat.xcodeproj
```

Xcode fetches the Firebase SDK through Swift Package Manager; the resolved versions are
pinned in `PushThat.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`,
and the `PushThat` and `PushThatShareExtension` schemes are shared, so a fresh clone builds
the same thing from the command line:

```bash
xcodebuild -project PushThat.xcodeproj -scheme PushThat -destination 'generic/platform=iOS Simulator' build
```

The `PushThatTests` target checks the encryption ([e2ee](e2ee.md)) byte for byte against
`packages/push-test/vectors.json`, which it copies in from the repository: the keys, the
push envelope, the search tokens and their blind index, and the file format. It runs on any
simulator you have (`xcrun simctl list devices available`; add `,OS=` and the version when
a name has several):

```bash
xcodebuild -project PushThat.xcodeproj -scheme PushThat -destination 'platform=iOS Simulator,name=iPhone 16 Pro' test
```

The project carries no development team (`DEVELOPMENT_TEAM` is empty), so signing for a
device needs your own: select the project, then each of the two targets, Signing &
Capabilities, and pick a team. A simulator build needs none.

The Firebase client config is `PushThat/Resources/GoogleService-Info.plist`, for the
bundle id `com.makerocketgonow.pushthat`. It is public by design: it names the project, and
the Firestore and Storage rules are what protect it.

## Push notifications

Notifications go through APNs: an APNs authentication key from the Apple Developer portal
is uploaded to the Firebase console (Project Settings, Cloud Messaging), and the app needs
a development team set so it is signed with the push entitlement.

An encrypted push's notification carries only the push's id and a "New push" alert with
`mutable-content` ([end-to-end encryption](e2ee.md), Notifications). The
`PushThatNotificationService` target, a notification service extension embedded in the
app, replaces it before it is shown: it gets an ID token from FirebaseAuth (on the shared
access group, like the share extension), reads the push over the Firestore REST API with
`URLSession` (the Firestore SDK does not fit the extension's memory limit), decrypts it
with the account key from the shared Keychain, and sets the title, the body and the URL
the app opens on a tap. Anything that fails, or the time running out, leaves "New push".
It cannot drop a notification (that needs Apple's filtering entitlement), so the iPhone
that sent a push shows it too, decrypted; the app hides it only while in the foreground.
Signing it needs an App ID `com.makerocketgonow.pushthat.PushThatNotificationService`
with the App Group `group.com.makerocketgonow.pushthat`, as the share extension has.

## How it is built

```
PushThat/
  App/          PushThatApp (entry point), AppDelegate (notifications), RootView (routes on sign-in)
  Models/       PushItem (a Firestore push), PendingPush (the local retry cache), UserDocument
  Views/        LoginView, MainView (the push list and search), PushRowView, SwivelCheckView
  ViewModels/   AuthViewModel, PushListViewModel
  Services/     UploadService, FileUploadUtils (the plan and upload limits), SearchTokenGenerator,
                TitleScraperService, E2eeCrypto (every construction in docs/e2ee.md),
                AccountKeyStore and AccountKeyService (the account key), PushContent and
                PushDocuments (the push envelope and its documents), PushFileOpener
                (downloads and decrypts a file), PushMigration (encrypts old pushes in place)
  Database/     RetryManager (retries failed uploads in the background)
  Utilities/    Colors, FileTypeIcons, RelativeTimeFormatter, URLValidator
  Resources/    Assets.xcassets, GoogleService-Info.plist
PushThatShareExtension/
  ShareViewController   pushes what is shared from any app
PushThatNotificationService/
  NotificationService   decrypts an encrypted push's notification before it is shown
```

SwiftUI views with ObservableObject view models, SwiftData for the local retry cache, and
async/await throughout. The app icon's source art is `icons/app-icon.svg`.

It is built to match the Android app: the same Firestore collections (`pushes`, `users`),
the same Storage bucket, the same search tokenizer and blind index (so a push made on one
platform is found by search on the other), and FCM tokens stored together on the user document so a
push reaches every device. The flip checkbox is drawn to match Android's.
