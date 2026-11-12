import { renderToString } from 'react-dom/server';
import { Helmet } from 'react-helmet';
import { StaticRouter } from 'react-router';

import Layout from './Layout';
import { DeleteAccount } from './pages/DeleteAccount';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';

/**
 * The pages that are also served as static HTML (scripts/prerender.mjs runs this after
 * the build). The site is rendered in the browser, so a reader that runs no JavaScript
 * gets an empty page from every address, and for these three that reader matters: Google
 * Play's review opens the account deletion page and the privacy policy, a store listing
 * links to the terms, and someone on a locked-down browser must still be able to read how
 * to delete their account.
 *
 * Each is rendered inside `Layout` as a signed-out visitor sees it. No `AuthProvider`:
 * it renders nothing until Firebase has answered, which on a server is never, and without
 * it `useAuth` gives its signed-out default, which is the page a stranger gets. In the
 * browser `main.tsx` then draws the app over this markup as it does over an empty root,
 * so nothing here has to match what the client renders.
 *
 * A page added here must read whole without effects or state: nothing in it may be
 * fetched after the first render.
 */
const PAGES: Record<string, { page: () => JSX.Element; description: string }> = {
  '/delete-account': {
    page: () => <DeleteAccount />,
    description:
      'How to delete your PushThat account and its data, what is deleted, what is kept and for how long. PushThat is an app by MakeRocketGoNow LLC.',
  },
  '/terms': {
    page: () => <Terms />,
    description: 'The terms of service for PushThat, an app by MakeRocketGoNow LLC.',
  },
  '/privacy': {
    page: () => <Privacy />,
    description: 'What PushThat stores, what it cannot read, who it is shared with and how long it is kept.',
  },
};

export const paths = Object.keys(PAGES);

export function render(path: string): { html: string; title: string; description: string } {
  const { page, description } = PAGES[path];
  const html = renderToString(
    <StaticRouter location={path}>
      <Layout>{page()}</Layout>
    </StaticRouter>
  );
  // Read, and with that emptied: Helmet collects every title rendered since the last read.
  const title = Helmet.renderStatic()
    .title.toString()
    .replace(/<[^>]+>/g, '');
  return { html, title, description };
}
