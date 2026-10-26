import { ReactNode } from 'react';

import Nav from '@/components/Nav';

import styles from './AuthedLayout.module.css';

interface AuthedLayoutProps {
  children: ReactNode;
}

export default function AuthedLayout({ children }: AuthedLayoutProps) {
  return (
    <div className={styles.container}>
      <div className={styles.navContainer}>
        <Nav />
      </div>
      <div className={styles.pageContainer}>
        <div className={styles.pageContainerInner}>{children}</div>
      </div>
    </div>
  );
}
