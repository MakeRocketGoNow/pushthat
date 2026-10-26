# PushThat for macOS

A native macOS app for PushThat, allowing you to push links and files between devices.

## Features

- **Share Extension**: Share URLs, images, PDFs, videos, and files from any macOS app
- **Drag and Drop**: Drag files and URLs directly onto the main window
- **Cross-Platform Sync**: Shares the same Firebase backend as iOS/Android apps
- **Dark Mode**: Optimized for dark mode

## Requirements

- macOS 13 Ventura or later
- Xcode 15 or later
- Swift 5.9 or later

## Setup

### 1. Open the Project

Open `PushThat.xcodeproj` in Xcode.

### 2. Configure Signing

1. Select the project in Xcode
2. Select the "PushThat" target
3. Go to "Signing & Capabilities"
4. Select your development team
5. Repeat for the "PushThatShareExtension" target

### 3. Firebase Configuration

The `GoogleService-Info.plist` has been pre-configured for the macOS app. It uses the same Firebase project as the iOS app to share user accounts and data.

### 4. Build and Run

Select the "PushThat" scheme and run (⌘R).

## Architecture

The app is structured similarly to the iOS version:

- **App/**: App entry point and delegate
- **Models/**: Data models (PushItem, PendingPush, UserDocument)
- **Views/**: SwiftUI views
- **ViewModels/**: View models for business logic
- **Services/**: Firebase and upload services
- **Utilities/**: Colors, formatters, and helpers

## Key Differences from iOS

1. **No Push Notifications**: FCM is not available on macOS, so the app uses pull-based refreshing
2. **Team-Based Keychain Sharing**: Uses `$(TeamIdentifierPrefix)com.makerocketgonow.pushthatapp` instead of app groups to avoid permission popups
3. **NSWorkspace/NSPasteboard**: Uses macOS APIs for opening URLs and clipboard
4. **Drag and Drop**: Main window supports drag-and-drop for files and URLs
5. **Host.current()**: Uses macOS API for device name instead of UIDevice

## Bundle Identifiers

- Main App: `com.makerocketgonow.pushthatapp.macos`
- Share Extension: `com.makerocketgonow.pushthatapp.macos.share`

## Share Extension

The share extension allows sharing from any macOS app that supports the share sheet:

- Safari (URLs and PDFs)
- Finder (files)
- Preview (images, PDFs)
- Any app with share support

Supported content types:
- URLs (web links)
- Images (PNG, JPEG, GIF, HEIC, WebP)
- PDFs
- Videos (MP4, MOV)
- Generic files

## Troubleshooting

### "Please sign in to PushThat first"

Make sure you've signed in to the main PushThat app at least once before using the share extension. The share extension uses shared keychain access to authenticate with your account.

### Share extension not appearing

1. Make sure both targets have the same team selected
2. Clean build folder (⇧⌘K)
3. Delete the app and reinstall
4. Check System Preferences > Extensions > Share Extensions
