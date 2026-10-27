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
   * A recovery key made with this key and not yet confirmed with "I saved it". The user
   * leaves the page to save it (a password manager, a note), which is when a tab gets
   * reloaded or discarded; held only in React state it was gone, and the account kept a
   * recovery wrap nobody had seen, with nothing to say so. Kept here it comes back on the
   * next load. It is readable, unlike the key, and opens that key, so it stays only
   * until it is confirmed.
   */
  recoveryKey?: string;
}

export interface LoadedAccountKey {
  key: CryptoKey;
  recoveryKey?: string;
}

let opening: Promise<IDBDatabase> | undefined;

// IndexedDB says nothing to other tabs when a record changes, so a tab that looked before
// another tab's sign-in stored the key would keep asking for a password. Every write is
// announced here instead. One channel for sending and listening, since a channel does not
// hear its own messages; missing where the browser has no BroadcastChannel.
const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel(DB_NAME);

function announce() {
  channel?.postMessage('changed');
}

/** Calls `listener` when another tab (or the extension's worker) changes the stored key. */
export function onAccountKeyChanged(listener: () => void): () => void {
  channel?.addEventListener('message', listener);
  return () => channel?.removeEventListener('message', listener);
}

function database(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      const db = request.result;
      // The connection is kept for the page's life, so it has to let go when asked: a
      // later build opening a new version in another tab waits until every open
      // connection closes, and a tab left open for days would hold it up.
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      // The browser can close it under us (site data cleared); the next call opens anew
      // rather than failing on a dead connection until the page is reloaded.
      db.onclose = () => {
        opening = undefined;
      };
      resolve(db);
    };
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

/**
 * Keeps `accountKey` for `uid` as a key that cannot be exported, with the recovery key
 * just made for it, if one was, until `confirmRecoveryKey`. The caller drops the bytes.
 */
export async function saveAccountKey(uid: string, accountKey: Uint8Array, recoveryKey?: string): Promise<void> {
  const stored: StoredAccountKey = { uid, key: await accountBaseKey(accountKey), ...(recoveryKey && { recoveryKey }) };
  await run('readwrite', (store) => store.put(stored, ACCOUNT));
  announce();
}

/** The stored account key, if there is one and it is `uid`'s, with an unconfirmed recovery key. */
export async function loadAccountKey(uid: string): Promise<LoadedAccountKey | undefined> {
  const stored = await run<StoredAccountKey | undefined>('readonly', (store) => store.get(ACCOUNT));
  return stored?.uid === uid ? { key: stored.key, recoveryKey: stored.recoveryKey } : undefined;
}

/** "I saved it": the recovery key is the user's now, and leaves the store. */
export async function confirmRecoveryKey(uid: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    // Read and rewritten in one transaction, so a key saved meanwhile is not undone.
    const request = store.get(ACCOUNT);
    request.onsuccess = () => {
      const stored = request.result as StoredAccountKey | undefined;
      if (stored?.uid === uid && stored.recoveryKey) store.put({ uid: stored.uid, key: stored.key }, ACCOUNT);
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  announce();
}

/** At sign-out. The device id stays: it belongs to the install, not the account. */
export async function clearAccountKey(): Promise<void> {
  await run('readwrite', (store) => store.delete(ACCOUNT));
  announce();
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
