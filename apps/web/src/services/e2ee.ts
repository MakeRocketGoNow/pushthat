// The end-to-end encryption of docs/e2ee.md at the repository root, as the web app and the
// Chrome extension use it: deriving the password's keys, wrapping the account key under them
// and under the recovery key (the sign-in and the password reset page), the account key's
// subkeys, raw and in the non-extractable form the app stores, the push envelope, the blind
// index, and files.
//
// Lifted from the reference implementation, packages/push-test/e2ee.mjs, which is written
// on WebCrypto and btoa/atob so that it runs in the browser unchanged; this is that code
// with types. The keys a push is sealed or searched with are the stored non-extractable
// CryptoKeys, so those functions take either; the wraps take raw bytes only, which is all
// anything holds while wrapping. A change here that changes a byte is a change to the
// specification: `npm run test:keys` checks every function against vectors.json.
//
// Only erasable TypeScript (no enums, no parameter properties) and no imports, so that
// Node runs this file as it is for the vector test.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
// Fatal, so an envelope that opened but is not UTF-8 fails here rather than reading as
// replacement characters.
const decoder = new TextDecoder('utf-8', { fatal: true });

export const KDF = 'pbkdf2-sha256-600000';
export const PBKDF2_ITERATIONS = 600000;
export const TAG_LENGTH = 16;
export const NONCE_LENGTH = 12;
export const RECOVERY_KEY_LENGTH = 20;
export const CHUNK_SIZE = 1024 * 1024;
export const FILE_MAGIC = 'PTE1';
export const FILE_PREFIX_LENGTH = 8;
export const FILE_HEADER_LENGTH = FILE_MAGIC.length + FILE_PREFIX_LENGTH;
export const MAX_SEARCH_TOKENS = 3000;

/** Raw key bytes, or a key already imported for the use (the stored subkeys are these). */
export type KeyInput = Uint8Array | CryptoKey;

export type WrapKind = 'password' | 'recovery';

/** One entry of `users/{uid}.e2ee.wraps`. */
export interface Wrap {
  by: WrapKind;
  n: string;
  ct: string;
}

/** `users/{uid}.e2ee`, as the spec's "The user document" gives it. */
export interface E2ee {
  v: number;
  kdf: string;
  keyVersion: number;
  wraps: Record<string, Wrap>;
  migratedAt?: unknown;
}

export interface DerivedKeys {
  salt: Uint8Array;
  stretched: Uint8Array;
  authKey: Uint8Array;
  masterKey: Uint8Array;
  /** What Firebase Auth is given as the password: `base64url(authKey)`. */
  firebasePassword: string;
}

// ---------------------------------------------------------------------------------------
// Bytes and encodings

export const utf8 = (s: string): Uint8Array => encoder.encode(s);

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

// Standard base64 with padding for `n` and `ct`; base64url without padding for the
// Firebase password and the ids. Both decoders reject what the alphabet or the length
// rules out, so a field edited by hand fails here and not on a tag.
const toBinary = (bytes: Uint8Array): string => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
export const base64 = (bytes: Uint8Array): string => btoa(toBinary(bytes));
export const fromBase64 = (s: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error('not base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
export const base64url = (bytes: Uint8Array): string =>
  base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------------------------------
// Primitives

export const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await subtle.digest('SHA-256', bytes));

export const hmacSha256 = async (key: KeyInput, message: Uint8Array): Promise<Uint8Array> => {
  const k =
    key instanceof Uint8Array
      ? await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      : key;
  return new Uint8Array(await subtle.sign('HMAC', k, message));
};

const ZERO_KEY = new Uint8Array(32);

// HKDF-SHA256 with an empty salt and one block of output, written out as the spec does:
// extract with a key of 32 zero bytes, then expand with `label || 0x01`.
export const hkdfOneBlock = async (ikm: Uint8Array, label: string): Promise<Uint8Array> => {
  const prk = await hmacSha256(ZERO_KEY, ikm);
  return hmacSha256(prk, concat(utf8(label), new Uint8Array([0x01])));
};

const aesParams = (nonce: Uint8Array, aad: Uint8Array): AesGcmParams => {
  if (nonce.length !== NONCE_LENGTH) throw new Error(`nonce must be ${NONCE_LENGTH} bytes`);
  return { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: TAG_LENGTH * 8 };
};

/** An AES-256-GCM key for both directions, imported once for a file's many chunks. */
export const aesKey = (key: KeyInput): Promise<CryptoKey> =>
  key instanceof Uint8Array
    ? subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    : Promise.resolve(key);

export const aesGcmSeal = async (
  key: KeyInput,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> => new Uint8Array(await subtle.encrypt(aesParams(nonce, aad), await aesKey(key), plaintext));

// Throws on a bad tag, a bad AAD or a truncated ciphertext; the caller never sees a
// partial plaintext.
export const aesGcmOpen = async (
  key: KeyInput,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> => {
  if (ciphertext.length < TAG_LENGTH) throw new Error('ciphertext shorter than its tag');
  const k = await aesKey(key);
  try {
    return new Uint8Array(await subtle.decrypt(aesParams(nonce, aad), k, ciphertext));
  } catch {
    // WebCrypto's error carries no detail on purpose; neither does this one.
    throw new Error('decryption failed');
  }
};

// ---------------------------------------------------------------------------------------
// Keys from the password and the email

// ASCII-only, so that no platform's idea of "lowercase" or "whitespace" can enter the
// salt: A-Z map to a-z and nothing else changes; only space, tab, CR and LF are trimmed.
// NFC first, as for the password, since two keyboards can spell one accented letter as
// different code points.
export const normalizeEmail = (email: string): string =>
  email
    .normalize('NFC')
    .replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
    .replace(/[A-Z]/g, (c) => c.toLowerCase());

export const emailSalt = async (email: string): Promise<Uint8Array> =>
  sha256(utf8('pushthat/salt/v1:' + normalizeEmail(email)));

export const stretchPassword = async (password: string, salt: Uint8Array): Promise<Uint8Array> => {
  const k = await subtle.importKey('raw', utf8(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const params = { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS };
  return new Uint8Array(await subtle.deriveBits(params, k, 256));
};

export const firebasePassword = (authKey: Uint8Array): string => base64url(authKey);

/** About a second of PBKDF2 on a phone, less on a desktop. */
export const deriveKeys = async (email: string, password: string): Promise<DerivedKeys> => {
  const salt = await emailSalt(email);
  const stretched = await stretchPassword(password, salt);
  const authKey = await hkdfOneBlock(stretched, 'pushthat/auth/v1');
  const masterKey = await hkdfOneBlock(stretched, 'pushthat/master/v1');
  return { salt, stretched, authKey, masterKey, firebasePassword: firebasePassword(authKey) };
};

// ---------------------------------------------------------------------------------------
// The account key and its wraps

export const newAccountKey = (): Uint8Array => randomBytes(32);
export const newWrapId = (): string => base64url(randomBytes(8));
export const newDeviceId = (): string => base64url(randomBytes(16));

export interface AccountSubkeys {
  metaKey: Uint8Array;
  searchKey: Uint8Array;
}

/** The two subkeys as bytes, written out as the spec writes them; the vectors pin these. */
export const accountSubkeys = async (accountKey: Uint8Array): Promise<AccountSubkeys> => ({
  metaKey: await hkdfOneBlock(accountKey, 'pushthat/meta/v1'),
  searchKey: await hkdfOneBlock(accountKey, 'pushthat/search/v1'),
});

/**
 * The account key as the web app keeps it after sign-in (docs/e2ee.md, Where keys live
 * on each device): an HKDF base key that cannot be exported, which IndexedDB stores as
 * it is. A script on the page can derive the subkeys from it and use them, and can never
 * read a byte of any of them.
 */
export const accountBaseKey = (accountKey: Uint8Array): Promise<CryptoKey> =>
  subtle.importKey('raw', accountKey, 'HKDF', false, ['deriveKey']);

/**
 * The subkeys from the stored base key, by WebCrypto's own HKDF with an empty salt, which
 * is byte for byte `accountSubkeys` (the vector test checks one against the other). Also
 * not extractable.
 */
export const accountSubkeyKeys = async (base: CryptoKey): Promise<{ metaKey: CryptoKey; searchKey: CryptoKey }> => {
  const hkdf = (label: string): HkdfParams => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: utf8(label),
  });
  return {
    metaKey: await subtle.deriveKey(hkdf('pushthat/meta/v1'), base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    searchKey: await subtle.deriveKey(
      hkdf('pushthat/search/v1'),
      base,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      ['sign']
    ),
  };
};

const wrapAad = (uid: string): Uint8Array => utf8('pushthat/wrap/v1:' + uid);

// The nonce parameter exists for the vectors; callers never pass one.
export const wrapAccountKey = async (
  wrappingKey: Uint8Array,
  accountKey: Uint8Array,
  uid: string,
  by: WrapKind,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH)
): Promise<Wrap> => {
  if (accountKey.length !== 32) throw new Error('accountKey must be 32 bytes');
  if (by !== 'password' && by !== 'recovery') throw new Error(`unknown wrap: ${by}`);
  const ct = await aesGcmSeal(wrappingKey, nonce, accountKey, wrapAad(uid));
  return { by, n: base64(nonce), ct: base64(ct) };
};

export const unwrapAccountKey = async (wrappingKey: Uint8Array, wrap: Wrap, uid: string): Promise<Uint8Array> => {
  const accountKey = await aesGcmOpen(wrappingKey, fromBase64(wrap.n), fromBase64(wrap.ct), wrapAad(uid));
  if (accountKey.length !== 32) throw new Error('unwrapped key is not 32 bytes');
  return accountKey;
};

// ---------------------------------------------------------------------------------------
// The recovery key

// Crockford's alphabet in RFC 4648 bit order (most significant bit first, five bits a
// symbol). 20 bytes are 160 bits, exactly 32 symbols: no padding, no check symbol.
// Reading one back is case-insensitive, drops hyphens and spaces, and reads I and L as 1
// and O as 0, which is the point of the alphabet.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const newRecoveryKey = (): Uint8Array => randomBytes(RECOVERY_KEY_LENGTH);

export const encodeRecoveryKey = (bytes: Uint8Array): string => {
  if (bytes.length !== RECOVERY_KEY_LENGTH) throw new Error(`recovery key must be ${RECOVERY_KEY_LENGTH} bytes`);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
};

export const decodeRecoveryKey = (text: string): Uint8Array => {
  const symbols = text.toUpperCase().replace(/[- ]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (symbols.length !== 32) throw new Error('a recovery key has 32 symbols');
  const out = new Uint8Array(RECOVERY_KEY_LENGTH);
  let bits = 0;
  let acc = 0;
  let i = 0;
  for (const c of symbols) {
    const v = CROCKFORD.indexOf(c);
    if (v < 0) throw new Error(`not a recovery key symbol: ${c}`);
    acc = ((acc << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out[i++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
};

export const recoveryWrappingKey = async (recoveryBytes: Uint8Array): Promise<Uint8Array> => {
  if (recoveryBytes.length !== RECOVERY_KEY_LENGTH) {
    throw new Error(`recovery key must be ${RECOVERY_KEY_LENGTH} bytes`);
  }
  return hkdfOneBlock(recoveryBytes, 'pushthat/recovery/v1');
};

// ---------------------------------------------------------------------------------------
// The push envelope

/** `enc` on a push document: AES-256-GCM under `metaKey`, the nonce and `ct` in base64. */
export interface Enc {
  v: number;
  n: string;
  ct: string;
}

/** A URL push's plaintext (docs/e2ee.md, The push envelope). `title` is "" until known. */
export interface UrlEnvelope {
  url: string;
  title: string;
  ext: string;
}

/**
 * A file push's plaintext. `fk` and `np` are the file's key and nonce prefix in base64; a
 * push migrated from plaintext has neither and says `legacyPlain`, since its object was
 * uploaded before encryption and is read as it is.
 */
export interface FileEnvelope {
  name: string;
  mime: string;
  size: number;
  ext: string;
  fk?: string;
  np?: string;
  legacyPlain?: boolean;
}

// The AAD binds a ciphertext to its document: moved to another push, it does not open.
const pushAad = (userId: string, pushId: string): Uint8Array => utf8(`pushthat/push/v1:${userId}:${pushId}`);

/**
 * Seals a push's plaintext: the JSON bytes, or an object this serializes. No canonical JSON
 * is fixed, so the bytes are whatever `JSON.stringify` wrote and every reader parses what it
 * finds. The nonce parameter exists for the vectors; callers never pass one.
 */
export const sealPush = async (
  metaKey: KeyInput,
  userId: string,
  pushId: string,
  plaintext: Uint8Array | UrlEnvelope | FileEnvelope,
  nonce: Uint8Array = randomBytes(NONCE_LENGTH)
): Promise<Enc> => {
  const bytes = plaintext instanceof Uint8Array ? plaintext : utf8(JSON.stringify(plaintext));
  const ct = await aesGcmSeal(metaKey, nonce, bytes, pushAad(userId, pushId));
  return { v: 1, n: base64(nonce), ct: base64(ct) };
};

export const openPushBytes = async (
  metaKey: KeyInput,
  userId: string,
  pushId: string,
  enc: Enc
): Promise<Uint8Array> => {
  if (enc.v !== 1) throw new Error(`unknown envelope version: ${enc.v}`);
  return aesGcmOpen(metaKey, fromBase64(enc.n), fromBase64(enc.ct), pushAad(userId, pushId));
};

/** The envelope's JSON, unchecked: the caller reads the fields its type needs. */
export const openPush = async (metaKey: KeyInput, userId: string, pushId: string, enc: Enc): Promise<unknown> =>
  JSON.parse(decoder.decode(await openPushBytes(metaKey, userId, pushId, enc)));

// ---------------------------------------------------------------------------------------
// The blind index

// The one rule every client tokenizes by (docs/e2ee.md, Search): NFC, lowercase without a
// locale, split on anything that is not a letter, a combining mark or a digit. Blinded
// tokens from two rules never meet, so this is the reference's rule exactly.
const words = (text: string): string[] =>
  text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((word) => word.length > 0);

/**
 * Every prefix of every word, counted in code points (`Array.from` splits by code point,
 * never through a surrogate pair), once each in the order first seen, cut at the rules'
 * bound on `searchTokens`.
 */
export const searchTokens = (text: string): string[] => {
  const tokens = new Set<string>();
  for (const word of words(text)) {
    const points = Array.from(word);
    for (let i = 1; i <= points.length; i++) {
      if (tokens.size === MAX_SEARCH_TOKENS) return Array.from(tokens);
      tokens.add(points.slice(0, i).join(''));
    }
  }
  return Array.from(tokens);
};

/**
 * The token a search looks up: the term's first word, by the same rule, or undefined for a
 * term with no word in it. One token, because a query takes one `array-contains`.
 */
export const searchWord = (term: string): string | undefined => words(term)[0];

/** 16 base64url characters are 96 bits exactly, so nothing is cut mid-character. */
export const blindToken = async (searchKey: KeyInput, token: string): Promise<string> =>
  base64url(await hmacSha256(searchKey, utf8(token))).slice(0, 16);

export const blindIndex = (searchKey: KeyInput, tokens: string[]): Promise<string[]> =>
  Promise.all(tokens.map((token) => blindToken(searchKey, token)));

// ---------------------------------------------------------------------------------------
// Files

export const newFileKey = (): Uint8Array => randomBytes(32);
export const newFilePrefix = (): Uint8Array => randomBytes(FILE_PREFIX_LENGTH);
export const newObjectId = (): string => base64url(randomBytes(16));

const be32 = (n: number): Uint8Array => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`not a uint32: ${n}`);
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
};

const equal = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

export const fileHeader = (prefix: Uint8Array): Uint8Array => {
  if (prefix.length !== FILE_PREFIX_LENGTH) throw new Error(`prefix must be ${FILE_PREFIX_LENGTH} bytes`);
  return concat(utf8(FILE_MAGIC), prefix);
};

const chunkNonce = (prefix: Uint8Array, index: number) => concat(prefix, be32(index));
const chunkAad = (index: number, final: boolean) =>
  concat(utf8('pushthat/file/v1'), be32(index), new Uint8Array([final ? 1 : 0]));

export const sealChunk = async (
  fk: KeyInput,
  prefix: Uint8Array,
  index: number,
  chunk: Uint8Array,
  final: boolean
): Promise<Uint8Array> => {
  if (final ? chunk.length > CHUNK_SIZE : chunk.length !== CHUNK_SIZE) {
    throw new Error(`chunk ${index} is ${chunk.length} bytes`);
  }
  if (final && index > 0 && chunk.length === 0) throw new Error('only the empty file has an empty final chunk');
  return aesGcmSeal(fk, chunkNonce(prefix, index), chunk, chunkAad(index, final));
};

export const openChunk = async (
  fk: KeyInput,
  prefix: Uint8Array,
  index: number,
  sealed: Uint8Array,
  final: boolean
): Promise<Uint8Array> => {
  const plain = sealed.length - TAG_LENGTH;
  if (final ? plain > CHUNK_SIZE : plain !== CHUNK_SIZE) throw new Error(`chunk ${index} is ${sealed.length} bytes`);
  return aesGcmOpen(fk, chunkNonce(prefix, index), sealed, chunkAad(index, final));
};

export interface ChunkSpan {
  index: number;
  start: number;
  end: number;
  final: boolean;
}

/**
 * Where each sealed chunk of an encrypted object of `length` bytes lies, from the length
 * alone: every chunk but the last is 1 MiB + 16 bytes, so there are ceil(body / that) of
 * them and the remainder is the last, which holds at least its tag. Only the empty file has
 * an empty last chunk: a full chunk followed by a bare tag is a second encoding of the same
 * bytes, refused here as the reference refuses it, so no client opens what another refuses.
 */
export const chunkLayout = (length: number): ChunkSpan[] => {
  if (length < FILE_HEADER_LENGTH + TAG_LENGTH) throw new Error('file too short');
  const sealedSize = CHUNK_SIZE + TAG_LENGTH;
  const count = Math.ceil((length - FILE_HEADER_LENGTH) / sealedSize);
  const last = length - FILE_HEADER_LENGTH - (count - 1) * sealedSize;
  if (last < TAG_LENGTH || (count > 1 && last === TAG_LENGTH)) throw new Error('not a file: bad last chunk');
  return Array.from({ length: count }, (_, index) => {
    const start = FILE_HEADER_LENGTH + index * sealedSize;
    const final = index === count - 1;
    return { index, start, end: final ? length : start + sealedSize, final };
  });
};

const bytesOf = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

/**
 * Encrypts `source` into a Blob 1 MiB at a time, so that only one chunk of plaintext is in
 * memory beside the sealed parts already made; the browser may keep a large Blob's parts on
 * disk. A Blob knows its size, so the last chunk is known before it is read and needs no
 * holding back. The empty file is one empty final chunk, 28 bytes in all.
 */
export const encryptBlob = async (fk: KeyInput, prefix: Uint8Array, source: Blob): Promise<Blob> => {
  const key = await aesKey(fk);
  const count = Math.max(1, Math.ceil(source.size / CHUNK_SIZE));
  const parts: Uint8Array[] = [fileHeader(prefix)];
  for (let i = 0; i < count; i++) {
    const chunk = await bytesOf(source.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE));
    parts.push(await sealChunk(key, prefix, i, chunk, i === count - 1));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
};

/**
 * Decrypts an object `encryptBlob` made, chunk by chunk by `chunkLayout`. `np` is the
 * envelope's prefix and is required: the header must carry the same bytes, which ties the
 * object to its push. Throws on anything wrong (a tag, the layout, the magic, the prefix),
 * so the caller has the whole file or nothing, never a short one.
 */
export const decryptBlob = async (fk: KeyInput, np: Uint8Array, encrypted: Blob, type = ''): Promise<Blob> => {
  if (np.length !== FILE_PREFIX_LENGTH) throw new Error("the envelope's np is required");
  const layout = chunkLayout(encrypted.size);
  const header = await bytesOf(encrypted.slice(0, FILE_HEADER_LENGTH));
  if (!equal(header.subarray(0, FILE_MAGIC.length), utf8(FILE_MAGIC))) throw new Error('not an encrypted file');
  const prefix = header.subarray(FILE_MAGIC.length);
  if (!equal(prefix, np)) throw new Error('file prefix does not match the push');
  const key = await aesKey(fk);
  const parts: Uint8Array[] = [];
  for (const { index, start, end, final } of layout) {
    parts.push(await openChunk(key, prefix, index, await bytesOf(encrypted.slice(start, end)), final));
  }
  return new Blob(parts, { type });
};
