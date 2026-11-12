import { renderToString } from 'react-dom/server';
import { Helmet } from 'react-helmet';
import { StaticRouter } from 'react-router';

import Layout from './Layout';
import { STATIC_PAGES } from './staticPages';

export { STATIC_PAGES };

/**
 * One static page as HTML, for `scripts/prerender.mjs`, which runs this in Node after the
 * site's build (`vite build --ssr`). It renders the page in `Layout` as a signed-out visitor
 * sees it, which is also the first thing the browser renders before Firebase says who is
 * signed in.
 *
 * Not `App`: its providers read `localStorage` and IndexedDB as they start, which Node does
 * not have, and these pages use none of them. `Layout` still imports the Firebase config,
 * which only builds the SDK's objects and makes no request until something signs in.
 */
export function render(path: string): { html: string; title: string } {
  const entry = STATIC_PAGES.find((p) => p.path === path);
  if (!entry) throw new Error(`No static page at ${path}`);
  const { Page } = entry;
  const html = renderToString(
    <StaticRouter location={path}>
      <Layout>
        <Page />
      </Layout>
    </StaticRouter>
  );
  // react-helmet collects what the render asked for and must be emptied after every render,
  // or the next page starts with this one's title.
  const title = Helmet.renderStatic().title.toString();
  return { html, title };
}
