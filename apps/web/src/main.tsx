// sort-imports-ignore
import './index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import App from './App.tsx';
import { auth } from './config/firebase';

const root = document.getElementById('root')!;

const start = () =>
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>
  );

// A page served as static HTML (scripts/prerender.mjs) arrives with its text already in the
// root. React replaces that on its first render, and `AuthProvider` renders nothing until
// Firebase has read the session back, so starting at once showed the text, then a blank
// page, then the text again. Such a page keeps its markup until the session is known; a
// failure to read it starts the app all the same, signed out. Every other address arrives
// with an empty root and starts at once, as before.
if (root.hasChildNodes()) auth.authStateReady().then(start, start);
else start();
