// sort-imports-ignore
import './index.css';

import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import App from './App.tsx';
import { authKnownReady } from './contexts/AuthProvider';

const root = document.getElementById('root')!;

/**
 * Mounts the app. On a prerendered page the reader may already have scrolled, or the browser
 * may have jumped to a `#fragment`, and the page scrolls inside `#layout-border`, which
 * `createRoot` replaces with a new element at the top. So the offset is read first, the
 * first render is committed synchronously, and the offset is put back on the new element.
 * Keyboard focus is not carried over: it would mean finding the same element in the new
 * tree, for someone who tabbed in before the bundle loaded.
 */
function mount() {
  const scroller = () => document.getElementById('layout-border');
  const reading = { inner: scroller()?.scrollTop ?? 0, window: window.scrollY };
  flushSync(() =>
    createRoot(root).render(
      <StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </StrictMode>
    )
  );
  if (reading.inner) scroller()?.scrollTo({ top: reading.inner });
  if (reading.window) window.scrollTo({ top: reading.window });
}

// A prerendered page (src/staticPages.tsx) arrives with `#root` already holding it, and
// `createRoot` replaces that markup with its first render. `AuthProvider` renders nothing
// until Firebase has said who is signed in, so mounting at once would blank the page for as
// long as that takes. Waiting for it first keeps the page on screen until React has the same
// page to show. Elsewhere `#root` is empty and there is nothing to keep, so nothing waits.
//
// Not `hydrateRoot`. A signed-out visitor's first render does match the markup, but a
// signed-in one's has the nav and the menu, which the prerender never has: hydration fails
// for them, React reports an error and renders from scratch anyway. `createRoot` renders
// from scratch for everyone without the error, at the cost of the DOM the reader was in.
if (root.hasChildNodes()) {
  authKnownReady.then(mount, mount);
} else {
  mount();
}
