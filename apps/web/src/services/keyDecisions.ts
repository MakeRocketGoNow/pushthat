import { type E2ee, KDF, type Wrap, unwrapAccountKey } from './e2ee.ts';

/**
 * The decisions behind the account key's writes (accountKeys.ts) that need no Firestore:
 * what a password finds in the stored keys, and which wraps each write keeps. They are
 * what holds a write inside the rules' four wraps and stops it undoing another device's
 * keys, and a write the rules refuse is refused every time, so `npm run test:keys` checks
 * them in plain Node. For that, nothing is imported but e2ee.ts, by its file name.
 */

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

export function hasRecoveryWrap(e2ee: E2ee | undefined): boolean {
  return Object.values(e2ee?.wraps ?? {}).some((wrap) => wrap.by === 'recovery');
}

export function wrapsBy(e2ee: E2ee, by: Wrap['by']): [string, Wrap][] {
  return Object.entries(e2ee.wraps).filter(([, wrap]) => wrap.by === by);
}

/** The first of `wraps` that `wrappingKey` opens, with its id, or undefined. */
export async function openAny(
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

/** Whether `stored` is still the keys a decision was read from: the same version and wraps. */
export function sameKeys(stored: E2ee | undefined, decidedFrom: E2ee | undefined): boolean {
  if (!stored || !decidedFrom) return !stored && !decidedFrom;
  const ids = (e2ee: E2ee) => Object.keys(e2ee.wraps).sort().join(' ');
  return stored.keyVersion === decidedFrom.keyVersion && ids(stored) === ids(decidedFrom);
}

/**
 * The keys after a recovery key opened `openedWrapId` of `decided` (the keys read when it
 * was asked for): a new password wrap, and the recovery wraps, with the password wraps
 * that nothing opens any more dropped.
 */
export function withRewrappedPassword(
  stored: E2ee | undefined,
  decided: E2ee,
  openedWrapId: string,
  passwordWrapId: string,
  passwordWrap: Wrap
): E2ee {
  // The key opened is the one at the version read; if it has been replaced since, its
  // wrap would sit under the new version and open the wrong key.
  if (!stored || stored.keyVersion !== decided.keyVersion) {
    throw new KeysChangedError('the account key changed while the recovery key was asked for');
  }
  // The recovery wrap the user's key opened, which they have just shown they can use.
  // Only that one: the rules take four wraps at most, and carrying every stored one
  // beside the new password wrap could ask for five, a write refused every time. If it
  // has gone meanwhile (a new recovery key made on another device), the stored ones stay.
  const kept =
    stored.wraps[openedWrapId]?.by === 'recovery'
      ? { [openedWrapId]: stored.wraps[openedWrapId] }
      : Object.fromEntries(wrapsBy(stored, 'recovery').slice(0, 3));
  return { ...stored, wraps: { [passwordWrapId]: passwordWrap, ...kept } };
}

/**
 * The keys for a new account key, one version past the stored ones. The reset page passes
 * no `decidedFrom`, and goes past a reset made elsewhere meanwhile rather than repeating
 * it. A sign-in passes the keys it decided from, and stops if they moved: another device
 * signing in to the same legacy account a moment earlier has just made keys and stored
 * them, and writing over them would leave that device holding an account key, and the
 * user a recovery key, that no longer open anything.
 */
export function withNewKeys(
  stored: E2ee | undefined,
  decidedFrom: { e2ee: E2ee | undefined } | undefined,
  wraps: Record<string, Wrap>
): E2ee {
  if (decidedFrom && !sameKeys(stored, decidedFrom.e2ee)) {
    throw new KeysChangedError('the stored keys changed after they were read');
  }
  return { ...stored, v: 1, kdf: KDF, keyVersion: (stored?.keyVersion ?? 0) + 1, wraps };
}

/**
 * The keys with every recovery wrap replaced by `recoveryWrap` (the old recovery key stops
 * working) and the password wraps kept, for the account key at `keyVersion`.
 */
export function withNewRecoveryWrap(
  stored: E2ee | undefined,
  keyVersion: number,
  recoveryWrapId: string,
  recoveryWrap: Wrap
): E2ee {
  if (!stored || stored.keyVersion !== keyVersion) {
    throw new KeysChangedError('the account key changed before the recovery key was replaced');
  }
  return { ...stored, wraps: { ...Object.fromEntries(wrapsBy(stored, 'password')), [recoveryWrapId]: recoveryWrap } };
}
