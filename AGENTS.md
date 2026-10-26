# Working on PushThat

Guidance for agents working in this repo. The [README](README.md) explains what the app is
and how the repository is laid out, and [docs/](docs/README.md) holds the design records.
This file is about *how to work here*: the standards this project holds, and the
corrections that have come up often enough to be worth writing down.

## Comments

Comments here explain **why**. The house style records the decision and the alternative
that was rejected, so the next person doesn't re-litigate it or silently undo it.

Write them for the reader who is about to change the code. If a line looks arbitrary and
isn't, say why. If something was tried and didn't work, that belongs in the comment. Don't
remove an existing comment unless it is outdated or wrong.

## No em-dashes

Do not write an em-dash (—) in anything new: comments, docs, commit messages, PR text,
UI copy, issues. Use a comma, a colon, a full stop or parentheses instead. A run of them is
the tell that a model wrote the text, and this repository is read by people who notice.

The legal documents are the one place to leave them where a lawyer would have used one,
since that register is the point.

## Real pushes stay out of the repo

**This repository is source-available; what people push through it is private.** A link
someone sent to their phone, a file name, an email address, an FCM token, a screenshot of
someone's push list: any of them can say something about someone's life they never chose
to publish. Nothing from real use goes into anything that gets pushed: code, tests,
fixtures, comments, docs, commit messages, PR titles and descriptions, or review comments.
A commit message is as public and as permanent as the code, and harder to take back.

When a real push is what exposed a bug, keep its *shape* and invent the content: "a URL
with an encoded fragment" or `Report (final) v2.pdf` proves the case as well as the
original did. Prefer placeholders that are obviously made up (`example.com`,
`someone@example.com`) over ones that merely sound plausible.

The same goes for credentials. The service account key for `packages/push-test`, Stripe
keys and webhook secrets, the Axiom token, signing keystores: none of them is ever
committed, and each has a gitignored place to live (see the docs for each app). If you find
real content or a secret already in the repo, say so rather than quietly working around it.

## Commits

Atomic commits, one logical change each.

The subject line says what changed, in plain language, as a sentence. The body explains
what was wrong before, what the change does, and any non-obvious reasoning: the same "why"
standard as the comments. Describe the case that broke without quoting a real push.

Each commit should stand on its own: the folder it touches builds and its tests pass at
every commit, not only at the tip.

Stage only what you touched. Prefer explicit paths over `git add -A`, and if `git status`
shows files you didn't touch, leave them and say what you skipped.

**Pushing is on request.** Committing as you go is the default; pushing and opening a PR
are not.

## The web app (`apps/web`)

- react-router 7, imported from `react-router`, never `react-router-dom`.
- Styles are CSS Modules, in a `[component-name].module.css` file beside the component.
- Named exports for components, not default exports.
- The same code runs in the site and in the Chrome extension, so anything that only works
  in the extension checks that the `chrome` global exists first.

## The Android app (`apps/android`)

- Every string is in `res/values/strings.xml`.
- The app works in light and dark mode. Use the semantic colors in `res/values/colors.xml`
  and `res/values-night/colors.xml`, never a literal.
- New styles go in `themes.xml`.

## The iOS and macOS apps

`apps/macos` is a hand-maintained fork of `apps/ios`, not a shared target. A change to
behavior both share (the push document, search tokens, the plan's limits) is made in both,
and the commit says so. See [docs/macos.md](docs/macos.md).

## Verifying

Each folder is installed and checked on its own, from that folder:

```bash
# apps/web
npm ci && npm run lint && npm run build && npm run build:chrome && npm run test:rules

# functions
npm ci && npm run lint && npm run build && npm test && npm run test:emulator

# apps/android (with sdk.dir in a gitignored local.properties)
./gradlew test && ./gradlew assembleDebug

# apps/ios
xcodebuild -project PushThat.xcodeproj -scheme PushThat -destination 'generic/platform=iOS Simulator' build

# apps/macos (fails today on its deployment target: see docs/macos.md)
xcodebuild -project PushThat.xcodeproj -scheme PushThat -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build

# packages/push-test (sending needs a real key, so this only parses it)
npm ci && node --check index.js
```

`npm run test:rules` and `npm run test:emulator` run against the Firestore and Storage
emulators, through the root `firebase.json`. They need a Java runtime and the Firebase CLI,
and the emulator ports free (8080 and 9199): a run refuses to start otherwise, naming the
port, and one run cannot share another's emulators, so run them one after the other. The
functions' suites deliver signed events to the webhook over HTTP and point
`STRIPE_API_URL` at a stand-in for Stripe's API, so nothing reaches Stripe.

CI (`.github/workflows/ci.yml`) runs the functions' unit tests, the web app's lint and
builds, and the Android unit tests. The emulator suites and the Xcode builds are not in it
yet, so run them yourself when a change reaches the rules, the functions or the Apple apps.

A change to a rule is not done until `npm run test:rules` covers it. A change to the plan's
limits touches `functions/src/plan.ts`, both rules files and `apps/web/src/config/plan.ts`
together, and [docs/billing.md](docs/billing.md) with them.
