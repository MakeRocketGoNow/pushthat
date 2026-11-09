import { type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router';

import { KeyGate } from '@/components/KeyGate';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Signed in and with keys, or off to sign in. Used as a layout route for the site's pages,
 * or around `children` for the extension's image page, which is outside the site's routes.
 */
export default function ProtectedRoute({ children }: { children?: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return null;

  if (!user) {
    return <Navigate to="/login" />;
  }

  return <KeyGate>{children ?? <Outlet />}</KeyGate>;
}
