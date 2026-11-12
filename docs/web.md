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

The extension logs to its own console only (the service worker's, under "Inspect views" on
`chrome://extensions`). It used to send its logs to Axiom too, which carried user and push
ids to a third party the privacy policy did not name, so that was removed rather than
disclosed.

## Pages that read without JavaScript

The site is rendered in the browser, so every address answers with the same empty shell
until the script runs. Three pages are also written out as static HTML at build time,
because the reader that matters most for them may run no script: `/delete-account` (the
account deletion page Google Play is given, see [account deletion](account-deletion.md)),
`/terms` and `/privacy`.

`npm run build` builds the site, then builds `src/prerender.tsx` for Node, and
`scripts/prerender.mjs` renders each page into a copy of the built `index.html`
(`dist/delete-account.html` and so on). The root `firebase.json` rewrites each address to
its file, ahead of the rewrite that sends everything else to the app. Each copy still
loads the app's script, which draws over the markup once Firebase has read the session
back (`main.tsx` waits for that on these pages, or the text would blank out and come back),
so with JavaScript the page ends up as it would have from an empty root. The script fails the build if a copy is missing the
text it exists to carry.

Rewrites rather than `cleanUrls`, which would also redirect `/index.html` to `/`: the list
links to `/index.html?view=...` to show an image push, in the site as in the extension.

To add a page, add it to `PAGES` in `src/prerender.tsx` and a rewrite in `firebase.json`.
It must render whole on the first pass, with nothing behind an effect.

## Favicons

The list shows each link's icon by asking the linked site itself for `/favicon.ico`. It
used to ask Google's favicon service, which told Google the domain of every link pushed;
a proxy of our own would have put the same list in our logs, for pushes that are otherwise
end-to-end encrypted. A site with no icon there gets ours. The apps go one step further
and read the page's `<link rel="icon">`, which a browser will not let a script do across
origins.

## Rules, tests and deploying

`npm run test:rules` runs the rules tests against the Firestore and Storage emulators (a
Java runtime and the Firebase CLI needed; ports 8080 and 9199 must be free).

`npm run deploy` runs the rules tests, builds the site and deploys hosting, the Firestore
rules and the Storage rules (`--only hosting,firestore,storage`). The functions are not
part of it: they deploy from `functions/` with their own `npm run deploy`, since the two
change on different schedules and a site deploy should never ship a function by accident.

A push to `main` runs this deploy from CI when it changes `apps/web/`; see
[deploying](deploying.md). Running it by hand still works, for a deploy from a branch.
