import { accountBaseKey, newDeviceId } from './e2ee';

/**
 * Where the web app and the Chrome extension keep the account key after sign-in
 * (docs/e2ee.md, Where keys live on each device): IndexedDB, holding the key as a
 * non-extractable `CryptoKey`. IndexedDB stores a `CryptoKey` as it is, flag included,
 * so a script on the page can use the key it reads back and never read its bytes;
 * `localStorage` would hold only a string, which is the key itself. The device id sits
 * beside it.
 *
 * No Firebase here, so that the extension's service worker can import this as it is. In
 * the extension the bundled page and the worker share the extension's origin, and so
 * this database.
 */

const DB_NAME = 'pushthat-keys';
const STORE = 'keys';
const ACCOUNT = 'account';
const DEVICE = 'device';

interface StoredAccountKey {
  /** The account the key belongs to, so another account signing in never picks it up. */
  uid: string;
  key: CryptoKey;
  /**
   * The account's `e2ee.keyVersion` the key was opened at, which every push records. Kept
   * here rather than read from the user document at push time: after a reset elsewhere the
   * document has moved on and this key has not, and a push labelled with the new version
   * but sealed under the old key is one no device could open. With the stored version the
   * rules refuse it instead. A key saved before phase 4 has none (see pushes.ts).
   */
  keyVersion?: number;
}

/** The stored key with the version it belongs to. */
export interface AccountKey {
  key: CryptoKey;
  keyVersion?: number;
}

let opening: Promise<IDBDatabase> | undefined;

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    // A failed open is not cached, so the next call tries again.
    opening = undefined;
    throw error;
  });
  return opening;
}

async function run<T>(mode: IDBTransactionMode, use: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = use(transaction.objectStore(STORE));
    // The transaction's end, not the request's, is when a write is on disk.
    transaction.oncomplete = () => resolve(request.result as T);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** Keeps `accountKey` for `uid` as a key that cannot be exported. The caller drops the bytes. */
export async function saveAccountKey(uid: string, accountKey: Uint8Array, keyVersion: number): Promise<void> {
  const stored: StoredAccountKey = { uid, key: await accountBaseKey(accountKey), keyVersion };
  await run('readwrite', (store) => store.put(stored, ACCOUNT));
}

/** The stored account key and its version, if there is one and it is `uid`'s. */
export async function loadAccountKey(uid: string): Promise<AccountKey | undefined> {
  const stored = await run<StoredAccountKey | undefined>('readonly', (store) => store.get(ACCOUNT));
  return stored?.uid === uid ? { key: stored.key, keyVersion: stored.keyVersion } : undefined;
}

/** Records the version of a key saved before versions were kept, once it has been read. */
export async function rememberKeyVersion(uid: string, keyVersion: number): Promise<void> {
  const stored = await run<StoredAccountKey | undefined>('readonly', (store) => store.get(ACCOUNT));
  if (stored?.uid !== uid || stored.keyVersion !== undefined) return;
  await run('readwrite', (store) => store.put({ ...stored, keyVersion }, ACCOUNT));
}

/** At sign-out. The device id stays: it belongs to the install, not the account. */
export async function clearAccountKey(): Promise<void> {
  await run('readwrite', (store) => store.delete(ACCOUNT));
}

/** This install's device id, made on first use. */
export async function deviceId(): Promise<string> {
  const stored = await run<string | undefined>('readonly', (store) => store.get(DEVICE));
  if (stored) return stored;
  const made = newDeviceId();
  // `add` rather than `put`: if another tab made one in between, this fails and theirs wins.
  try {
    await run('readwrite', (store) => store.add(made, DEVICE));
    return made;
  } catch {
    return (await run<string | undefined>('readonly', (store) => store.get(DEVICE))) ?? made;
  }
}
