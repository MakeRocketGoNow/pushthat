import { User, signOut as firebaseSignOut, getAuth, onAuthStateChanged } from 'firebase/auth';
import { createContext, useContext, useEffect, useState } from 'react';

import { auth } from '@/config/firebase';

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      console.debug('onAuthStateChanged', user?.uid);

      setUser(user);
      setLoading(false);

      if (chrome && chrome.runtime && chrome.runtime.sendMessage) {
        console.debug('Sending message to background script');
        chrome.runtime.sendMessage({ type: 'ON_AUTH_STATE_CHANGED', user: user });
      }
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
