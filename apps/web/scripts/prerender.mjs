// Writes the static copies of the pages that must read without JavaScript (src/prerender.tsx
// says which, and why): `dist/delete-account.html`, `dist/terms.html`, `dist/privacy.html`.
// Run by `npm run build`, after the site's build and the server build of src/prerender.tsx.
// The root firebase.json serves each at its own address (`/delete-account`), ahead of the
// rewrite that sends every other address to the app.
//
// Each copy is the built index.html with the page's markup inside the root element, so it
// carries the same stylesheet and the same script: with JavaScript the app starts over
// that markup and takes the page over, and without it the markup is the page.
import { readFile, rm, writeFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const ssr = new URL('../dist-ssr/', import.meta.url);
const { paths, render } = await import(new URL('prerender.js', ssr).href);

const shell = await readFile(new URL('index.html', dist), 'utf8');
const ROOT = '<div id="root"></div>';
if (!shell.includes(ROOT)) throw new Error(`dist/index.html has no ${ROOT} to fill`);

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// What each copy must say, so that a page which stopped rendering its text (moved behind
// an effect, or emptied by a provider that waits for the browser) fails the build rather
// than shipping blank to the one reader it is for.
const MUST_SAY = {
  '/delete-account': ['PushThat', 'MakeRocketGoNow LLC', 'WHAT IS DELETED', 'WHAT IS KEPT', 'Delete my account'],
  '/terms': ['TERMS OF SERVICE AGREEMENT', 'MakeRocketGoNow LLC'],
  '/privacy': ['PushThat Privacy Policy'],
};

for (const path of paths) {
  const { html, title, description } = render(path);
  for (const text of MUST_SAY[path] ?? []) {
    if (!html.includes(text)) throw new Error(`the static copy of ${path} does not say "${text}"`);
  }
  const url = `https://pushthat.link${path}`;
  const page = shell
    .replace(ROOT, `<div id="root">${html}</div>`)
    .replace(/<title>[^<]*<\/title>/, `<title>${escape(title || 'PushThat')}</title>`)
    // The front page's description and card would otherwise describe this page.
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${escape(description)}$2`)
    .replace(/(<meta\s+property="og:description"\s+content=")[^"]*(")/, `$1${escape(description)}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${escape(title || 'PushThat')}$2`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${url}$2`)
    .replace('</head>', `  <link rel="canonical" href="${url}" />\n  </head>`);
  await writeFile(new URL(`${path.slice(1)}.html`, dist), page);
  console.log(`prerendered ${path} (${html.length} bytes of markup)`);
}

// Only this script reads the server build.
await rm(ssr, { recursive: true, force: true });

// Said outright: importing the pages starts Firebase (config/firebase.ts), whose Auth keeps
// a timer alive, and Node would otherwise sit here until the build was killed.
process.exit(0);
