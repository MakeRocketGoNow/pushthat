import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';

import { PLAN_PAGE_LINKED } from '@/config/plan';

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
      {PLAN_PAGE_LINKED && (
        <Link to="/plan" className={`${styles.navItem} ${currentPath === '/plan' ? styles.active : ''}`}>
          Plan
        </Link>
      )}
    </nav>
  );
}
