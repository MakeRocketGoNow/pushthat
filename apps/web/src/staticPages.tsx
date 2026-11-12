import { ComponentType } from 'react';

import { DeleteAccount } from './pages/DeleteAccount';
import Privacy from './pages/Privacy';
import { Security } from './pages/Security';
import Support from './pages/Support';
import Terms from './pages/Terms';

/**
 * The pages that read the same for everyone and need nothing from the browser, so the build
 * renders each to HTML (`npm run prerender`, `scripts/prerender.mjs`) and they show with
 * JavaScript off, to crawlers and link previews, and before the bundle has loaded. `App`
 * routes them from this list too, so a page cannot be prerendered under one path and routed
 * under another.
 *
 * A page belongs here only if its first render is the same signed in or out and holds no
 * state. The front page does not: every path the site does not know is answered with
 * `index.html`, so filling that file would show the front page's text on `/links` and the
 * rest until the bundle loaded, and a signed-in visitor to `/` would see it flash before
 * being sent to their list.
 *
 * Each path also needs its rewrite in the root `firebase.json`; the prerender script stops
 * the build when one is missing.
 */
export const STATIC_PAGES: { path: string; Page: ComponentType }[] = [
  { path: '/privacy', Page: Privacy },
  { path: '/terms', Page: Terms },
  { path: '/support', Page: Support },
  { path: '/security', Page: Security },
  // The account deletion page Google Play is given (docs/account-deletion.md). Its text is
  // the same for everyone; its form is loaded apart (pages/DeleteAccount.tsx).
  { path: '/delete-account', Page: DeleteAccount },
];
