import { type Firestore, doc, getDoc, runTransaction } from 'firebase/firestore';

import {
  type E2ee,
  decodeRecoveryKey,
  encodeRecoveryKey,
  newAccountKey,
  newRecoveryKey,
  newWrapId,
  recoveryWrappingKey,
  wrapAccountKey,
} from './e2ee';
import {
  WrongRecoveryKeyError,
  isE2ee,
  openAny,
  withNewKeys,
  withNewRecoveryWrap,
  withRewrappedPassword,
  wrapsBy,
} from './keyDecisions';

export {
  KeysChangedError,
  type PasswordOutcome,
  WrongRecoveryKeyError,
  hasRecoveryWrap,
  isE2ee,
  openWithPassword,
  sameKeys,
} from './keyDecisions';

/**
 * The account key's side of `users/{uid}` (docs/e2ee.md, The user document): reading the
 * stored wraps, opening one, and writing new ones. The sign-in and the password reset page
 * both work through here, on whichever Firestore they are signed in to (the reset has its
 * own Firebase app, see passwordReset.ts), so that a key they write is a key the other
 * one can open. What each write keeps is decided in keyDecisions.ts, which is tested.
 */

/** Who the keys belong to, and the Firestore to reach them through. */
export interface KeyOwner {
  db: Firestore;
  uid: string;
  email: string;
}

/** The stored keys, or undefined for an account that has none. */
export async function readKeys(owner: KeyOwner): Promise<E2ee | undefined> {
  const stored = (await getDoc(doc(owner.db, 'users', owner.uid))).data()?.e2ee;
  return isE2ee(stored) ? stored : undefined;
}

/**
 * With the recovery key: opens the account key, wraps it under `masterKey`, and replaces
 * the password wraps, which nothing opens any more (that is why the recovery key was
 * asked for). The recovery wraps and the key version stay, so every push stays readable.
 * `e2ee` is the stored keys the caller read; returns the account key.
 */
export async function rewrapWithRecoveryKey(
  owner: KeyOwner,
  e2ee: E2ee,
  masterKey: Uint8Array,
  recoveryText: string
): Promise<{ accountKey: Uint8Array; e2ee: E2ee }> {
  let wrappingKey: Uint8Array;
  try {
    wrappingKey = await recoveryWrappingKey(decodeRecoveryKey(recoveryText));
  } catch {
    throw new WrongRecoveryKeyError('not a recovery key');
  }
  const opened = await openAny(wrappingKey, wrapsBy(e2ee, 'recovery'), owner.uid);
  if (!opened) throw new WrongRecoveryKeyError('the recovery key opens no wrap');

  const passwordWrap = await wrapAccountKey(masterKey, opened.accountKey, owner.uid, 'password');
  const passwordWrapId = newWrapId();
  const written = await writeKeys(owner, (stored) =>
    withRewrappedPassword(stored, e2ee, opened.wrapId, passwordWrapId, passwordWrap)
  );
  return { accountKey: opened.accountKey, e2ee: written };
}

/**
 * A new account key and a new recovery key, for an account with no keys (a registration,
 * a legacy account's first sign-in) or one that starts over without its recovery key.
 * For an account that had keys, `keyVersion` goes up and the pushes made under the old
 * key can no longer be read. Both wraps are written together, before the recovery key is
 * shown: a wrap whose key the user never saved costs nothing, where writing it after the
 * user confirmed would leave a tab closed on the key with no recovery wrap at all.
 * Returns the account key and the recovery key in its display form.
 */
export async function startNewKeys(
  owner: KeyOwner,
  masterKey: Uint8Array,
  decidedFrom?: { e2ee: E2ee | undefined }
): Promise<{ accountKey: Uint8Array; recoveryKey: string; e2ee: E2ee }> {
  const accountKey = newAccountKey();
  const recoveryBytes = newRecoveryKey();
  const wraps = {
    [newWrapId()]: await wrapAccountKey(masterKey, accountKey, owner.uid, 'password'),
    [newWrapId()]: await wrapAccountKey(await recoveryWrappingKey(recoveryBytes), accountKey, owner.uid, 'recovery'),
  };
  // Read again as it is written; see `withNewKeys` for `decidedFrom`.
  const e2ee = await writeKeys(owner, (stored) => withNewKeys(stored, decidedFrom, wraps));
  return { accountKey, recoveryKey: encodeRecoveryKey(recoveryBytes), e2ee };
}

/**
 * A new recovery key for the account key the caller holds, replacing every recovery wrap
 * (the old key stops working) and keeping the password wraps. `keyVersion` is the version
 * the caller's account key belongs to. Returns the recovery key in its display form.
 */
export async function replaceRecoveryKey(owner: KeyOwner, accountKey: Uint8Array, keyVersion: number): Promise<string> {
  const recoveryBytes = newRecoveryKey();
  const recoveryWrap = await wrapAccountKey(
    await recoveryWrappingKey(recoveryBytes),
    accountKey,
    owner.uid,
    'recovery'
  );
  const recoveryWrapId = newWrapId();
  await writeKeys(owner, (stored) => withNewRecoveryWrap(stored, keyVersion, recoveryWrapId, recoveryWrap));
  return encodeRecoveryKey(recoveryBytes);
}

/**
 * Writes the keys `build` makes from the stored ones, read again in the same transaction.
 * A copy read earlier can be minutes old by the time the user has found a recovery key;
 * a whole map written from it would undo whatever changed `e2ee` meanwhile (`migratedAt`
 * set, a wrap written by another device), which the rules' "keyVersion only goes up"
 * cannot see at an equal version. The new map replaces the old one rather than merging
 * into it, so a wrap `build` leaves out is gone. An account with no user document yet
 * gets one, as the web sign-up makes it, with the keys; another client (the Chrome
 * extension saving its device token, usually) can make it first, which is why this reads
 * before choosing between a create and an update.
 */
export async function writeKeys(owner: KeyOwner, build: (stored: E2ee | undefined) => E2ee): Promise<E2ee> {
  const ref = doc(owner.db, 'users', owner.uid);
  return runTransaction(owner.db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.data()?.e2ee;
    const e2ee = build(isE2ee(stored) ? stored : undefined);
    if (snapshot.exists()) {
      transaction.update(ref, { e2ee });
    } else {
      transaction.set(ref, { email: owner.email, createdAt: new Date(), e2ee });
    }
    return e2ee;
  });
}
