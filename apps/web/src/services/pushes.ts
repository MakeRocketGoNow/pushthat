import {
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
  where,
} from 'firebase/firestore';
import { type FirebaseStorage, deleteObject, getBlob, ref, uploadBytes } from 'firebase/storage';

import {
  CHUNK_SIZE,
  type Enc,
  FILE_HEADER_LENGTH,
  type FileEnvelope,
  TAG_LENGTH,
  type UrlEnvelope,
  accountSubkeyKeys,
  base64,
  blindIndex,
  blindToken,
  decryptBlob,
  encryptBlob,
  fromBase64,
  newFileKey,
  newFilePrefix,
  newObjectId,
  openPush,
  sealPush,
  searchTokens,
  searchWord,
} from './e2ee';
import { deviceId, loadAccountKey, rememberKeyVersion } from './keyStore';

/**
 * Pushes as docs/e2ee.md has them since phase 4 of that plan: written with their content in
 * `enc` and a blind index, read in either shape (a plaintext push stays readable until the
 * migration below reaches it, and phase 5 is when the rules stop taking new ones), files
 * encrypted before they are uploaded. The web app's pages and the Chrome extension's service
 * worker both work through here, so the worker never imports React and the page never
 * imports the worker.
 */

/** What this device writes and reads pushes with: the subkeys, never the account key. */
export interface PushKeys {
  uid: string;
  metaKey: CryptoKey;
  searchKey: CryptoKey;
  /** The version the stored key was opened at, which a push must carry to be accepted. */
  keyVersion: number;
  deviceId: string;
}

/**
 * The keys for `uid`, or undefined when this device holds none for that account (signed
 * out, or a session that has not unlocked yet).
 *
 * A key stored before keys carried their version is given the account's current one, read
 * once and remembered. That is the version it was opened at unless a reset replaced the
 * account key between that sign-in and this read, the one case it gets wrong, and then the
 * pushes it writes fail to open on the other devices rather than leaking anything.
 */
export async function loadPushKeys(db: Firestore, uid: string): Promise<PushKeys | undefined> {
  const stored = await loadAccountKey(uid);
  if (!stored) return undefined;
  let keyVersion = stored.keyVersion;
  if (keyVersion === undefined) {
    const read = (await getDoc(doc(db, 'users', uid))).data()?.e2ee?.keyVersion;
    if (typeof read !== 'number') return undefined;
    keyVersion = read;
    await rememberKeyVersion(uid, read);
  }
  const { metaKey, searchKey } = await accountSubkeyKeys(stored.key);
  return { uid, metaKey, searchKey, keyVersion, deviceId: await deviceId() };
}

// ---------------------------------------------------------------------------------------
// Reading

/** An encrypted file push's object, and what is needed to open it. */
export interface PushFile {
  objectPath: string;
  envelope: FileEnvelope;
}

/** A push as the list and the extension show it, whichever shape it was stored in. */
export interface Push {
  id: string;
  type: string;
  createdAt: Date;
  /** What the row says: the title, the URL when a URL push has none yet, or a file's name. */
  title: string;
  /** A URL push's URL, or a plaintext file push's download URL. */
  url?: string;
  ext?: string;
  /** Set on a file push stored since encryption, which is opened through `downloadFile`. */
  file?: PushFile;
  /**
   * Encrypted under a key this device does not hold: one a reset without the recovery key
   * replaced, or a version this device has not caught up with. It can be deleted, not
   * opened.
   */
  locked?: boolean;
}

export const LOCKED_TITLE = 'Locked push';
export const LOCKED_MESSAGE =
  'This push was encrypted with a key this account no longer has. It can be deleted but not opened.';

const isEnc = (value: unknown): value is Enc =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Enc).n === 'string' &&
  typeof (value as Enc).ct === 'string';

const stringOr = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

export async function readPush(snapshot: DocumentSnapshot<DocumentData>, keys: PushKeys | undefined): Promise<Push> {
  const data = snapshot.data() ?? {};
  const base = {
    id: snapshot.id,
    type: stringOr(data.type, 'url'),
    // A push this device just wrote and reads back from its cache has no server time yet.
    createdAt: typeof data.createdAt?.toDate === 'function' ? data.createdAt.toDate() : new Date(),
  };

  if (!('enc' in data)) {
    const url = stringOr(data.url);
    return { ...base, url, title: stringOr(data.title) || url, ext: stringOr(data.ext) || undefined };
  }

  const locked: Push = { ...base, title: LOCKED_TITLE, locked: true };
  if (!keys || data.keyVersion !== keys.keyVersion || !isEnc(data.enc)) return locked;
  let opened: Record<string, unknown>;
  try {
    opened = (await openPush(keys.metaKey, stringOr(data.userId), snapshot.id, data.enc)) as Record<string, unknown>;
  } catch {
    return locked;
  }
  if (typeof opened !== 'object' || opened === null) return locked;

  if (base.type === 'file') {
    const envelope: FileEnvelope = {
      name: stringOr(opened.name, 'File'),
      mime: stringOr(opened.mime),
      size: typeof opened.size === 'number' ? opened.size : 0,
      ext: stringOr(opened.ext),
      fk: typeof opened.fk === 'string' ? opened.fk : undefined,
      np: typeof opened.np === 'string' ? opened.np : undefined,
      legacyPlain: opened.legacyPlain === true,
    };
    return {
      ...base,
      title: envelope.name,
      ext: envelope.ext || undefined,
      file: { objectPath: stringOr(data.objectPath), envelope },
    };
  }
  const url = stringOr(opened.url);
  return { ...base, url, title: stringOr(opened.title) || url, ext: stringOr(opened.ext) || undefined };
}

/**
 * The blind token a search term looks up: its first word, by the tokenizer's rule. Undefined
 * for a term with no word in it, which is no search at all.
 */
export async function searchTokenFor(keys: PushKeys, term: string): Promise<string | undefined> {
  const word = searchWord(term);
  return word === undefined ? undefined : blindToken(keys.searchKey, word);
}

// ---------------------------------------------------------------------------------------
// Writing

// `enc.ct`'s bound in the rules: about 12 KB of JSON, which only an absurd URL reaches. Said
// here, where the reason can be given, rather than as a refusal nobody can explain.
const MAX_CT_LENGTH = 16384;
// A title that long is not a title; cut so that the URL is what decides whether a push fits.
const MAX_TITLE = 1000;

export class PushTooLongError extends Error {}

const cut = (s: string, max: number) => Array.from(s).slice(0, max).join('');

const blind = (keys: PushKeys, text: string) => blindIndex(keys.searchKey, searchTokens(text));

/** The tokens of a URL push: its title and its URL, so one with no title yet is found too. */
const urlSearchText = (envelope: UrlEnvelope) => `${envelope.title} ${envelope.url}`;

/**
 * Makes a URL push. The id is chosen before anything is sealed, since the envelope's AAD
 * names it. `title` may be empty: a native device that receives the push scrapes the page
 * and writes the title back (docs/e2ee.md, Titles).
 */
export async function createUrlPush(db: Firestore, keys: PushKeys, url: string, title: string): Promise<string> {
  const pushRef = doc(collection(db, 'pushes'));
  const envelope: UrlEnvelope = { url, title: cut(title, MAX_TITLE), ext: '' };
  const enc = await sealPush(keys.metaKey, keys.uid, pushRef.id, envelope);
  if (enc.ct.length > MAX_CT_LENGTH) throw new PushTooLongError('the URL is too long to push');
  await setDoc(pushRef, {
    userId: keys.uid,
    type: 'url',
    createdAt: serverTimestamp(),
    deviceId: keys.deviceId,
    keyVersion: keys.keyVersion,
    enc,
    searchTokens: await blind(keys, urlSearchText(envelope)),
  });
  return pushRef.id;
}

/**
 * The size of `plaintextBytes` once encrypted, which is what the Storage rules measure: the
 * header and one tag per 1 MiB chunk (one for the empty file). A file just under the tier's
 * limit can be just over it encrypted, and is better refused before the upload than by it.
 */
export const encryptedSize = (plaintextBytes: number): number =>
  FILE_HEADER_LENGTH + plaintextBytes + TAG_LENGTH * Math.max(1, Math.ceil(plaintextBytes / CHUNK_SIZE));

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * Encrypts `file` with a key of its own, uploads it under a random name, and makes the push
 * that carries the key, the name and the type. The upload comes first, as it always has;
 * a push refused after it (the month's limit, usually) would leave an object no push names
 * and no sweep finds, so the object is deleted before the error goes on.
 */
export async function createFilePush(
  db: Firestore,
  storage: FirebaseStorage,
  keys: PushKeys,
  file: File
): Promise<string> {
  const fk = newFileKey();
  const prefix = newFilePrefix();
  const objectPath = `uploads/${keys.uid}/${newObjectId()}`;
  const encrypted = await encryptBlob(fk, prefix, file);
  const uploaded = await uploadBytes(ref(storage, objectPath), encrypted, { contentType: 'application/octet-stream' });
  try {
    const pushRef = doc(collection(db, 'pushes'));
    const envelope: FileEnvelope = {
      name: file.name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      ext: extensionOf(file.name),
      fk: base64(fk),
      np: base64(prefix),
    };
    const enc = await sealPush(keys.metaKey, keys.uid, pushRef.id, envelope);
    if (enc.ct.length > MAX_CT_LENGTH) throw new PushTooLongError('the file name is too long to push');
    await setDoc(pushRef, {
      userId: keys.uid,
      type: 'file',
      createdAt: serverTimestamp(),
      deviceId: keys.deviceId,
      keyVersion: keys.keyVersion,
      enc,
      searchTokens: await blind(keys, file.name),
      objectPath,
    });
    return pushRef.id;
  } catch (error) {
    await deleteObject(uploaded.ref).catch((e) => console.error('Error removing the upload:', e));
    throw error;
  }
}

/**
 * A file push's bytes, decrypted, with the name to save them under. The object is read
 * through the SDK with the user's own sign-in (no download URL is stored any more), then
 * opened chunk by chunk; anything wrong with it throws, so the caller saves the whole file
 * or nothing. A push migrated from plaintext names an object uploaded before encryption,
 * which is read as it is.
 */
export async function downloadFile(storage: FirebaseStorage, file: PushFile): Promise<Blob> {
  const { envelope } = file;
  const object = await getBlob(ref(storage, file.objectPath));
  if (envelope.legacyPlain) return object;
  if (!envelope.fk || !envelope.np) throw new Error('the push has no file key');
  return decryptBlob(fromBase64(envelope.fk), fromBase64(envelope.np), object, envelope.mime);
}

// ---------------------------------------------------------------------------------------
// The migration

const MIGRATION_PAGE = 50;

// What an encrypted push may hold (firestore.rules, encryptedPushKeys, and expiresAt for a
// file push the trigger has already dated). Everything else on a plaintext push goes.
const ENCRYPTED_KEYS = new Set([
  'userId',
  'type',
  'createdAt',
  'expiresAt',
  'deviceId',
  'keyVersion',
  'enc',
  'searchTokens',
  'objectPath',
]);

/**
 * The single update that encrypts a plaintext push in place (docs/e2ee.md, Migration), or
 * undefined for one that cannot be migrated: a file push with no title names no object.
 * In place rather than recreated, because a create would notify every device and count
 * against the month.
 */
async function migrationOf(
  keys: PushKeys,
  snapshot: QueryDocumentSnapshot<DocumentData>
): Promise<DocumentData | undefined> {
  const data = snapshot.data();
  const title = stringOr(data.title);
  const ext = stringOr(data.ext);
  const update: DocumentData = {};
  for (const key of Object.keys(data)) {
    if (!ENCRYPTED_KEYS.has(key)) update[key] = deleteField();
  }

  if (data.type === 'file') {
    if (typeof data.title !== 'string' || !data.title) return undefined;
    // The bytes are in Storage as they were uploaded and expire within 30 days; re-encrypting
    // them would need a download and an upload, so the push says to read them as they are.
    const envelope: FileEnvelope = { name: title, mime: '', size: 0, ext, legacyPlain: true };
    update.enc = await sealPush(keys.metaKey, keys.uid, snapshot.id, envelope);
    update.searchTokens = await blind(keys, title);
    // The path the title named, which onPushRecordDeleted has been deleting with the push;
    // the rules hold the migration to exactly this.
    update.objectPath = `uploads/${keys.uid}/${title}`;
  } else {
    const envelope: UrlEnvelope = { url: stringOr(data.url), title, ext };
    update.enc = await sealPush(keys.metaKey, keys.uid, snapshot.id, envelope);
    update.searchTokens = await blind(keys, urlSearchText(envelope));
  }
  update.keyVersion = keys.keyVersion;
  update.deviceId = keys.deviceId;
  return update;
}

/**
 * Encrypts the account's plaintext pushes, newest first, a page of 50 at a time, and marks
 * `e2ee.migratedAt` once a pass has seen every push and left none behind. Any device that
 * finds the mark skips the pass; a pass that could not migrate a push leaves the mark off,
 * and the next start tries again. Each push is its own update, so one refused does not
 * stop the page, and two devices migrating at once cost one refused update each: the
 * rules take the migration only from a push that has no `enc` yet.
 *
 * Pushes with no `createdAt` are not returned by the ordered query and stay as they are.
 */
export async function migratePushes(db: Firestore, keys: PushKeys): Promise<void> {
  const userRef = doc(db, 'users', keys.uid);
  const e2ee = (await getDoc(userRef)).data()?.e2ee;
  if (!e2ee || e2ee.migratedAt) return;
  // This device's key is not the account's: whatever it sealed, nobody else could open.
  if (e2ee.keyVersion !== keys.keyVersion) return;

  let complete = true;
  let last: QueryDocumentSnapshot<DocumentData> | undefined;
  for (;;) {
    const constraints = [where('userId', '==', keys.uid), orderBy('createdAt', 'desc'), limit(MIGRATION_PAGE)];
    const page = await getDocs(query(collection(db, 'pushes'), ...constraints, ...(last ? [startAfter(last)] : [])));
    if (page.empty) break;
    last = page.docs[page.docs.length - 1];
    const results = await Promise.all(
      page.docs
        .filter((snapshot) => !('enc' in snapshot.data()))
        .map(async (snapshot) => {
          try {
            const update = await migrationOf(keys, snapshot);
            if (!update) return false;
            await updateDoc(snapshot.ref, update);
            return true;
          } catch (error) {
            console.error('Could not encrypt push', snapshot.id, error);
            return false;
          }
        })
    );
    if (results.includes(false)) complete = false;
  }
  if (complete) await updateDoc(userRef, { 'e2ee.migratedAt': serverTimestamp() });
}
