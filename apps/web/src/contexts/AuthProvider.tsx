import { User, signOut as firebaseSignOut, getAuth, onAuthStateChanged } from 'firebase/auth';
import { useEffect, useState } from 'react';

import { auth } from '@/config/firebase';
import { AuthContext } from '@/contexts/AuthContext';
import { sendToExtension } from '@/services/extension';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      console.debug('onAuthStateChanged', user?.uid);

      setUser(user);
      setLoading(false);

      sendToExtension({ type: 'ON_AUTH_STATE_CHANGED', user: user });
    });

    return unsubscribe;
  }, []);

  const signOut = async () => {
    const auth = getAuth();
    await firebaseSignOut(auth);
  };

  const value = {
    isAuthenticated: !!user,
    loading,
    user,
    signOut,
  };

  return <AuthContext.Provider value={value}>{!loading && children}</AuthContext.Provider>;
}
