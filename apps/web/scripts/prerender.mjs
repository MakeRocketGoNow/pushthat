// Writes the static pages (src/staticPages.tsx) into the built site as HTML, so they read
// with JavaScript off. Runs after `vite build` (the site) and `vite build --ssr` (the
// renderer, into node_modules/.prerender), from `npm run prerender`.
//
// Each page is the built `index.html` with its body filled in and its title and og:url set,
// so it loads the same bundle and stylesheet as every other page. The bundle then renders
// over it with `createRoot` (src/main.tsx), and a signed-in visitor's nav appears as it
// does today.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const web = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));

const bundle = new URL('../node_modules/.prerender/prerender.js', import.meta.url);

// Firebase Auth, once started in Node, holds the process open: the script writes every page
// and then never exits, and the build waits with it. The static pages import none of
// Firebase (src/contexts/AuthContext.tsx, src/config/password.ts); this keeps it that way
// with a message instead of a hang.
const firebaseImport = (await readFile(bundle, 'utf8')).match(/from "firebase\/[^"]*"|import "firebase\/[^"]*"/);
if (firebaseImport) {
  throw new Error(`prerender: a static page imports Firebase (${firebaseImport[0]}); see src/staticPages.tsx`);
}

const { render, STATIC_PAGES } = await import(bundle);
const template = await readFile(web('dist/index.html'), 'utf8');
const firebase = JSON.parse(await readFile(web('../../firebase.json'), 'utf8'));

/**
 * `html` with `from` replaced once, failing the build when `from` is not there: a change
 * to index.html that moved it would otherwise ship pages with nothing filled in. A function
 * replacement, so a `$` in the page's text is not read as a pattern.
 */
function fill(html, from, to) {
  if (!html.includes(from)) throw new Error(`prerender: ${JSON.stringify(from)} is not in dist/index.html`);
  return html.replace(from, () => to);
}

const rewrites = firebase.hosting.rewrites;
for (const { path } of STATIC_PAGES) {
  const file = `${path.slice(1)}.html`;

  // Hosting answers a path with the file of that exact name, and otherwise with the first
  // rewrite that matches, which ends in `**` → index.html. So `/terms` reaches terms.html
  // only through a rewrite of its own, ahead of `**`. Not `cleanUrls`, which would do it for
  // every file: it also redirects `/index.html` to `/`, and the site's image page is
  // `/index.html?view=…` (src/services/viewable.ts).
  const own = rewrites.findIndex((r) => r.source === path && r.destination === `/${file}`);
  const catchAll = rewrites.findIndex((r) => r.source === '**');
  if (own === -1 || own > catchAll) {
    throw new Error(`prerender: firebase.json needs { "source": "${path}", "destination": "/${file}" } before "**"`);
  }

  const { html, title } = render(path);
  let page = template;
  page = fill(page, '<title>PushThat</title>', title);
  page = fill(
    page,
    '<meta property="og:url" content="https://pushthat.link/" />',
    `<meta property="og:url" content="https://pushthat.link${path}" />`
  );
  page = fill(page, '<div id="root"></div>', `<div id="root">${html}</div>`);
  await writeFile(web(`dist/${file}`), page);
  console.log(`prerender: ${path} → dist/${file}`);
}
