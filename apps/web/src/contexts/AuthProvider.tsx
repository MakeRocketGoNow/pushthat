import { User, signOut as firebaseSignOut, getAuth, onAuthStateChanged } from 'firebase/auth';
import { useEffect, useState } from 'react';

import { auth } from '@/config/firebase';
import { AuthContext } from '@/contexts/AuthContext';
import { sendToExtension } from '@/services/extension';

/**
 * Whether Firebase has said who is signed in yet. On a prerendered page src/main.tsx waits
 * for that before mounting, so the provider can start from the answer: starting from
 * `loading` would render nothing first, and that empty render replaces the prerendered page
 * for the moment before the listener below reports. Everywhere else the app mounts at once,
 * this is still false, and the provider waits for the listener as it always has.
 */
let authKnown = false;

/**
 * Settles once `authKnown` is set. main.tsx mounts a prerendered page after this rather than
 * after its own `authStateReady()`, so the flag is set by then whatever order the modules
 * load in; two callbacks on the same promise would only be ordered by which module ran first.
 */
export const authKnownReady: Promise<void> = auth.authStateReady().then(() => {
  authKnown = true;
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => (authKnown ? auth.currentUser : null));
  const [loading, setLoading] = useState(() => !authKnown);

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
