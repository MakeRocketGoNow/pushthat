import { initializeApp } from 'firebase/app';
import {
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
  doc,
  documentId,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  runTransaction,
  startAfter,
  where,
  writeBatch,
} from 'firebase/firestore';

import { app } from '@/config/firebase';

import {
  type E2ee,
  KDF,
  type Wrap,
  decodeRecoveryKey,
  deriveKeys,
  encodeRecoveryKey,
  newAccountKey,
  newRecoveryKey,
  newWrapId,
  recoveryWrappingKey,
  unwrapAccountKey,
  wrapAccountKey,
} from './e2ee';

/**
 * The password reset (docs/e2ee.md, Password reset), which the reset email's action URL
 * brings to `/reset`. Firebase's own page would set the Firebase password to what the user
 * types, and a client that signs in with `authKey` could not sign in after it, so this
 * page takes the code and does the reset itself: it derives the new password's keys,
 * gives Firebase `authKey`, and then rewraps the account key under the new `masterKey`
 * with the recovery key, or starts a new account key without it.
 *
 * The steps are separate calls because the page asks the user something between them.
 * Firebase holds the new password from `setNewPassword` on, so a failure after it leaves
 * an account that signs in with the new password and still has its old wraps (or none);
 * phase 3's sign-in has to handle a working `authKey` with no `password` wrap it can open
 * as it handles a registration, by offering the recovery key or a new account key.
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

/** The recovery key the user typed opens none of the account's recovery wraps. */
export class WrongRecoveryKeyError extends Error {}

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
    const snapshot = await getDoc(doc(reset().db, 'users', user.uid));
    const stored = snapshot.data()?.e2ee;
    return {
      uid: user.uid,
      email,
      masterKey: keys.masterKey,
      e2ee: isE2ee(stored) ? stored : undefined,
    };
  });
}

// At most three, so that with a new password wrap the map stays inside the rules' four.
function recoveryWrapsOf(e2ee: E2ee): Record<string, Wrap> {
  return Object.fromEntries(
    Object.entries(e2ee.wraps)
      .filter(([, wrap]) => wrap.by === 'recovery')
      .slice(0, 3)
  );
}

/** Whether the stored keys can be rewrapped: there is a recovery wrap to open. */
export function hasRecoveryWrap(session: ResetSession): boolean {
  return Object.values(session.e2ee?.wraps ?? {}).some((wrap) => wrap.by === 'recovery');
}

/**
 * With the recovery key: opens the account key, wraps it under the new password, and
 * replaces the old password's wraps, which nothing can open any more. The recovery wraps
 * and the key version stay, so every push stays readable.
 */
export async function rewrapWithRecoveryKey(session: ResetSession, recoveryText: string): Promise<void> {
  const e2ee = session.e2ee;
  if (!e2ee) throw new Error('this account has no keys to rewrap');
  let wrappingKey: Uint8Array;
  try {
    wrappingKey = await recoveryWrappingKey(decodeRecoveryKey(recoveryText));
  } catch {
    throw new WrongRecoveryKeyError('not a recovery key');
  }
  const recoveryWraps = Object.entries(e2ee.wraps).filter(([, wrap]) => wrap.by === 'recovery');
  let accountKey: Uint8Array | undefined;
  let openedId: string | undefined;
  for (const [id, wrap] of recoveryWraps) {
    try {
      accountKey = await unwrapAccountKey(wrappingKey, wrap, session.uid);
      openedId = id;
      break;
    } catch {
      // Another recovery wrap may be the one; a key that opens none is wrong.
    }
  }
  if (!accountKey || !openedId) throw new WrongRecoveryKeyError('the recovery key opens no wrap');
  const opened = openedId;

  const passwordWrap = await wrapAccountKey(session.masterKey, accountKey, session.uid, 'password');
  await writeKeys(session, (stored) => {
    // The account key opened above is the one at the version read when the password was
    // set; if a reset elsewhere has replaced it since, its wrap would sit under the new
    // version and open the wrong key, so this stops instead.
    if (!stored || stored.keyVersion !== e2ee.keyVersion) {
      throw new Error('the account key changed while the page was open');
    }
    // The recovery wrap the user's key opened, which they have just shown they can use.
    // Only that one: the rules take four wraps at most, and carrying every stored one
    // beside the new password wrap could ask for five, a write refused every time. If it
    // has gone meanwhile (a new recovery key made on another device), the stored ones stay.
    const kept = stored.wraps[opened]?.by === 'recovery' ? { [opened]: stored.wraps[opened] } : recoveryWrapsOf(stored);
    const wraps: Record<string, Wrap> = { [newWrapId()]: passwordWrap, ...kept };
    return { ...stored, wraps };
  });
}

/**
 * Without the recovery key, or for an account with no keys yet: a new account key and a
 * new recovery key, returned in its display form. For an account that had keys,
 * `keyVersion` goes up and the pushes made under the old key can no longer be read;
 * `deleteLockedPushes` removes them, and is the caller's to run after the key is on
 * screen. An account with no keys loses nothing: its pushes are not encrypted yet.
 */
export async function startNewKeys(session: ResetSession): Promise<string> {
  const accountKey = newAccountKey();
  const recoveryBytes = newRecoveryKey();
  const wraps = {
    [newWrapId()]: await wrapAccountKey(session.masterKey, accountKey, session.uid, 'password'),
    [newWrapId()]: await wrapAccountKey(await recoveryWrappingKey(recoveryBytes), accountKey, session.uid, 'recovery'),
  };
  // One past the stored version, read again as it is written, so a reset elsewhere in
  // the meantime is passed rather than repeated.
  await writeKeys(session, (stored) => ({
    ...stored,
    v: 1,
    kdf: KDF,
    keyVersion: (stored?.keyVersion ?? 0) + 1,
    wraps,
  }));
  return encodeRecoveryKey(recoveryBytes);
}

/**
 * Writes the keys `build` makes from the stored ones, read again in the same transaction.
 * The session's copy was read when the password was set, and the user may take minutes
 * to find a recovery key; a whole map written from that copy would undo whatever changed
 * `e2ee` meanwhile (`migratedAt` set, a wrap written by another device), which the rules'
 * "keyVersion only goes up" cannot see at an equal version. The new map replaces the old
 * one rather than merging into it, so the old password's wraps go.
 */
async function writeKeys(session: ResetSession, build: (stored: E2ee | undefined) => E2ee): Promise<void> {
  const { db } = reset();
  const ref = doc(db, 'users', session.uid);
  session.e2ee = await runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.data()?.e2ee;
    const e2ee = build(isE2ee(stored) ? stored : undefined);
    if (snapshot.exists()) {
      transaction.update(ref, { e2ee });
    } else {
      // As the web sign-up makes the document, with the keys.
      transaction.set(ref, { email: session.email, createdAt: new Date(), e2ee });
    }
    return e2ee;
  });
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

// Enough of the stored map to rewrap it; the rules have already held it to the spec's shape.
function isE2ee(value: unknown): value is E2ee {
  if (typeof value !== 'object' || value === null) return false;
  const { keyVersion, wraps } = value as Partial<E2ee>;
  return typeof keyVersion === 'number' && typeof wraps === 'object' && wraps !== null;
}
