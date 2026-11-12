import { deleteApp, initializeApp } from 'firebase/app';
import { inMemoryPersistence, initializeAuth, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

import { app, auth } from '@/config/firebase';

import { clearAccountKey } from './keyStore';
import { proveByPassword } from './signIn';

/**
 * Deletes the account that `email` and `password` sign in to, for good (docs/account-deletion.md
 * at the repository root): the `deleteAccount` function removes the account and everything
 * stored under it, and then this browser forgets its key and its session.
 *
 * The function needs a sign-in made in the last five minutes, so the password is always
 * asked for, whether or not the browser is signed in. That sign-in is made on a second
 * Firebase app that lives only for this call, with its session in memory, and not on the
 * site's own:
 *
 * - The page is public, and the person deleting may not be signed in here, or may have
 *   uninstalled every app. Signing them in on the site's own `auth` would flip the site
 *   into its signed-in frame partway through (`Layout`), remount the page that asked, and
 *   tell the extension's worker that an account had arrived, all for a session that is
 *   gone a second later.
 * - If the function refuses (a subscription that will not cancel), nobody has been signed
 *   in to this browser as a side effect.
 *
 * `onDeleted` is called once the function has answered, before this browser's own session
 * is ended: ending it remounts the page that asked (see above), so a caller that waited
 * for this to resolve would be setting state on a component that is already gone.
 *
 * Throws `WrongPasswordError` for a wrong email or password, and whatever the function
 * refused with (`errorText` in plan.ts reads it).
 */
export async function deleteAccount(email: string, password: string, onDeleted: () => void): Promise<void> {
  const scratch = initializeApp(app.options, `delete-account-${Date.now()}`);
  try {
    const user = await proveByPassword(initializeAuth(scratch, { persistence: inMemoryPersistence }), email, password);
    await httpsCallable(getFunctions(scratch), 'deleteAccount')();
    onDeleted();
    // The site's own session, if it is this account's, is over on the server already.
    // Its key goes first, as at any sign-out (KeysContext clears it too, once the session
    // ends; doing it here does not wait on that).
    if (auth.currentUser?.uid === user.uid) {
      await clearAccountKey().catch((error) => console.error('Could not clear the account key:', error));
      await signOut(auth);
    }
  } finally {
    await deleteApp(scratch).catch(() => undefined);
  }
}
