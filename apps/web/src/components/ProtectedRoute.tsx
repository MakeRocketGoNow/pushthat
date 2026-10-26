import { Navigate, Outlet } from 'react-router';

import { KeyGate } from '@/components/KeyGate';
import { useAuth } from '@/contexts/AuthContext';

export default function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) return null;

  if (!user) {
    return <Navigate to="/login" />;
  }

  return (
    <KeyGate>
      <Outlet />
    </KeyGate>
  );
}
