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
With it, `./gradlew bundleRelease` produces a signed AAB, for trying a release build
locally; bundles for Play come from CI (see [Shipping to Play](#shipping-to-play)).

```bash
cp keystore.properties.example keystore.properties
```

It names the keystore (`storeFile`, a relative path resolves against `apps/android`, an
absolute one is used as given; keeping it outside the repository is recommended), its
`storePassword` and `keyPassword` (the same value for a PKCS12 keystore) and the
`keyAlias`. A wrong `storeFile` fails the build rather than falling back to unsigned, so a
typo cannot quietly ship an unsigned bundle.

Each value can also come from the environment, which is how CI signs:
`PUSHTHAT_KEYSTORE_PATH`, `PUSHTHAT_KEYSTORE_PASSWORD`, `PUSHTHAT_KEY_ALIAS` and
`PUSHTHAT_KEY_PASSWORD`. A value in `keystore.properties` wins over its variable.

## Shipping to Play

A push to `main` that touches `apps/android/` builds a signed bundle and uploads it to the
closed testing track as a **draft** (`.github/workflows/android.yml`): it appears in Play
Console and passes Play's checks, but nobody receives it until a person promotes it. Making
testers get it automatically is a one-word change (`status: completed`). Run the workflow
from the Actions tab on `main` to cut a build without a push. Pull requests and other
branches run only the `build` job: the tests and an unsigned bundle, which proves the
release path compiles, with no secrets and nothing published.

Don't build a bundle by hand for Play. A local build keeps `versionCode = 8`, which Play has
already seen; CI passes the workflow's run number plus 100, which only rises. Never lower
that offset: a code Play has seen is refused for good.

The `release` job reads five secrets from the repository's `play` Environment, and skips
publishing when either the keystore or the service account is missing:

- `ANDROID_KEYSTORE_BASE64`: the upload keystore, `base64 -i <keystore>`.
- `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`: the same values
  as in `keystore.properties`.
- `PLAY_SERVICE_ACCOUNT_JSON`: the JSON key of a Google Cloud service account that has
  been invited in Play Console (Users and permissions) with release permission on this
  app. One account can publish several apps in the same developer account.

The upload action, `r0adkll/upload-google-play`, has to be on the repository's Actions
allow-list, or the run is refused before it starts.

The secrets are on the Environment, not the repository, because the Environment accepts
only `main` (Settings, Environments, `play`, Deployment branches) and GitHub checks that
before the job starts. Repository secrets reach every run a branch of this repository
starts, and a pull request runs its own copy of the workflow, so a branch could edit the
workflow to read them before anyone reviewed it. A secret set without `--env play` lands
back on the repository and reopens that, so set them as:

```bash
gh secret set ANDROID_KEY_PASSWORD --env play --repo MakeRocketGoNow/pushthat
```

## Release notes

`store/whatsnew/whatsnew-en-US` is what testers see under "What's new". The workflow passes
the directory to the upload, so editing that file is how the note changes: nothing is
entered in Play Console by hand, and a release whose note nobody updated ships the previous
one.

Write it for someone holding the phone: what is different for them, in their words. Commit
subjects are addressed to whoever changes the code next and make poor release notes, so
the note is written by hand rather than generated from them.

The note covers everything since `versionName` last changed. A change someone would notice
adds to it, in the same pull request; bumping `versionName` starts it over. Play's limit is
500 characters per locale, so when it is full, cut the least noticeable line rather than
squeezing. Another language is another file beside it, named `whatsnew-<BCP 47 tag>`
(`whatsnew-de-DE`).

## Conventions

Every string is in `res/values/strings.xml`. The app works in light and dark mode, using
the semantic colors in `res/values/colors.xml` and `res/values-night/colors.xml`, and new
styles go in `themes.xml`.
