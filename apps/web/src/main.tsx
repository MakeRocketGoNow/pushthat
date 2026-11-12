// sort-imports-ignore
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import App from './App.tsx';
import { auth } from './config/firebase';

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
// Not `hydrateRoot`: it reuses the markup only while the first render matches it exactly,
// and that first render is the provider's empty one.
if (root.hasChildNodes()) {
  auth.authStateReady().then(mount, mount);
} else {
  mount();
}
