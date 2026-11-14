import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';

import styles from './Nav.module.css';

export default function Nav() {
  const location = useLocation();
  const currentPath = location.pathname;
  const [sliderStyle, setSliderStyle] = useState({ width: 0, left: 0 });
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const activeLink = navRef.current?.querySelector(`a[href="${currentPath}"]`);
    if (activeLink) {
      const { offsetWidth, offsetLeft } = activeLink as HTMLElement;
      setSliderStyle({
        width: offsetWidth,
        left: offsetLeft,
      });
    } else {
      // A page with no item here (Account, Plan, the static pages while signed in): the
      // slider shrinks away where it stood, rather than staying lit on the page left behind.
      setSliderStyle((was) => ({ width: 0, left: was.left + was.width / 2 }));
    }
  }, [currentPath]);

  return (
    <nav className={styles.nav} ref={navRef}>
      <div
        className={styles.backgroundSlider}
        style={{
          width: sliderStyle.width,
          left: sliderStyle.left,
        }}
      />
      <Link to="/push" className={`${styles.navItem} ${currentPath === '/push' ? styles.active : ''}`}>
        Push
      </Link>
      <Link to="/links" className={`${styles.navItem} ${currentPath === '/links' ? styles.active : ''}`}>
        Links
      </Link>
    </nav>
  );
}
