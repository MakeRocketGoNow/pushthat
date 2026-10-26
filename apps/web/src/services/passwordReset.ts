import { confirmPasswordReset, signInWithEmailAndPassword, verifyPasswordResetCode } from 'firebase/auth';
import {
  type DocumentData,
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
  setDoc,
  startAfter,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';

import { auth } from '@/config/firebase';

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

/** What the steps after the password carry: who, the new password's master key, and the stored keys. */
export interface ResetSession {
  uid: string;
  email: string;
  masterKey: Uint8Array;
  /** Whether `users/{uid}` exists, since a write to a missing one is a create. */
  userExists: boolean;
  /** The stored keys, or undefined for an account that has none yet. */
  e2ee: E2ee | undefined;
}

/** The recovery key the user must save, in its display form, and how many pushes went with the old key. */
export interface NewKeys {
  recoveryKey: string;
  deleted: number;
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
  return verifyPasswordResetCode(auth, oobCode);
}

/**
 * Sets the new password: derives its keys, gives Firebase `base64url(authKey)` for the
 * code, signs in with it (so the user document can be read and written), and reads the
 * stored keys.
 */
export async function setNewPassword(oobCode: string, email: string, password: string): Promise<ResetSession> {
  const keys = await deriveKeys(email, password);
  await confirmPasswordReset(auth, oobCode, keys.firebasePassword);
  return afterPasswordChanged(async () => {
    const { user } = await signInWithEmailAndPassword(auth, email, keys.firebasePassword);
    const snapshot = await getDoc(doc(getFirestore(), 'users', user.uid));
    const stored = snapshot.data()?.e2ee;
    return {
      uid: user.uid,
      email,
      masterKey: keys.masterKey,
      userExists: snapshot.exists(),
      e2ee: isE2ee(stored) ? stored : undefined,
    };
  });
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
  for (const [, wrap] of recoveryWraps) {
    try {
      accountKey = await unwrapAccountKey(wrappingKey, wrap, session.uid);
      break;
    } catch {
      // Another recovery wrap may be the one; a key that opens none is wrong.
    }
  }
  if (!accountKey) throw new WrongRecoveryKeyError('the recovery key opens no wrap');

  const passwordWrap = await wrapAccountKey(session.masterKey, accountKey, session.uid, 'password');
  const wraps: Record<string, Wrap> = { [newWrapId()]: passwordWrap, ...Object.fromEntries(recoveryWraps) };
  await writeKeys(session, { ...e2ee, wraps });
}

/**
 * Without the recovery key, or for an account with no keys yet: a new account key and a
 * new recovery key. For an account that had keys, `keyVersion` goes up, the pushes made
 * under the old key can no longer be read, and `deleteLocked` removes them (the keys are
 * written first, so a delete that fails partway leaves locked rows the user can still
 * delete, not an account with no key). An account with no keys loses nothing: its pushes
 * are not encrypted yet.
 */
export async function startNewKeys(
  session: ResetSession,
  { deleteLocked }: { deleteLocked: boolean }
): Promise<NewKeys> {
  const accountKey = newAccountKey();
  const recoveryBytes = newRecoveryKey();
  const keyVersion = session.e2ee ? session.e2ee.keyVersion + 1 : 1;
  const e2ee: E2ee = {
    ...session.e2ee,
    v: 1,
    kdf: KDF,
    keyVersion,
    wraps: {
      [newWrapId()]: await wrapAccountKey(session.masterKey, accountKey, session.uid, 'password'),
      [newWrapId()]: await wrapAccountKey(
        await recoveryWrappingKey(recoveryBytes),
        accountKey,
        session.uid,
        'recovery'
      ),
    },
  };
  await writeKeys(session, e2ee);
  const deleted = session.e2ee && deleteLocked ? await deleteLockedPushes(session.uid, keyVersion) : 0;
  return { recoveryKey: encodeRecoveryKey(recoveryBytes), deleted };
}

async function writeKeys(session: ResetSession, e2ee: E2ee): Promise<void> {
  const ref = doc(getFirestore(), 'users', session.uid);
  if (session.userExists) {
    // A whole new map, not a merge, so the old password's wraps go.
    await updateDoc(ref, { e2ee });
  } else {
    // As the web sign-up makes the document, with the keys.
    await setDoc(ref, { email: session.email, createdAt: new Date(), e2ee });
  }
  session.userExists = true;
  session.e2ee = e2ee;
}

const DELETE_PAGE = 300;

/**
 * Deletes the user's encrypted pushes made under a key older than `keyVersion`. Plaintext
 * pushes are kept, since nothing locks them. By document id, a page at a time, which the
 * single-field index on `userId` serves; a composite index on `userId` and `keyVersion`
 * would read less, but would be one more thing to deploy by hand for a step taken once.
 * `onPushRecordDeleted` removes a file push's stored object as it does for any delete.
 */
async function deleteLockedPushes(uid: string, keyVersion: number): Promise<number> {
  const db = getFirestore();
  let deleted = 0;
  let last: QueryDocumentSnapshot<DocumentData> | undefined;
  for (;;) {
    const page = await getDocs(
      last
        ? query(
            collection(db, 'pushes'),
            where('userId', '==', uid),
            orderBy(documentId()),
            startAfter(last),
            limit(DELETE_PAGE)
          )
        : query(collection(db, 'pushes'), where('userId', '==', uid), orderBy(documentId()), limit(DELETE_PAGE))
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
