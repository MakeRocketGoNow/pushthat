# macOS app

`apps/macos` is a native macOS app, a hand-maintained fork of the iOS app rather than a
shared target: the views, models and services are copies adapted to AppKit's APIs. A change
to shared behavior (the push format, search tokens, the plan) is made in both. It needs
Xcode 15 or later.

## Building

```bash
cd apps/macos
open PushThat.xcodeproj
```

Or from the command line, unsigned:

```bash
xcodebuild -project PushThat.xcodeproj -scheme PushThat -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build
```

The `PushThatTests` target checks the encryption ([e2ee](e2ee.md)) byte for byte against
`packages/push-test/vectors.json`: the keys, the push envelope, the search tokens and their
blind index, and the file format. It compiles the files it tests instead of loading the
app, and the scheme does not build the app for testing, so the vectors are checked even
while the app itself does not build (see the deployment target below):

```bash
xcodebuild -project PushThat.xcodeproj -scheme PushThat -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test
```

The project carries no development team. To run it signed, select the project, then the
`PushThat` and `PushThatShareExtension` targets in turn, Signing & Capabilities, and pick
the same team for both: the share extension finds the signed-in account through a keychain
group under that team's prefix, so a mismatch leaves it unable to sign in.

`PushThat/Resources/GoogleService-Info.plist` is the macOS app's own Firebase client config
in the same `push-that` project as iOS, so accounts and pushes are shared. Bundle ids:
`com.makerocketgonow.pushthatapp.macos` for the app and
`com.makerocketgonow.pushthatapp.macos.share` for the extension.

## Known issue: the deployment target

The project targets macOS 13.0, but the local retry cache (`PendingPush`, and the
`ModelContainer` in `PushThatApp`) uses SwiftData, which needs macOS 14. With Xcode 26 the
build above fails on exactly that ("only available in macOS 14 or newer"). Raising
`MACOSX_DEPLOYMENT_TARGET` to 14.0 in the project's build settings is the likely fix; it has not been made
yet, so treat macOS 14 as the real minimum.

## How it differs from iOS

1. **No push notifications.** FCM is not used on macOS, so the app refreshes by pulling.
2. **Keychain sharing by team.** The app and its extension share sign-in through
   `$(TeamIdentifierPrefix)com.makerocketgonow.pushthatapp` rather than an app group, which
   avoids the permission prompt an app group raises.
3. **macOS APIs.** `NSWorkspace` and `NSPasteboard` for opening links and the clipboard,
   `Host.current()` for the device's name.
4. **Drag and drop.** The main window takes files and URLs dropped on it.

The share extension takes URLs, images (PNG, JPEG, GIF, HEIC, WebP), PDFs, videos (MP4,
MOV) and other files from any app with a share menu: Safari, Finder, Preview and the rest.

## Troubleshooting

- **"Please sign in to PushThat first" in the share extension.** Sign in to the main app
  once; the extension reads the account from the shared keychain.
- **The share extension does not appear.** Check that both targets have the same team,
  clean the build folder (Shift-Command-K), delete and reinstall the app, and look under
  System Settings, Extensions, Sharing.
