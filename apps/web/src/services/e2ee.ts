// The end-to-end encryption keys (docs/e2ee.md at the repository root), as far as the web
// app needs them so far: deriving the password's keys, wrapping the account key under them
// and under the recovery key (the sign-in and the password reset page), and the account
// key's subkeys, raw and in the non-extractable form the app stores. The push envelope,
// files and search come with phase 4.
//
// Lifted from the reference implementation, packages/push-test/e2ee.mjs, which is written
// on WebCrypto and btoa/atob so that it runs in the browser unchanged; this is that code
// with types, and the wraps take raw bytes only (the reference also takes a CryptoKey,
// which nothing here holds while wrapping). A change here that changes a byte is a change
// to the specification: `npm run test:vectors` checks every function against vectors.json.
//
// Only erasable TypeScript (no enums, no parameter properties) and no imports, so that
// Node runs this file as it is for the vector test.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export const KDF = 'pbkdf2-sha256-600000';
export const PBKDF2_ITERATIONS = 600000;
export const TAG_LENGTH = 16;
export const NONCE_LENGTH = 12;
export const RECOVERY_KEY_LENGTH = 20;

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

export const hmacSha256 = async (key: Uint8Array, message: Uint8Array): Promise<Uint8Array> => {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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

export const aesGcmSeal = async (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> => {
  const k = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  return new Uint8Array(await subtle.encrypt(aesParams(nonce, aad), k, plaintext));
};

// Throws on a bad tag, a bad AAD or a truncated ciphertext; the caller never sees a
// partial plaintext.
export const aesGcmOpen = async (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> => {
  if (ciphertext.length < TAG_LENGTH) throw new Error('ciphertext shorter than its tag');
  const k = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
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
