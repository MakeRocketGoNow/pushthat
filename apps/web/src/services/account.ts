import { FirebaseError, deleteApp, initializeApp } from 'firebase/app';
import { type User, inMemoryPersistence, initializeAuth, signOut } from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';

import { app, auth } from '@/config/firebase';

import { clearAccountKey } from './keyStore';
import { errorText } from './plan';
import { proveByPassword } from './signIn';

/**
 * How long the call may take: a little more than the function's own five minutes
 * (`timeoutSeconds` in functions/src/account-deletion.ts), so the function always answers
 * first. The SDK's default is 70 seconds, and an account with tens of thousands of pushes
 * takes longer than that to delete: the page gave up, said nothing had been removed, and
 * the server went on to delete everything.
 */
const CALL_TIMEOUT_MS = 310_000;

/**
 * The call ended with no answer from the function (a timeout, a dropped connection, a
 * crash on the server) and the account still exists. Nothing can be said about how far
 * the deletion got: once the function is past Stripe it has left a marker, and the sweep
 * finishes what it started within about two hours whether or not anyone asks again.
 */
export class OutcomeUnknownError extends Error {}

/**
 * Whether the account `user` signed in to no longer exists, asked of Firebase. The Auth
 * user is the last thing the function deletes, so gone means the deletion finished.
 *
 * Only for the user this deletion signed in moments ago. "Token expired" counts as gone
 * here because nothing but the function can have revoked a session that new, and the
 * function revokes after it has left the marker that gets the deletion finished. Asked of
 * an older session it would also be true after a password change, which deletes nothing.
 */
async function isGone(user: User): Promise<boolean> {
  try {
    await user.reload();
    return false;
  } catch (error) {
    return (
      error instanceof FirebaseError &&
      (error.code === 'auth/user-not-found' || error.code === 'auth/user-token-expired')
    );
  }
}

/**
 * Ends the site's own session for an account the server has deleted. The key goes first,
 * as at any sign-out (KeysContext clears it too, once the session ends; doing it here
 * does not wait on that).
 */
async function endSession(): Promise<void> {
  await clearAccountKey().catch((error) => console.error('Could not clear the account key:', error));
  // Caught, like the line above: the account is gone by now, and a failure thrown from
  // here reached the page as "your account was not deleted". Firebase ends a session
  // whose account is gone by itself, at the next token refresh.
  await signOut(auth).catch((error) => console.error("Could not end the deleted account's session:", error));
}

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
 * Throws `WrongPasswordError` for a wrong email or password, whatever the function
 * refused with in its own words (`errorText` in plan.ts reads it), and
 * `OutcomeUnknownError` when the call ended without an answer and the account is still
 * there.
 */
export async function deleteAccount(email: string, password: string, onDeleted: () => void): Promise<void> {
  const scratch = initializeApp(app.options, `delete-account-${Date.now()}`);
  try {
    // A refused password is only ever reported as that. This once asked the browser's own
    // session whether its account was gone, to catch a retry after a lost answer. But
    // Firebase gives the web one answer, "token expired", both for an account that was
    // deleted and for a session revoked by a password change or reset, and the page tells
    // people who forgot their password to reset it first: someone who then mistyped was
    // told "Your account is deleted" when nothing had been asked of the server.
    const user = await proveByPassword(initializeAuth(scratch, { persistence: inMemoryPersistence }), email, password);
    try {
      await httpsCallable(getFunctions(scratch), 'deleteAccount', { timeout: CALL_TIMEOUT_MS })();
    } catch (error) {
      // A sentence from the function is a refusal made before anything was deleted (an old
      // sign-in, a subscription that would not cancel). Anything else is no answer at
      // all, and the answer is then read off the account itself.
      if (errorText(error, '')) throw error;
      if (!(await isGone(user))) throw new OutcomeUnknownError();
    }
    onDeleted();
    if (auth.currentUser?.uid === user.uid) await endSession();
  } finally {
    await deleteApp(scratch).catch(() => undefined);
  }
}
