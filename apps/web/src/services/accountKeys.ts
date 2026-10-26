import { type Firestore, doc, getDoc, runTransaction } from 'firebase/firestore';

import {
  type E2ee,
  KDF,
  type Wrap,
  decodeRecoveryKey,
  encodeRecoveryKey,
  newAccountKey,
  newRecoveryKey,
  newWrapId,
  recoveryWrappingKey,
  unwrapAccountKey,
  wrapAccountKey,
} from './e2ee';

/**
 * The account key's side of `users/{uid}` (docs/e2ee.md, The user document): reading the
 * stored wraps, opening one, and writing new ones. The sign-in and the password reset page
 * both work through here, on whichever Firestore they are signed in to (the reset has its
 * own Firebase app, see passwordReset.ts), so that a key they write is a key the other
 * one can open.
 */

/** Who the keys belong to, and the Firestore to reach them through. */
export interface KeyOwner {
  db: Firestore;
  uid: string;
  email: string;
}

/** The recovery key the user typed opens none of the account's recovery wraps. */
export class WrongRecoveryKeyError extends Error {}

/**
 * The account key was replaced elsewhere (a reset, or a start without the recovery key
 * on another device) after these keys were read. A key opened from the old ones is no
 * longer the account's, and writing a wrap of it would hand the next sign-in the wrong
 * key, so the write stops instead.
 */
export class KeysChangedError extends Error {}

// Enough of the stored map to open and rewrap it; the rules have already held it to the
// spec's shape.
export function isE2ee(value: unknown): value is E2ee {
  if (typeof value !== 'object' || value === null) return false;
  const { keyVersion, wraps } = value as Partial<E2ee>;
  return typeof keyVersion === 'number' && typeof wraps === 'object' && wraps !== null;
}

/** The stored keys, or undefined for an account that has none. */
export async function readKeys(owner: KeyOwner): Promise<E2ee | undefined> {
  const stored = (await getDoc(doc(owner.db, 'users', owner.uid))).data()?.e2ee;
  return isE2ee(stored) ? stored : undefined;
}

export function hasRecoveryWrap(e2ee: E2ee | undefined): boolean {
  return Object.values(e2ee?.wraps ?? {}).some((wrap) => wrap.by === 'recovery');
}

function wrapsBy(e2ee: E2ee, by: Wrap['by']): [string, Wrap][] {
  return Object.entries(e2ee.wraps).filter(([, wrap]) => wrap.by === by);
}

/** The first of `wraps` that `wrappingKey` opens, with its id, or undefined. */
async function openAny(
  wrappingKey: Uint8Array,
  wraps: [string, Wrap][],
  uid: string
): Promise<{ accountKey: Uint8Array; wrapId: string } | undefined> {
  for (const [wrapId, wrap] of wraps) {
    try {
      return { accountKey: await unwrapAccountKey(wrappingKey, wrap, uid), wrapId };
    } catch {
      // Another wrap may be the one; a key that opens none is the wrong key.
    }
  }
  return undefined;
}

/**
 * What a password finds in the stored keys. `opened` is the usual sign-in. `needsRecovery`
 * is an account whose password was set somewhere that could not rewrap the key (Firebase's
 * own reset page, or ours failing after the password changed), so only the recovery key
 * opens it. `needsNewKeys` is an account with no keys at all, or none anything can open.
 */
export type PasswordOutcome =
  | { kind: 'opened'; accountKey: Uint8Array; wrapId: string; e2ee: E2ee }
  | { kind: 'needsRecovery'; e2ee: E2ee }
  | { kind: 'needsNewKeys'; e2ee: E2ee | undefined };

export async function openWithPassword(
  e2ee: E2ee | undefined,
  uid: string,
  masterKey: Uint8Array
): Promise<PasswordOutcome> {
  if (!e2ee) return { kind: 'needsNewKeys', e2ee };
  const opened = await openAny(masterKey, wrapsBy(e2ee, 'password'), uid);
  if (opened) return { kind: 'opened', ...opened, e2ee };
  return hasRecoveryWrap(e2ee) ? { kind: 'needsRecovery', e2ee } : { kind: 'needsNewKeys', e2ee };
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
  const written = await writeKeys(owner, (stored) => {
    // The key opened above is the one at the version read; if it has been replaced since,
    // its wrap would sit under the new version and open the wrong key.
    if (!stored || stored.keyVersion !== e2ee.keyVersion) {
      throw new KeysChangedError('the account key changed while the recovery key was asked for');
    }
    // The recovery wrap the user's key opened, which they have just shown they can use.
    // Only that one: the rules take four wraps at most, and carrying every stored one
    // beside the new password wrap could ask for five, a write refused every time. If it
    // has gone meanwhile (a new recovery key made on another device), the stored ones stay.
    const kept =
      stored.wraps[opened.wrapId]?.by === 'recovery'
        ? { [opened.wrapId]: stored.wraps[opened.wrapId] }
        : Object.fromEntries(wrapsBy(stored, 'recovery').slice(0, 3));
    return { ...stored, wraps: { [newWrapId()]: passwordWrap, ...kept } };
  });
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
  // One past the stored version, read again as it is written. The reset page passes no
  // `decidedFrom`, and goes past a reset made elsewhere meanwhile rather than repeating
  // it. A sign-in passes the keys it decided from, and stops if they moved: another
  // device signing in to the same legacy account a moment earlier has just made keys and
  // stored them, and writing over them would leave that device holding an account key,
  // and the user a recovery key, that no longer open anything.
  const e2ee = await writeKeys(owner, (stored) => {
    if (decidedFrom && !sameKeys(stored, decidedFrom.e2ee)) {
      throw new KeysChangedError('the stored keys changed after they were read');
    }
    return { ...stored, v: 1, kdf: KDF, keyVersion: (stored?.keyVersion ?? 0) + 1, wraps };
  });
  return { accountKey, recoveryKey: encodeRecoveryKey(recoveryBytes), e2ee };
}

/** Whether `stored` is still the keys a decision was read from: the same version and wraps. */
export function sameKeys(stored: E2ee | undefined, decidedFrom: E2ee | undefined): boolean {
  if (!stored || !decidedFrom) return !stored && !decidedFrom;
  const ids = (e2ee: E2ee) => Object.keys(e2ee.wraps).sort().join(' ');
  return stored.keyVersion === decidedFrom.keyVersion && ids(stored) === ids(decidedFrom);
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
  await writeKeys(owner, (stored) => {
    if (!stored || stored.keyVersion !== keyVersion) {
      throw new KeysChangedError('the account key changed before the recovery key was replaced');
    }
    return { ...stored, wraps: { ...Object.fromEntries(wrapsBy(stored, 'password')), [newWrapId()]: recoveryWrap } };
  });
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
