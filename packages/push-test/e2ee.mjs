// The reference implementation of docs/e2ee.md: every construction in the specification,
// in the order the document presents them, on WebCrypto and nothing else. The five clients
// are checked against vectors.json, which vectors.mjs produces from this file, so a change
// here that changes a byte is a change to the specification and belongs in the document
// first.
//
// Everything is on `crypto.subtle` rather than `node:crypto` so that the web app and the
// Chrome extension can lift functions from here as they are, and so that nothing here
// does what a client cannot. The HKDF steps are written out as two HMACs (the spec's
// choice, since every output is one hash block) instead of calling `deriveBits` with
// HKDF, which would hide the construction the other platforms have to write by hand.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const KDF = "pbkdf2-sha256-600000";
export const PBKDF2_ITERATIONS = 600000;
export const CHUNK_SIZE = 1024 * 1024;
export const TAG_LENGTH = 16;
export const NONCE_LENGTH = 12;
export const FILE_MAGIC = "PTE1";
export const FILE_PREFIX_LENGTH = 8;
export const FILE_HEADER_LENGTH = FILE_MAGIC.length + FILE_PREFIX_LENGTH;
export const RECOVERY_KEY_LENGTH = 20;

// ---------------------------------------------------------------------------------------
// Bytes and encodings

export const utf8 = (s) => encoder.encode(s);

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

export const be32 = (n) => {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError(`not a uint32: ${n}`);
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
};

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const fromHex = (s) => {
  if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new Error("not hex");
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
};

// Standard base64 with padding is what `n`, `ct`, `fk` and `np` carry in a document;
// base64url without padding is what goes into a string the user or a URL might see (the
// Firebase password, ids, blind tokens). `btoa` and `atob` rather than `Buffer`, which the
// browser and the extension's service worker do not have, so this runs there unchanged.
// Both decoders reject what the alphabet or the length rules out, so a document field
// that was edited by hand fails here and not on a tag.
const toBinary = (bytes) => Array.from(bytes, (b) => String.fromCharCode(b)).join("");
export const base64 = (bytes) => btoa(toBinary(bytes));
export const fromBase64 = (s) => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error("not base64");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
export const base64url = (bytes) => base64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromBase64url = (s) => {
  if (/[^A-Za-z0-9_-]/.test(s) || s.length % 4 === 1) throw new Error("not base64url");
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b + "=".repeat((4 - (b.length % 4)) % 4));
};

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

const equal = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

// ---------------------------------------------------------------------------------------
// Primitives

export const sha256 = async (bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

export const hmacSha256 = async (key, message) => {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, message));
};

const ZERO_KEY = new Uint8Array(32);

// HKDF-SHA256 with an empty salt and one block of output, as the spec writes it out:
// extract with a key of 32 zero bytes, then expand with `label || 0x01`.
export const hkdfOneBlock = async (ikm, label) => {
  const prk = await hmacSha256(ZERO_KEY, ikm);
  return hmacSha256(prk, concat(utf8(label), new Uint8Array([0x01])));
};

const aesKey = async (raw, usages) => subtle.importKey("raw", raw, { name: "AES-GCM" }, false, usages);

export const aesGcmSeal = async (key, nonce, plaintext, aad) => {
  if (nonce.length !== NONCE_LENGTH) throw new Error(`nonce must be ${NONCE_LENGTH} bytes`);
  const k = await aesKey(key, ["encrypt"]);
  const params = { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_LENGTH * 8 };
  return new Uint8Array(await subtle.encrypt(params, k, plaintext));
};

// Throws on a bad tag, a bad AAD, or a truncated ciphertext; the caller never sees a
// partial plaintext.
export const aesGcmOpen = async (key, nonce, ciphertext, aad) => {
  if (nonce.length !== NONCE_LENGTH) throw new Error(`nonce must be ${NONCE_LENGTH} bytes`);
  if (ciphertext.length < TAG_LENGTH) throw new Error("ciphertext shorter than its tag");
  const k = await aesKey(key, ["decrypt"]);
  const params = { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: TAG_LENGTH * 8 };
  try {
    return new Uint8Array(await subtle.decrypt(params, k, ciphertext));
  } catch {
    // WebCrypto's error carries no detail on purpose; neither does this one.
    throw new Error("decryption failed");
  }
};

// ---------------------------------------------------------------------------------------
// Keys from the password and the email

// ASCII-only, so that every platform's idea of "lowercase" and "whitespace" cannot differ:
// A-Z map to a-z and nothing else changes; only space, tab, CR and LF are trimmed. The
// email is NFC-normalized first for the same reason the password is: two keyboards can
// produce the same accented letter as different code points.
export const normalizeEmail = (email) =>
  email
    .normalize("NFC")
    .replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")
    .replace(/[A-Z]/g, (c) => c.toLowerCase());

export const emailSalt = async (email) => sha256(utf8("pushthat/salt/v1:" + normalizeEmail(email)));

export const stretchPassword = async (password, salt) => {
  const k = await subtle.importKey("raw", utf8(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const params = { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS };
  return new Uint8Array(await subtle.deriveBits(params, k, 256));
};

export const firebasePassword = (authKey) => base64url(authKey);

export const deriveKeys = async (email, password) => {
  const salt = await emailSalt(email);
  const stretched = await stretchPassword(password, salt);
  const authKey = await hkdfOneBlock(stretched, "pushthat/auth/v1");
  const masterKey = await hkdfOneBlock(stretched, "pushthat/master/v1");
  return { salt, stretched, authKey, masterKey, firebasePassword: firebasePassword(authKey) };
};

// ---------------------------------------------------------------------------------------
// The account key and what hangs off it

export const newAccountKey = () => randomBytes(32);

export const accountSubkeys = async (accountKey) => ({
  metaKey: await hkdfOneBlock(accountKey, "pushthat/meta/v1"),
  searchKey: await hkdfOneBlock(accountKey, "pushthat/search/v1"),
});

export const newWrapId = () => base64url(randomBytes(8));
export const newDeviceId = () => base64url(randomBytes(16));
export const newObjectId = () => base64url(randomBytes(16));

const wrapAad = (uid) => utf8("pushthat/wrap/v1:" + uid);

// One entry of `users/{uid}.e2ee.wraps`, under `masterKey` (by: "password") or the
// recovery wrapping key (by: "recovery"). The nonce parameter exists for the vectors;
// callers never pass one.
export const wrapAccountKey = async (wrappingKey, accountKey, uid, by, nonce = randomBytes(NONCE_LENGTH)) => {
  if (accountKey.length !== 32) throw new Error("accountKey must be 32 bytes");
  if (by !== "password" && by !== "recovery") throw new Error(`unknown wrap: ${by}`);
  const ct = await aesGcmSeal(wrappingKey, nonce, accountKey, wrapAad(uid));
  return { by, n: base64(nonce), ct: base64(ct) };
};

export const unwrapAccountKey = async (wrappingKey, wrap, uid) => {
  const accountKey = await aesGcmOpen(wrappingKey, fromBase64(wrap.n), fromBase64(wrap.ct), wrapAad(uid));
  if (accountKey.length !== 32) throw new Error("unwrapped key is not 32 bytes");
  return accountKey;
};

// ---------------------------------------------------------------------------------------
// The recovery key

// Crockford's alphabet, in RFC 4648 bit order (most significant bit first, five bits a
// symbol). 20 bytes are 160 bits, which is exactly 32 symbols: no padding, no check
// symbol. Decoding is case-insensitive, drops hyphens and spaces, and reads I and L as 1
// and O as 0, which is the point of the alphabet.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const newRecoveryKey = () => randomBytes(RECOVERY_KEY_LENGTH);

export const encodeRecoveryKey = (bytes) => {
  if (bytes.length !== RECOVERY_KEY_LENGTH) throw new Error(`recovery key must be ${RECOVERY_KEY_LENGTH} bytes`);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g).join("-");
};

export const decodeRecoveryKey = (text) => {
  const symbols = text
    .toUpperCase()
    .replace(/[- ]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (symbols.length !== 32) throw new Error("a recovery key has 32 symbols");
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

export const recoveryWrappingKey = async (recoveryBytes) => {
  if (recoveryBytes.length !== RECOVERY_KEY_LENGTH) throw new Error(`recovery key must be ${RECOVERY_KEY_LENGTH} bytes`);
  return hkdfOneBlock(recoveryBytes, "pushthat/recovery/v1");
};

// ---------------------------------------------------------------------------------------
// The push envelope

const pushAad = (userId, pushId) => utf8(`pushthat/push/v1:${userId}:${pushId}`);

// `plaintext` is the envelope's JSON as bytes, or an object to serialize. The spec fixes
// no canonical JSON: the bytes a client encrypts are whatever its serializer produced,
// and the vectors give the bytes, not the object.
export const sealPush = async (metaKey, userId, pushId, plaintext, nonce = randomBytes(NONCE_LENGTH)) => {
  const bytes = plaintext instanceof Uint8Array ? plaintext : utf8(JSON.stringify(plaintext));
  const ct = await aesGcmSeal(metaKey, nonce, bytes, pushAad(userId, pushId));
  return { v: 1, n: base64(nonce), ct: base64(ct) };
};

export const openPushBytes = async (metaKey, userId, pushId, enc) => {
  if (enc.v !== 1) throw new Error(`unknown envelope version: ${enc.v}`);
  return aesGcmOpen(metaKey, fromBase64(enc.n), fromBase64(enc.ct), pushAad(userId, pushId));
};

export const openPush = async (metaKey, userId, pushId, enc) =>
  JSON.parse(decoder.decode(await openPushBytes(metaKey, userId, pushId, enc)));

// ---------------------------------------------------------------------------------------
// The blind index

// The rule the reference tokenizes by, which is the iOS generator's (SearchTokenGenerator
// .swift) with two things pinned that Swift leaves to its String: the text is NFC first,
// so a composed search term finds a decomposed title, and a prefix is a count of code
// points, which every platform can take cheaply, where Swift counts grapheme clusters.
// Words are split on anything that is not a letter, a combining mark or a digit; marks
// stay in the word, as they do in Swift's `alphanumerics`. The web app and Android run a
// different rule today (docs/e2ee.md, the blind index), and phase 4 has to settle on one.
// The set is returned in first-seen order so the vectors read in the order the spec's
// example lists them.
export const searchTokens = (text) => {
  const tokens = new Set();
  for (const word of text.normalize("NFC").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u)) {
    const points = Array.from(word);
    for (let i = 1; i <= points.length; i++) tokens.add(points.slice(0, i).join(""));
  }
  return Array.from(tokens);
};

// 16 base64url characters are 96 bits exactly, so nothing is cut mid-character.
export const blindToken = async (searchKey, token) => base64url(await hmacSha256(searchKey, utf8(token))).slice(0, 16);

export const blindIndex = async (searchKey, tokens) => {
  const out = [];
  for (const t of tokens) out.push(await blindToken(searchKey, t));
  return out;
};

// ---------------------------------------------------------------------------------------
// Files

export const newFileKey = () => randomBytes(32);
export const newFilePrefix = () => randomBytes(FILE_PREFIX_LENGTH);

export const fileHeader = (prefix) => {
  if (prefix.length !== FILE_PREFIX_LENGTH) throw new Error(`prefix must be ${FILE_PREFIX_LENGTH} bytes`);
  return concat(utf8(FILE_MAGIC), prefix);
};

const chunkNonce = (prefix, index) => concat(prefix, be32(index));
const chunkAad = (index, final) => concat(utf8("pushthat/file/v1"), be32(index), new Uint8Array([final ? 1 : 0]));

export const sealChunk = async (fk, prefix, index, chunk, final) => {
  if (final ? chunk.length > CHUNK_SIZE : chunk.length !== CHUNK_SIZE) {
    throw new Error(`chunk ${index} is ${chunk.length} bytes`);
  }
  return aesGcmSeal(fk, chunkNonce(prefix, index), chunk, chunkAad(index, final));
};

export const openChunk = async (fk, prefix, index, sealed, final) => {
  const plain = sealed.length - TAG_LENGTH;
  if (final ? plain > CHUNK_SIZE : plain !== CHUNK_SIZE) {
    throw new Error(`chunk ${index} is ${sealed.length} bytes`);
  }
  return aesGcmOpen(fk, chunkNonce(prefix, index), sealed, chunkAad(index, final));
};

// The whole file in memory, which the reference can afford. Chunks are every 1 MiB of the
// plaintext, so a file of n > 0 bytes has ceil(n / 1 MiB) chunks and the last one holds
// 1..1 MiB; the empty file is the one case with an empty final chunk.
export const encryptFile = async (fk, prefix, plaintext) => {
  const chunks = Math.max(1, Math.ceil(plaintext.length / CHUNK_SIZE));
  const parts = [fileHeader(prefix)];
  for (let i = 0; i < chunks; i++) {
    const chunk = plaintext.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    parts.push(await sealChunk(fk, prefix, i, chunk, i === chunks - 1));
  }
  return concat(...parts);
};

// The chunk boundaries follow from the length alone: every chunk but the last is exactly
// 1 MiB + 16 bytes on disk, so n = ceil(body / (1 MiB + 16)) chunks, and the remainder is
// the last. A body that leaves a last chunk shorter than its tag, or that is empty, is not
// a file. Every other corruption (a byte changed, a chunk dropped, moved or appended, the
// prefix swapped) fails on a tag, because the index and the final flag are in the AAD.
// `np` is the envelope's prefix and is not optional: the header must carry the same
// bytes, which ties the object to its push, and a port that could leave it out would.
export const decryptFile = async (fk, file, np) => {
  if (!(np instanceof Uint8Array) || np.length !== FILE_PREFIX_LENGTH) throw new Error("the envelope's np is required");
  if (file.length < FILE_HEADER_LENGTH + TAG_LENGTH) throw new Error("file too short");
  if (!equal(file.subarray(0, FILE_MAGIC.length), utf8(FILE_MAGIC))) throw new Error("not an encrypted file");
  const prefix = file.subarray(FILE_MAGIC.length, FILE_HEADER_LENGTH);
  if (!equal(prefix, np)) throw new Error("file prefix does not match the push");

  const body = file.length - FILE_HEADER_LENGTH;
  const sealedSize = CHUNK_SIZE + TAG_LENGTH;
  const chunks = Math.ceil(body / sealedSize);
  const parts = [];
  for (let i = 0; i < chunks; i++) {
    const start = FILE_HEADER_LENGTH + i * sealedSize;
    const end = i === chunks - 1 ? file.length : start + sealedSize;
    parts.push(await openChunk(fk, prefix, i, file.subarray(start, end), i === chunks - 1));
  }
  return concat(...parts);
};
