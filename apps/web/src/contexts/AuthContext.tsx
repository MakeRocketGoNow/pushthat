import type { User } from 'firebase/auth';
import { createContext, useContext } from 'react';

/**
 * Who is signed in, for anything that reads it. The provider that fills it in is
 * AuthProvider.tsx, kept apart so that reading this imports no Firebase: the static pages
 * render through `Layout`, which reads it, in Node at build time (src/prerender.tsx), and
 * Firebase Auth started there keeps Node from exiting.
 */
export interface AuthContextType {
  isAuthenticated: boolean;
  loading: boolean;
  user: User | null;
  signOut: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType>({
  isAuthenticated: false,
  loading: true,
  user: null,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);
