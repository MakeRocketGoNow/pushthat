# Android app

`apps/android` is a Kotlin app with views (not Compose): `LoginActivity` signs in,
`MainActivity` is the push list, `ShareActivity` is the share target that pushes a link or
a file from any app, and `PushThatMessagingService` turns an FCM message into a
notification. A push that fails on the network is retried by a WorkManager worker once
there is a connection. It talks to the same Firebase project as every other client, with
the client config in `app/google-services.json`.

## Building

It is a Gradle project with its own wrapper, outside any npm folder. Gradle needs to know
where the Android SDK is: `local.properties` (gitignored, machine-local) holds it.

```bash
cd apps/android
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties
./gradlew test
./gradlew assembleDebug
```

The Gradle daemon runs on the JDK named in `gradle/gradle-daemon-jvm.properties`, which the
foojay resolver in `settings.gradle.kts` downloads if it is not installed, so a fresh clone
provisions it on its own. The app compiles to Java 17.

## Running it on an emulator

`scripts/run.sh` installs the debug APK on an emulator and launches it, booting the AVD
first if it is not running. `scripts/build-and-run.sh` assembles the APK first. Both take
`--avd NAME` (default `Pixel_9_API_35`), and find the SDK from `local.properties`, then
`ANDROID_HOME`, then `ANDROID_SDK_ROOT`, then `~/Library/Android/sdk`.

## Release signing

Release signing credentials live in `keystore.properties`, which is gitignored, as is any
keystore. Without it the release build is left unsigned, which is what a fresh clone gets.
With it, `./gradlew bundleRelease` produces a signed AAB ready to upload.

```bash
cp keystore.properties.example keystore.properties
```

It names the keystore (`storeFile`, a relative path resolves against `apps/android`, an
absolute one is used as given; keeping it outside the repository is recommended), its
`storePassword` and `keyPassword` (the same value for a PKCS12 keystore) and the
`keyAlias`. A wrong `storeFile` fails the build rather than falling back to unsigned, so a
typo cannot quietly ship an unsigned bundle.

## Conventions

Every string is in `res/values/strings.xml`. The app works in light and dark mode, using
the semantic colors in `res/values/colors.xml` and `res/values-night/colors.xml`, and new
styles go in `themes.xml`.
