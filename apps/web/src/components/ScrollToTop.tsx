import { useEffect } from 'react';
import { useLocation } from 'react-router';

export function ScrollToTop() {
  const { pathname, search } = useLocation();

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      document.getElementById('layout-border')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [pathname, search]);

  return null;
}


