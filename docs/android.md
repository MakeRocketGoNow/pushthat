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

A build moves through three tracks, and CI only ever starts the first two:

- **Internal testing, on every merge.** A push to `main` that touches `apps/android/`
  builds a signed bundle, uploads it to the internal testing track and rolls it out to that
  track's testers (`.github/workflows/android.yml`, `status: completed`). Play does not
  review internal releases, so the build is on their phones within minutes and nobody opens
  Play Console.
- **Closed testing, when someone asks.** Run the workflow from the Actions tab on `main`
  with "Send this build to closed testing" ticked. It builds `main` as it stands, under a
  new version code, and releases it to the closed track, where Play reviews it before
  testers get it. Promoting an internal release in Play Console does the same with the
  exact bundle the internal testers had.
- **Production, when someone approves it.** Run the "Android promote" workflow, or promote
  a release in Play Console. Either way Play reviews it again. See
  [Promoting to production](#promoting-to-production). `android.yml` names only `internal`
  and `alpha`, so a merge cannot reach production.

Every merge used to go to closed testing. Play reviews each closed release, and a newer
submission replaces one still in review, so several merges in a day meant reviews of builds
no tester ever received. Closed testing is now for the builds worth a review.

The internal track has its own tester list in Play Console (Internal testing, Testers), of
up to 100 people, separate from the closed track's: someone on only the closed list gets
nothing from a merge.

Running the workflow from the Actions tab on `main` without the box ticked cuts an internal
build without a push. A run started by hand waits behind a build in progress like any
other, and GitHub keeps only the newest waiting run, so a merge that lands while it waits
displaces it: start it again. Pull requests and other branches run only the `build` job:
the tests and an unsigned bundle, which proves the release path compiles, with no secrets
and nothing published.

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

## Promoting to production

Run "Android promote" from the Actions tab on `main` (`.github/workflows/android-promote.yml`).
It builds nothing: it asks Play to release a bundle it already has, so production gets the
build testers ran. Two inputs:

- **Version code.** Empty means the newest build on internal testing. Otherwise any code a
  track is serving now, internal or closed. An older build that no track serves any more
  is promoted in Play Console instead.
- **Rollout.** A whole percentage, 10 unless changed. Run the workflow again with the same
  version code and a larger number to widen the rollout, and with 100 to finish it.

The run then waits for approval, and approving it is the release. The release keeps the
name and the "What's new" note it had on the track it came from. Play reviews it before
anyone gets it, and a commit to Play cancels a review already under way for this app and
submits everything together, so promoting while a closed testing release is in review
restarts that review.

From a terminal:

```bash
gh workflow run android-promote.yml --ref main -f rollout=10
```

Play Console does the same by hand (Internal testing or Closed testing, the release,
Promote release, Production), and is the only way to halt a rollout.

One-off setup, in this order:

1. Create the `play-production` Environment (Settings, Environments) with a required
   reviewer and Deployment branches limited to `main`.
2. Only then put the key on it:
   `gh secret set PLAY_SERVICE_ACCOUNT_JSON --env play-production --repo MakeRocketGoNow/pushthat`.
   The same service account as the `play` Environment works if it may release to
   production in Play Console (Users and permissions); a second account that only this
   Environment holds keeps the per-merge key unable to.

The order matters because GitHub creates an Environment the first time a job names it,
with no rules. Without the key the run stops before it reaches Play, so an Environment
that exists but is unprotected is harmless only while it is empty.

The work is done by `.github/scripts/play-promote.mjs`, which has no dependencies and
whose tests (`node --test '.github/scripts/*.test.mjs'`) run on every pull request. They
prove what the script asks Play for against a stand-in; only a real promotion proves Play
agrees.

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
