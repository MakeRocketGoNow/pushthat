import { FirebaseError } from 'firebase/app';
import { type User, createUserWithEmailAndPassword, signInWithEmailAndPassword, updatePassword } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

import { app, auth } from '@/config/firebase';

import {
  type KeyOwner,
  KeysChangedError,
  openWithPassword,
  readKeys,
  replaceRecoveryKey,
  rewrapWithRecoveryKey,
  startNewKeys,
} from './accountKeys';
import { type DerivedKeys, type E2ee, deriveKeys } from './e2ee';
import { deviceId, saveAccountKey } from './keyStore';

/**
 * Signing in and registering with the password's keys (docs/e2ee.md, Keys and Migration).
 * Firebase is given `base64url(authKey)`, never the password, and the account key is
 * opened with `masterKey` and kept in IndexedDB (keyStore.ts); `masterKey` goes out of
 * scope as soon as that is done. The password reset page derives through the same
 * `deriveKeys` and writes through the same accountKeys.ts.
 *
 * Each call ends in one of three places: the key is stored (`ready`), the key is stored
 * and a recovery key was made that the user must see now (`recoveryKey`), or the
 * password opens nothing and only the recovery key can (`needsRecovery`, finished by
 * `recover` or `startOver`).
 */

/** What docs/e2ee.md asks of a new password, since the password is the key. */
export const MIN_PASSWORD_LENGTH = 10;

/** Neither the password's `authKey` nor the password itself signs in. */
export class WrongPasswordError extends Error {}

/** A signed-in account whose password opens none of its wraps, waiting on the recovery key. */
export interface KeySession {
  owner: KeyOwner;
  user: User;
  keys: DerivedKeys;
  /** Firebase still holds the raw password; it gets `authKey` once the keys are written. */
  legacy: boolean;
  e2ee: E2ee;
}

export type KeysResult =
  | { kind: 'ready' }
  | { kind: 'recoveryKey'; recoveryKey: string }
  | { kind: 'needsRecovery'; session: KeySession };

// What Firebase says for a password it does not take. `invalid-credential` is all it says
// with email enumeration protection on, which also covers an unknown email; the other two
// are what it says with it off, and from older SDKs.
const WRONG_PASSWORD = new Set(['auth/invalid-credential', 'auth/wrong-password', 'auth/invalid-login-credentials']);

const isWrongPassword = (error: unknown) => error instanceof FirebaseError && WRONG_PASSWORD.has(error.code);

/**
 * Signs in with `authKey`, and on a wrong password with the password itself: an account
 * made before encryption still has the raw password as its Firebase password, and this
 * is the sign-in that moves it over. Only a wrong password tries again; a network error
 * or Firebase's too-many-attempts stop here, since the second try would fail the same way
 * and count as one more attempt.
 */
async function signInEitherWay(email: string, password: string, keys: DerivedKeys) {
  try {
    const { user } = await signInWithEmailAndPassword(auth, email, keys.firebasePassword);
    return { user, legacy: false };
  } catch (error) {
    if (!isWrongPassword(error)) throw error;
  }
  try {
    const { user } = await signInWithEmailAndPassword(auth, email, password);
    return { user, legacy: true };
  } catch (error) {
    throw isWrongPassword(error) ? new WrongPasswordError('wrong email or password') : error;
  }
}

/**
 * Signs in (or, for a session that has no key on this device, signs in again) and opens
 * the account key. About a second of PBKDF2 first.
 */
export async function signIn(email: string, password: string): Promise<KeysResult> {
  const keys = await deriveKeys(email, password);
  const { user, legacy } = await signInEitherWay(email, password, keys);
  const owner: KeyOwner = { db: getFirestore(app), uid: user.uid, email };
  try {
    return await openKeys(owner, user, keys, legacy);
  } catch (error) {
    // The keys changed between the read and the write: another device made or rewrapped
    // them a moment ago. What it wrote is what this password should open, so read again
    // and decide again, once.
    if (!(error instanceof KeysChangedError)) throw error;
    return openKeys(owner, user, keys, legacy);
  }
}

async function openKeys(owner: KeyOwner, user: User, keys: DerivedKeys, legacy: boolean): Promise<KeysResult> {
  const outcome = await openWithPassword(await readKeys(owner), user.uid, keys.masterKey);

  switch (outcome.kind) {
    case 'opened':
      if (!legacy) return finish({ user, keys, legacy }, outcome.accountKey);
      // Keys this password opens on an account Firebase still knows by the raw password:
      // an earlier migration wrote them and stopped before `updatePassword`, so the user
      // may never have seen the recovery key. A new one, shown now, is one they have.
      return finish(
        { user, keys, legacy },
        outcome.accountKey,
        await replaceRecoveryKey(owner, outcome.accountKey, outcome.e2ee.keyVersion)
      );
    case 'needsRecovery':
      return { kind: 'needsRecovery', session: { owner, user, keys, legacy, e2ee: outcome.e2ee } };
    case 'needsNewKeys': {
      // A legacy account's first sign-in, or an account whose keys nothing opens.
      const { accountKey, recoveryKey } = await startNewKeys(owner, keys.masterKey, { e2ee: outcome.e2ee });
      return finish({ user, keys, legacy }, accountKey, recoveryKey);
    }
  }
}

/** Makes the account with `authKey` as its Firebase password, and its first keys. */
export async function register(email: string, password: string): Promise<KeysResult> {
  const keys = await deriveKeys(email, password);
  const { user } = await createUserWithEmailAndPassword(auth, email, keys.firebasePassword);
  const owner: KeyOwner = { db: getFirestore(app), uid: user.uid, email };
  const { accountKey, recoveryKey } = await startNewKeys(owner, keys.masterKey, { e2ee: undefined });
  return finish({ user, keys, legacy: false }, accountKey, recoveryKey);
}

/** Opens the account key with the recovery key and wraps it under this password. */
export async function recover(session: KeySession, recoveryText: string): Promise<KeysResult> {
  const { accountKey } = await rewrapWithRecoveryKey(session.owner, session.e2ee, session.keys.masterKey, recoveryText);
  return finish(session, accountKey);
}

/**
 * Without the recovery key: a new account key one version up, under which the pushes
 * encrypted before cannot be read. The caller has said so to the user first, about the
 * keys the session read; if they have changed since (another device found the recovery
 * key), this throws `KeysChangedError` rather than undo that.
 */
export async function startOver(session: KeySession): Promise<KeysResult> {
  const { accountKey, recoveryKey } = await startNewKeys(session.owner, session.keys.masterKey, {
    e2ee: session.e2ee,
  });
  return finish(session, accountKey, recoveryKey);
}

/**
 * The end of every path that opened or made a key: a legacy account's Firebase password
 * becomes `authKey`, and then the key is stored. `updatePassword` comes after the keys
 * are written, never before: a tab closed between the two leaves an account that still
 * signs in with the raw password and finds its keys (the `opened` and legacy case above),
 * where the other order could leave one whose Firebase password is `authKey` with no
 * wrap that opens. Straight after a sign-in it needs no reauthentication.
 *
 * A recovery key made on the way is stored with the key until the user confirms it. If
 * storing fails (IndexedDB refused, or full), the recovery wrap is already written, so
 * the key is shown anyway: the alternative was a recovery wrap nobody ever saw. With no
 * key on this device, the next step after "I saved it" is the password prompt.
 */
async function finish(
  session: Pick<KeySession, 'user' | 'keys' | 'legacy'>,
  accountKey: Uint8Array,
  recoveryKey?: string
): Promise<KeysResult> {
  if (session.legacy) await updatePassword(session.user, session.keys.firebasePassword);
  try {
    await saveAccountKey(session.user.uid, accountKey, recoveryKey);
    // Made here so that the install has its id from its first sign-in, before phase 4's
    // pushes need one.
    await deviceId();
  } catch (error) {
    if (!recoveryKey) throw error;
    console.error('Could not store the account key; showing the recovery key regardless:', error);
  }
  return recoveryKey ? { kind: 'recoveryKey', recoveryKey } : { kind: 'ready' };
}
