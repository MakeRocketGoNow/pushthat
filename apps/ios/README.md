# PushThat iOS

iOS version of PushThat - a cross-device link and file sharing app.

## Requirements

- Xcode 15.0+
- iOS 17.0+
- Swift 5.9+
- Firebase account with the `push-that` project

## Setup

### 1. Firebase Configuration

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select the `push-that` project
3. Click "Add app" and select iOS
4. Enter bundle ID: `com.makerocketgonow.pushthat`
5. Download `GoogleService-Info.plist`
6. Replace the placeholder file at `PushThat/Resources/GoogleService-Info.plist`

### 2. Push Notifications (APNs)

1. Go to [Apple Developer Portal](https://developer.apple.com)
2. Create an APNs Authentication Key
3. Upload the key to Firebase Console > Project Settings > Cloud Messaging
4. Set your Development Team in Xcode project settings

### 3. Open in Xcode

```bash
open PushThat.xcodeproj
```

Xcode will automatically fetch the Firebase SDK dependencies.

### 4. Build & Run

1. Select your target device or simulator
2. Press Cmd+R to build and run

## Project Structure

```
PushThat/
├── App/
│   ├── PushThatApp.swift      # App entry point
│   ├── AppDelegate.swift       # Push notification handling
│   └── RootView.swift          # Auth state routing
├── Models/
│   ├── PushItem.swift          # Firestore push document
│   ├── PendingPush.swift       # Local cache entity
│   └── UserDocument.swift      # User profile model
├── Views/
│   ├── LoginView.swift         # Authentication screen
│   ├── MainView.swift          # Push list with search
│   ├── PushRowView.swift       # List item view
│   └── SwivelCheckView.swift   # 3D flip checkbox
├── ViewModels/
│   ├── AuthViewModel.swift     # Auth logic
│   └── PushListViewModel.swift # List management
├── Services/
│   ├── SearchTokenGenerator.swift  # Search algorithm
│   └── TitleScraperService.swift   # URL title extraction
├── Database/
│   └── RetryManager.swift      # Background retry logic
├── Utilities/
│   ├── Colors.swift            # App color scheme
│   ├── FileTypeIcons.swift     # File extension icons
│   ├── RelativeTimeFormatter.swift
│   └── URLValidator.swift
└── Resources/
    ├── Assets.xcassets         # App icons & colors
    └── GoogleService-Info.plist

PushThatShareExtension/
├── ShareViewController.swift   # Share sheet handler
└── Info.plist                  # Extension config
```

## Features

- **Authentication**: Email/password sign in and registration
- **Push List**: View all pushed links and files with search
- **Infinite Scroll**: Pagination with 10 items per page
- **Share Extension**: Share URLs and files from any app
- **Push Notifications**: Receive alerts when content is shared
- **Offline Support**: Failed uploads cached and retried
- **3D Animations**: Custom flip checkbox matching Android

## Cross-Platform Compatibility

This app shares the same Firebase backend as the Android version:
- Same Firestore collections (`pushes`, `users`)
- Same Firebase Storage bucket
- Same search token algorithm
- FCM tokens stored together for cross-device notifications

## Architecture

- **SwiftUI** for declarative UI
- **MVVM** pattern with ObservableObject ViewModels
- **SwiftData** for local persistence
- **Async/await** for asynchronous operations
- **Combine** for reactive updates
