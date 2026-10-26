import clsx from 'clsx';
import { ReactNode, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { useAuth } from '@/contexts/AuthContext';

import AuthedLayout from './AuthedLayout';
import UnauthedLayout from './UnauthedLayout';

import styles from './Layout.module.css';

interface LayoutProps {
  children: ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const { isAuthenticated, signOut } = useAuth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Close menu when route changes
  useEffect(() => {
    setIsMenuOpen(false);
  }, [location]);

  const handleLogout = async () => {
    try {
      await signOut();
      navigate('/login');
    } catch (error) {
      console.error('Error signing out:', error);
    }
  };

  return (
    <div className={clsx(styles.layout, isAuthenticated && styles.layoutAuthenticated)}>
      <div className={styles.layoutBorder} id="layout-border">
        {isAuthenticated && (
          <div className={styles.menuContainer}>
            <button
              className={clsx(styles.hamburgerButton, { [styles.open]: isMenuOpen })}
              onClick={() => setIsMenuOpen(!isMenuOpen)}
            >
              <span></span>
              <span></span>
              <span></span>
            </button>
            {isMenuOpen && (
              <div className={styles.menuDropdown}>
                <button onClick={handleLogout}>Logout</button>
              </div>
            )}
          </div>
        )}
        <main className={styles.mainContent}>
          {isAuthenticated ? <AuthedLayout>{children}</AuthedLayout> : <UnauthedLayout>{children}</UnauthedLayout>}
        </main>
      </div>
    </div>
  );
}
