# The web app and the Chrome extension

`apps/web` is one Vite + React codebase that builds two things: the site at pushthat.link
(`npm run build`, into `dist/`) and the Chrome extension (`npm run build:chrome`, into
`chrome-extension/`). The same components run in both, so anything that only works in the
extension checks that the `chrome` global exists before using it.

The Firestore and Storage rules live here too (`firestore.rules`, `storage.rules`), beside
their tests in `tests/`, because the clients are what they constrain. The root
`firebase.json` points at them.

## Push notifications: web vs the extension

- **The web, with a service worker and FCM.** Supported on Chrome, Edge, Firefox and
  Android browsers. It needs a registered service worker, the Notifications permission,
  and the FCM Web SDK with a VAPID key. A push arrives in the worker's `push` event and
  shows a notification; opening it happens in `notificationclick` through
  `clients.openWindow(...)`.
- **What the open web cannot do.** iOS Safari does not support FCM on the web (it relies
  on APNs, and FCM tokens generally do not work there). A `push` handler cannot open a tab
  or a window; it has to wait for the user to click. Permission prompts usually need a
  user gesture, and delivery depends on the browser running in the background.
- **Why there is a Chrome extension.** Its background service worker registers with FCM
  and can act on a push at once, opening the pushed link with `chrome.tabs.create` with no
  click and no site tab left open. That is the receive-and-open flow the product is for,
  and it is more reliable across desktops.

What exists today: push handling is in the extension's background service worker
(`chrome/background.ts`). The web app does not register a service worker for FCM.

## Building the extension

`vite.chrome.config.ts` builds with `@crxjs/vite-plugin` from `manifest.json`, whose
background service worker is `chrome/background.ts`. Load `chrome-extension/` as an
unpacked extension from `chrome://extensions` to try it.

The extension logs to Axiom when it is built with an ingest token. The token comes from
`VITE_AXIOM_TOKEN` in `apps/web/.env` (copy `.env.example`; `.env` is gitignored) or in the
build's environment. It ships inside the built extension whatever happens, so it must be an
ingest-only token, and keeping it out of the repository is about not making the repository
the place it is found. A build without one logs to the console only.

## Rules, tests and deploying

`npm run test:rules` runs the rules tests against the Firestore and Storage emulators (a
Java runtime and the Firebase CLI needed; ports 8080 and 9199 must be free).

`npm run deploy` runs the rules tests, builds the site and deploys hosting, the Firestore
rules and the Storage rules (`--only hosting,firestore,storage`). The functions are not
part of it: they deploy from `functions/` with their own `npm run deploy`, since the two
change on different schedules and a site deploy should never ship a function by accident.

A push to `main` runs this deploy from CI when it changes `apps/web/`; see
[deploying](deploying.md). Running it by hand still works, for a deploy from a branch.
