import { initializeApp } from 'firebase/app';
import {
  type ActionCodeSettings,
  type Auth,
  confirmPasswordReset,
  inMemoryPersistence,
  initializeAuth,
  signInWithEmailAndPassword,
  verifyPasswordResetCode,
} from 'firebase/auth';
import {
  type DocumentData,
  type Firestore,
  type QueryDocumentSnapshot,
  collection,
  documentId,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  writeBatch,
} from 'firebase/firestore';

import { app } from '@/config/firebase';

import {
  type KeyOwner,
  hasRecoveryWrap as hasRecoveryWrapIn,
  readKeys,
  rewrapWithRecoveryKey as rewrap,
  startNewKeys as startNew,
} from './accountKeys';
import { type E2ee, deriveKeys } from './e2ee';

export { KeysChangedError, WrongRecoveryKeyError } from './accountKeys';

/**
 * The settings every client sends a reset email with (`sendPasswordResetEmail` here,
 * `ActionCodeSettings` on iOS and macOS). The reset itself happens on Firebase's hosted
 * page: the template's action URL that would bring it to `/reset` cannot be changed on
 * this project (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`, in the console and through the API
 * alike; a verified sender domain does not lift it), and `handleCodeInApp` does not help,
 * because the hosted handler forwards a click to the continue URL with the code only for
 * email-link sign-in; for a password reset it always shows its own form (read from the
 * handler's script, `/__/auth/action.js`). So `url` is the sign-in page, which the hosted
 * form's Continue button leads to once the password is set, and that sign-in finds a
 * password that opens none of the stored wraps and asks for the recovery key: the same
 * recovery step `/reset` would have run, one screen later (docs/e2ee.md, Password reset).
 * The domain must be on the Authentication allow-list, which pushthat.link is.
 */
export const resetActionCodeSettings = {
  url: 'https://pushthat.link/login',
} satisfies ActionCodeSettings;

/**
 * The password reset (docs/e2ee.md, Password reset), which the reset email's link brings
 * to `/reset`. Firebase's own page would set the Firebase password to what the user
 * types, and a client that signs in with `authKey` could not sign in after it, so this
 * page takes the code and does the reset itself: it derives the new password's keys,
 * gives Firebase `authKey`, and then rewraps the account key under the new `masterKey`
 * with the recovery key, or starts a new account key without it.
 *
 * The steps are separate calls because the page asks the user something between them.
 * Firebase holds the new password from `setNewPassword` on, so a failure after it leaves
 * an account that signs in with the new password and still has its old wraps (or none);
 * the sign-in (signIn.ts) handles that as this page does, by asking for the recovery key
 * or making a new account key. Both derive with `deriveKeys` and write through
 * accountKeys.ts.
 */

let resetFirebase: { auth: Auth; db: Firestore } | undefined;

/**
 * The reset's own Firebase app, with its sign-in held in memory. The reset signs in
 * partway through to read and write the user document, and doing that on the site's
 * `auth` flipped `AuthContext`: `Layout` swapped its unauthed frame for the authed one,
 * which remounted the page mid-flow (the link then read as used, and a recovery key just
 * written was never shown), the Chrome extension was told of a sign-in and could switch
 * accounts, and a Logout menu appeared over the recovery key. Apart, the site's session
 * never moves, and the in-memory one ends with the tab. Made on first use, so a page
 * load that never resets creates nothing.
 */
function reset(): { auth: Auth; db: Firestore } {
  if (!resetFirebase) {
    const resetApp = initializeApp(app.options, 'password-reset');
    resetFirebase = {
      auth: initializeAuth(resetApp, { persistence: inMemoryPersistence }),
      db: getFirestore(resetApp),
    };
  }
  return resetFirebase;
}

/** What the steps after the password carry: who, the new password's master key, and the stored keys. */
export interface ResetSession {
  uid: string;
  email: string;
  masterKey: Uint8Array;
  /** The stored keys, or undefined for an account that has none yet. */
  e2ee: E2ee | undefined;
}

/**
 * A step after Firebase took the new password failed. The link is used up by then, so
 * the page must not tell the user to try it again: the password is changed, and the keys
 * are left for the next sign-in to sort out.
 */
export class PasswordChangedError extends Error {}

/** Runs `step`, which comes after the new password is set, as a `PasswordChangedError` if it fails. */
export async function afterPasswordChanged<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    console.error('Password reset failed after the password was changed:', error);
    throw new PasswordChangedError('the password is changed, the keys are not');
  }
}

/** The account the reset link is for; throws when the link has expired or been used. */
export async function emailForResetCode(oobCode: string): Promise<string> {
  return verifyPasswordResetCode(reset().auth, oobCode);
}

/**
 * Sets the new password: derives its keys, gives Firebase `base64url(authKey)` for the
 * code, signs in with it (so the user document can be read and written), and reads the
 * stored keys.
 */
export async function setNewPassword(oobCode: string, email: string, password: string): Promise<ResetSession> {
  const keys = await deriveKeys(email, password);
  await confirmPasswordReset(reset().auth, oobCode, keys.firebasePassword);
  return afterPasswordChanged(async () => {
    const { user } = await signInWithEmailAndPassword(reset().auth, email, keys.firebasePassword);
    return {
      uid: user.uid,
      email,
      masterKey: keys.masterKey,
      e2ee: await readKeys({ db: reset().db, uid: user.uid, email }),
    };
  });
}

function ownerOf(session: ResetSession): KeyOwner {
  return { db: reset().db, uid: session.uid, email: session.email };
}

/** Whether the stored keys can be rewrapped: there is a recovery wrap to open. */
export function hasRecoveryWrap(session: ResetSession): boolean {
  return hasRecoveryWrapIn(session.e2ee);
}

/**
 * With the recovery key: opens the account key, wraps it under the new password, and
 * replaces the old password's wraps, which nothing can open any more. The recovery wraps
 * and the key version stay, so every push stays readable. The stored keys are not read
 * again before the recovery key is tried, so a `KeysChangedError` here fails the same way
 * on every retry, and the page says so rather than "try again".
 */
export async function rewrapWithRecoveryKey(session: ResetSession, recoveryText: string): Promise<void> {
  if (!session.e2ee) throw new Error('this account has no keys to rewrap');
  session.e2ee = (await rewrap(ownerOf(session), session.e2ee, session.masterKey, recoveryText)).e2ee;
}

/**
 * Without the recovery key, or for an account with no keys yet: a new account key and a
 * new recovery key, returned in its display form. For an account that had keys,
 * `keyVersion` goes up and the pushes made under the old key can no longer be read;
 * `deleteLockedPushes` removes them, and is the caller's to run after the key is on
 * screen. An account with no keys loses nothing: its pushes are not encrypted yet.
 */
export async function startNewKeys(session: ResetSession): Promise<string> {
  const { recoveryKey, e2ee } = await startNew(ownerOf(session), session.masterKey);
  session.e2ee = e2ee;
  return recoveryKey;
}

const DELETE_PAGE = 300;

/**
 * Deletes the user's encrypted pushes made under a key older than the account's current
 * one, once `startNewKeys` has replaced it. Plaintext pushes are kept, since nothing locks
 * them. By document id, a page at a time, which the single-field index on `userId`
 * serves; a composite index on `userId` and `keyVersion` would read less, but would be
 * one more thing to deploy by hand for a step taken once. It can take a while on a large
 * account, which is why it runs after the new recovery key is shown and not before: a tab
 * closed partway leaves locked rows the user can delete from the list, where a tab closed
 * before the key was shown would leave a key nobody has seen. `onPushRecordDeleted`
 * removes a file push's stored object as it does for any delete.
 */
export async function deleteLockedPushes(session: ResetSession): Promise<number> {
  const keyVersion = session.e2ee?.keyVersion ?? 0;
  const { uid } = session;
  const { db } = reset();
  let deleted = 0;
  let last: QueryDocumentSnapshot<DocumentData> | undefined;
  for (;;) {
    const page = await getDocs(
      query(
        collection(db, 'pushes'),
        where('userId', '==', uid),
        orderBy(documentId()),
        ...(last ? [startAfter(last)] : []),
        limit(DELETE_PAGE)
      )
    );
    const locked = page.docs.filter((push) => {
      const data = push.data();
      return 'enc' in data && typeof data.keyVersion === 'number' && data.keyVersion < keyVersion;
    });
    if (locked.length > 0) {
      const batch = writeBatch(db);
      for (const push of locked) batch.delete(push.ref);
      await batch.commit();
      deleted += locked.length;
    }
    if (page.docs.length < DELETE_PAGE) return deleted;
    last = page.docs[page.docs.length - 1];
  }
}
