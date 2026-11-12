import { User, signOut as firebaseSignOut, getAuth, onAuthStateChanged } from 'firebase/auth';
import { createContext, useContext, useEffect, useState } from 'react';

import { auth } from '@/config/firebase';
import { sendToExtension } from '@/services/extension';

interface AuthContextType {
  isAuthenticated: boolean;
  loading: boolean;
  user: User | null;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  loading: true,
  user: null,
  signOut: async () => {},
});

/**
 * Set by `main.tsx` when it has already waited for Firebase to read the session back,
 * which it does on a page that arrived as static HTML. The provider then starts with the
 * session in hand instead of rendering nothing for one pass: that empty pass replaced the
 * static text with a blank root, which is the flash the wait was there to prevent.
 */
let sessionKnown = false;

export function markSessionKnown(): void {
  sessionKnown = true;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => (sessionKnown ? auth.currentUser : null));
  const [loading, setLoading] = useState(!sessionKnown);

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

export const useAuth = () => useContext(AuthContext);
