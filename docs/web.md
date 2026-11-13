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

## Pushing from the extension

The toolbar button opens a popup (`popup.html`, `src/popup/`) showing the tab you are on as it
will be pushed, its title and icon, with **Push this page** focused, so Enter pushes, and a
link to open the full app, which is what the button did before it had a popup. It does not
push on open: a click meant only to reach the list would send a push nobody wanted. The same
push is on a keyboard shortcut (`Alt+Shift+P` by default, changed at
`chrome://extensions/shortcuts`) and on the page's right-click menu, which the service worker
handles; it shows a check on the toolbar button when a push lands and a notification when one
does not. `src/services/pagePush.ts` is the one path all three take.

Pushing from here is how a browser push gets its title and icon at once. The site's Push page
has neither to give, since a page cannot read another site, so its pushes wait for a phone or
a Mac to scrape them ([e2ee.md](e2ee.md#titles)). The extension takes the tab's title from
Chrome and its icon from Chrome's own icon store, through `_favicon` and the `favicon`
permission, so nothing is fetched from the site or from anyone else
([e2ee.md](e2ee.md#icons)). **Push this link**, on a link's menu, has neither, since the
browser has usually not loaded that page, and goes like a push from the site.

## Building the extension

`vite.chrome.config.ts` builds with `@crxjs/vite-plugin` from `manifest.json`, whose
background service worker is `chrome/background.ts`. Load `chrome-extension/` as an
unpacked extension from `chrome://extensions` to try it.

The extension logs to its own console only (the service worker's, under "Inspect views" on
`chrome://extensions`). It used to send its logs to Axiom too, which carried user and push
ids to a third party the privacy policy did not name, so that was removed rather than
disclosed.

## Rules, tests and deploying

`npm run test:rules` runs the rules tests against the Firestore and Storage emulators (a
Java runtime and the Firebase CLI needed; ports 8080 and 9199 must be free).

`npm run deploy` runs the rules tests, builds the site and deploys hosting, the Firestore
rules and the Storage rules (`--only hosting,firestore,storage`). The functions are not
part of it: they deploy from `functions/` with their own `npm run deploy`, since the two
change on different schedules and a site deploy should never ship a function by accident.

A push to `main` runs this deploy from CI when it changes `apps/web/`; see
[deploying](deploying.md). Running it by hand still works, for a deploy from a branch.

## Pages that read without JavaScript

Privacy, Terms, Support, Security and the account deletion page are prerendered. `npm run
build` ends with `npm run prerender`, which builds `src/prerender.tsx` for Node (`vite build
--ssr`, into `node_modules/.prerender`) and runs `scripts/prerender.mjs`. That writes
`dist/<page>.html` for each entry in `src/staticPages.tsx`: the built `index.html` with the
page rendered into `#root`, the page's own title (as `<title>` and `og:title`) and its own
`og:url`. So the pages read with JavaScript off, and crawlers and link previews see each
page's title rather than the front page's. The descriptions stay the product's, since they
say what the page belongs to.

Hosting reaches each file through a rewrite of its own in the root `firebase.json`, ahead of
the `**` catch-all, and the script fails the build when one is missing. `cleanUrls` would do
the same without the list, but it also redirects `/index.html` to `/`, and the site's image
page is `/index.html?view=…`.

A page belongs on the list only if it renders the same signed in or out, holds no state and
imports nothing from Firebase. Firebase Auth started in Node keeps the script from exiting,
so the script refuses a bundle that imports Firebase rather than hang the build. That is why
`useAuth` lives apart from its provider (`src/contexts/AuthContext.tsx`, `AuthProvider.tsx`)
and the password rule is in `src/config/password.ts`. A page that needs either for part of
itself keeps that part in a component it imports from an effect, as the deletion page does
its form (`src/components/DeleteAccountForm.tsx`): effects do not run in the build's render,
so the chunk is never loaded there. Not `lazy`, which starts its import wherever it is
rendered, the build included. The front page is not on the list: every unknown path is
answered with `index.html`, so filling that file would show the front page on `/links` and
the rest until the bundle loaded.

With JavaScript on, `src/main.tsx` waits for Firebase to say who is signed in, then mounts
with `createRoot`, which replaces the prerendered markup with the same page (and the nav,
for someone signed in) without blanking it.

To preview a build with the rewrites, run the Hosting emulator. It answers 404 for every path
when `dist/` is under a folder whose name starts with a dot, such as a worktree in
`.claude/worktrees/`; serve a copy of `dist/` from somewhere else.
