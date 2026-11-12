import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/**
 * Scrolls to the top when the app moves to another page. Not on the page it mounted on: that
 * one is where the browser put it, at the top, at a `#fragment`, or (on a prerendered page,
 * src/main.tsx) wherever the reader had got to before the bundle loaded. The location is kept
 * in a ref rather than a "first run" flag because StrictMode runs the effect twice on mount
 * and keeps refs between the two runs.
 */
export function ScrollToTop() {
  const { pathname, search } = useLocation();
  const scrolledFor = useRef(pathname + search);

  useEffect(() => {
    if (scrolledFor.current === pathname + search) return;
    scrolledFor.current = pathname + search;
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.getElementById('layout-border')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [pathname, search]);

  return null;
}
