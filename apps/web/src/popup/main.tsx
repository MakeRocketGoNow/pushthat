// sort-imports-ignore
// The site's stylesheet first, for its colors and resets, then the popup's own on top.
import '../index.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PushPopup } from './PushPopup';

createRoot(document.getElementById('popup')!).render(
  <StrictMode>
    <PushPopup />
  </StrictMode>
);
