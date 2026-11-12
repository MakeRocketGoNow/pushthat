// sort-imports-ignore
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import App from './App.tsx';
import { authKnownReady } from './contexts/AuthProvider';

const root = document.getElementById('root')!;

function mount() {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>
  );
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
