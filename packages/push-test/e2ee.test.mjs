// Round trips for every construction in docs/e2ee.md, the failures the spec promises (a
// tampered file, a reordered chunk, a moved envelope), and a check that vectors.json is
// what vectors.mjs produces today. `node --test` from this folder runs them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  accountSubkeys,
  base64,
  base64url,
  blindIndex,
  blindToken,
  CHUNK_SIZE,
  decodeRecoveryKey,
  decryptFile,
  deriveKeys,
  emailSalt,
  encodeRecoveryKey,
  encryptFile,
  firebasePassword,
  fromBase64,
  fromBase64url,
  fromHex,
  hex,
  hkdfOneBlock,
  hmacSha256,
  newAccountKey,
  newDeviceId,
  newFileKey,
  newFilePrefix,
  newRecoveryKey,
  newWrapId,
  normalizeEmail,
  openChunk,
  openPush,
  openPushBytes,
  recoveryWrappingKey,
  sealChunk,
  sealPush,
  searchTokens,
  sha256,
  unwrapAccountKey,
  utf8,
  wrapAccountKey,
} from "./e2ee.mjs";
import { filePattern, generate, inputs, render, TAMPER_OFFSET, VECTORS_PATH } from "./vectors.mjs";

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8"));

// ---------------------------------------------------------------------------------------
// Keys

test("the email is NFC-normalized, trimmed of ASCII whitespace and ASCII-lowercased", () => {
  assert.equal(normalizeEmail(" Example.User@Example.com "), "example.user@example.com");
  assert.equal(normalizeEmail("\tA@B.C\r\n"), "a@b.c");
  // Only A-Z change: a non-ASCII capital stays, and a decomposed letter is composed.
  assert.equal(normalizeEmail("\u00c9mile@example.com"), "\u00c9mile@example.com");
  assert.equal(normalizeEmail("e\u0301@example.com"), "\u00e9@example.com");
  // Non-ASCII whitespace is not trimmed: it is part of the address as typed.
  assert.equal(normalizeEmail("\u00a0a@b.c"), "\u00a0a@b.c");
});

test("the salt is SHA-256 over the labelled normalized email", async () => {
  const salt = await emailSalt(" Example.User@Example.com ");
  assert.equal(hex(salt), hex(await sha256(utf8("pushthat/salt/v1:example.user@example.com"))));
  assert.equal(hex(salt), vectors.keys.salt);
});

test("the password is NFC-normalized and not trimmed", async () => {
  const composed = await deriveKeys(inputs.email, "Caf\u00e9 latte, 2026!");
  const decomposed = await deriveKeys(inputs.email, "Cafe\u0301 latte, 2026!");
  assert.equal(hex(composed.stretched), hex(decomposed.stretched));
  assert.equal(hex(composed.stretched), vectors.keys.stretched);
  const padded = await deriveKeys(inputs.email, " Caf\u00e9 latte, 2026!");
  assert.notEqual(hex(padded.stretched), hex(composed.stretched));
});

test("authKey and masterKey are HKDF-SHA256 written out, and differ", async () => {
  const keys = await deriveKeys(inputs.email, inputs.password);
  const prk = await hmacSha256(new Uint8Array(32), keys.stretched);
  const auth = await hmacSha256(prk, utf8("pushthat/auth/v1\u0001"));
  const master = await hmacSha256(prk, utf8("pushthat/master/v1\u0001"));
  assert.equal(hex(keys.authKey), hex(auth));
  assert.equal(hex(keys.masterKey), hex(master));
  assert.notEqual(hex(auth), hex(master));
  assert.equal(hex(keys.authKey), vectors.keys.authKey);
  assert.equal(hex(keys.masterKey), vectors.keys.masterKey);
});

test("the Firebase password is base64url of authKey, 43 characters, no padding", async () => {
  const keys = await deriveKeys(inputs.email, inputs.password);
  assert.equal(keys.firebasePassword.length, 43);
  assert.match(keys.firebasePassword, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(keys.firebasePassword, firebasePassword(keys.authKey));
  assert.equal(keys.firebasePassword, vectors.keys.firebasePassword);
});

test("hkdfOneBlock matches WebCrypto's own HKDF for one block", async () => {
  const ikm = fromHex(vectors.keys.stretched);
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8("pushthat/auth/v1") },
    k,
    256,
  );
  assert.equal(hex(new Uint8Array(bits)), hex(await hkdfOneBlock(ikm, "pushthat/auth/v1")));
});

// ---------------------------------------------------------------------------------------
// The account key, wraps and the recovery key

test("metaKey and searchKey derive from the account key and differ", async () => {
  const sub = await accountSubkeys(inputs.accountKey);
  assert.equal(hex(sub.metaKey), vectors.account.metaKey);
  assert.equal(hex(sub.searchKey), vectors.account.searchKey);
  assert.notEqual(hex(sub.metaKey), hex(sub.searchKey));
});

test("a password wrap round-trips and matches the vector", async () => {
  const keys = await deriveKeys(inputs.email, inputs.password);
  const wrap = await wrapAccountKey(keys.masterKey, inputs.accountKey, inputs.uid, "password", inputs.passwordWrapNonce);
  assert.deepEqual(wrap, {
    by: "password",
    n: vectors.account.passwordWrap.n,
    ct: vectors.account.passwordWrap.ct,
  });
  assert.equal(fromBase64(wrap.ct).length, 32 + 16);
  assert.equal(hex(await unwrapAccountKey(keys.masterKey, wrap, inputs.uid)), hex(inputs.accountKey));
});

test("a wrap opens only for its uid and its wrapping key", async () => {
  const keys = await deriveKeys(inputs.email, inputs.password);
  const wrap = await wrapAccountKey(keys.masterKey, inputs.accountKey, inputs.uid, "password");
  await assert.rejects(unwrapAccountKey(keys.masterKey, wrap, "someone-else"), /decryption failed/);
  const other = await deriveKeys(inputs.email, "a different password");
  await assert.rejects(unwrapAccountKey(other.masterKey, wrap, inputs.uid), /decryption failed/);
  const bent = { ...wrap, ct: wrap.ct.replace(/^./, (c) => (c === "A" ? "B" : "A")) };
  await assert.rejects(unwrapAccountKey(keys.masterKey, bent, inputs.uid), /decryption failed/);
});

test("the recovery key displays as 32 Crockford symbols in groups of four and decodes leniently", () => {
  const display = encodeRecoveryKey(inputs.recoveryKey);
  assert.match(display, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(display, vectors.account.recovery.display);
  assert.equal(hex(decodeRecoveryKey(display)), hex(inputs.recoveryKey));
  assert.equal(hex(decodeRecoveryKey(display.toLowerCase().replace(/-/g, " "))), hex(inputs.recoveryKey));
  assert.equal(hex(decodeRecoveryKey(display.replace(/-/g, ""))), hex(inputs.recoveryKey));
  // I, L read as 1 and O as 0, so a key copied by hand survives the usual slips.
  const slipped = display.replace(/1/g, "I").replace(/0/g, "O");
  assert.equal(hex(decodeRecoveryKey(slipped)), hex(inputs.recoveryKey));
  assert.throws(() => decodeRecoveryKey(display.slice(0, -1)), /32 symbols/);
  assert.throws(() => decodeRecoveryKey(display.replace(/^./, "U")), /not a recovery key symbol/);
  for (let i = 0; i < 20; i++) {
    const key = newRecoveryKey();
    assert.equal(hex(decodeRecoveryKey(encodeRecoveryKey(key))), hex(key));
  }
});

test("a recovery wrap round-trips and matches the vector", async () => {
  const wrappingKey = await recoveryWrappingKey(inputs.recoveryKey);
  assert.equal(hex(wrappingKey), vectors.account.recovery.wrappingKey);
  const wrap = await wrapAccountKey(wrappingKey, inputs.accountKey, inputs.uid, "recovery", inputs.recoveryWrapNonce);
  assert.equal(wrap.by, "recovery");
  assert.equal(wrap.n, vectors.account.recovery.wrap.n);
  assert.equal(wrap.ct, vectors.account.recovery.wrap.ct);
  assert.equal(hex(await unwrapAccountKey(wrappingKey, wrap, inputs.uid)), hex(inputs.accountKey));
  // A recovery key typed back from its display opens the same wrap.
  const typed = await recoveryWrappingKey(decodeRecoveryKey(vectors.account.recovery.display));
  assert.equal(hex(await unwrapAccountKey(typed, wrap, inputs.uid)), hex(inputs.accountKey));
});

test("the base64 codecs round-trip and reject what the alphabet or the length rules out", () => {
  for (const n of [0, 1, 2, 3, 4, 31, 32, 33]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    assert.equal(hex(fromBase64(base64(bytes))), hex(bytes));
    assert.equal(hex(fromBase64url(base64url(bytes))), hex(bytes));
  }
  assert.equal(base64(fromHex("fbff")), "+/8=");
  assert.equal(base64url(fromHex("fbff")), "-_8");
  assert.throws(() => fromBase64("+/8"), /not base64/);
  assert.throws(() => fromBase64("-_8="), /not base64/);
  assert.throws(() => fromBase64url("+/8"), /not base64url/);
  assert.throws(() => fromBase64url("-_8="), /not base64url/);
  // A length of 4k + 1 cannot come from any byte string.
  assert.throws(() => fromBase64url("abcde"), /not base64url/);
});

test("ids are base64url of 8 and 16 random bytes", () => {
  assert.match(newWrapId(), /^[A-Za-z0-9_-]{11}$/);
  assert.match(newDeviceId(), /^[A-Za-z0-9_-]{22}$/);
  assert.equal(newAccountKey().length, 32);
});

// ---------------------------------------------------------------------------------------
// The push envelope

test("a url envelope round-trips and matches the vector", async () => {
  const { metaKey } = await accountSubkeys(inputs.accountKey);
  const enc = await sealPush(metaKey, inputs.uid, inputs.pushId, utf8(inputs.pushPlaintext), inputs.pushNonce);
  assert.deepEqual(enc, vectors.push.enc);
  assert.equal(fromBase64(enc.ct).length, utf8(inputs.pushPlaintext).length + 16);
  assert.equal(hex(await openPushBytes(metaKey, inputs.uid, inputs.pushId, enc)), vectors.push.plaintextUtf8);
  assert.deepEqual(await openPush(metaKey, inputs.uid, inputs.pushId, enc), JSON.parse(inputs.pushPlaintext));
});

test("an envelope built from an object round-trips, and a file envelope carries fk and np", async () => {
  const { metaKey } = await accountSubkeys(newAccountKey());
  const plain = { name: "Report (final) v2.pdf", mime: "application/pdf", size: 12345, ext: "pdf", fk: vectors.file.fkBase64, np: vectors.file.npBase64 };
  const enc = await sealPush(metaKey, "u", "p", plain);
  assert.equal(enc.v, 1);
  assert.deepEqual(await openPush(metaKey, "u", "p", enc), plain);
});

test("an envelope moved to another document or user fails to open", async () => {
  const { metaKey } = await accountSubkeys(inputs.accountKey);
  const enc = vectors.push.enc;
  await assert.rejects(openPush(metaKey, inputs.uid, "another-push", enc), /decryption failed/);
  await assert.rejects(openPush(metaKey, "another-user", inputs.pushId, enc), /decryption failed/);
  await assert.rejects(openPush(metaKey, inputs.uid, inputs.pushId, { ...enc, v: 2 }), /unknown envelope version/);
});

// ---------------------------------------------------------------------------------------
// The blind index

test("the token generator matches the spec's example", () => {
  assert.deepEqual(searchTokens("GitHub Repository"), [
    "g", "gi", "git", "gith", "githu", "github",
    "r", "re", "rep", "repo", "repos", "reposi", "reposit", "reposito", "repositor", "repository",
  ]);
  assert.deepEqual(searchTokens("  a-b  "), ["a", "b"]);
  assert.deepEqual(searchTokens(""), []);
});

test("the token generator keeps accents, composes them, and counts code points", () => {
  // A decomposed "e" + U+0301 composes to U+00E9 and stays inside the word.
  assert.deepEqual(searchTokens("Cafe\u0301"), ["c", "ca", "caf", "caf\u00e9"]);
  assert.deepEqual(searchTokens("Caf\u00e9"), searchTokens("Cafe\u0301"));
  // A mark with no precomposed form stays in the word too, as it does on iOS.
  assert.deepEqual(searchTokens("\u0939\u093f"), ["\u0939", "\u0939\u093f"]);
  // An astral letter is one code point, never half a surrogate pair.
  assert.deepEqual(searchTokens("\u{20000}x"), ["\u{20000}", "\u{20000}x"]);
});

test("blind tokens are 16 base64url characters of the HMAC and match the vector", async () => {
  const { searchKey } = await accountSubkeys(inputs.accountKey);
  const tokens = searchTokens(inputs.searchText);
  assert.deepEqual(tokens, vectors.search.tokens);
  assert.deepEqual(await blindIndex(searchKey, tokens), vectors.search.blind);
  for (const t of vectors.search.blind) assert.match(t, /^[A-Za-z0-9_-]{16}$/);
  // A search for a lowercased term is the same HMAC, so it hits the same token.
  assert.equal(await blindToken(searchKey, "git"), vectors.search.blind[2]);
  // A different key, a different index: the server cannot relate two accounts' tokens.
  const other = await accountSubkeys(newAccountKey());
  assert.notEqual(await blindToken(other.searchKey, "git"), vectors.search.blind[2]);
});

// ---------------------------------------------------------------------------------------
// Files

const sealedSize = CHUNK_SIZE + 16;

test("the 3 MiB + 1 file matches the vector and round-trips", async () => {
  const plain = filePattern(inputs.fileLength);
  assert.equal(hex(await sha256(plain)), vectors.file.plaintextSha256);
  const file = await encryptFile(inputs.fk, inputs.np, plain);
  assert.equal(file.length, vectors.file.encryptedLength);
  assert.equal(file.length, 12 + 3 * sealedSize + 1 + 16);
  assert.equal(hex(file.subarray(0, 12)), vectors.file.header);
  assert.equal(hex(file.subarray(0, 4)), hex(utf8("PTE1")));
  assert.equal(hex(await sha256(file)), vectors.file.encryptedSha256);
  const back = await decryptFile(inputs.fk, file, inputs.np);
  assert.equal(hex(await sha256(back)), vectors.file.plaintextSha256);
});

test("the tampered copy has the vector's hash and fails to decrypt", async () => {
  const file = await encryptFile(inputs.fk, inputs.np, filePattern(inputs.fileLength));
  const tampered = Uint8Array.from(file);
  tampered[TAMPER_OFFSET] ^= 0x01;
  assert.equal(hex(await sha256(tampered)), vectors.file.tamperedSha256);
  await assert.rejects(decryptFile(inputs.fk, tampered, inputs.np), /decryption failed/);
});

test("a reordered chunk has the vector's hash and fails to decrypt", async () => {
  const file = await encryptFile(inputs.fk, inputs.np, filePattern(inputs.fileLength));
  const reordered = Uint8Array.from(file);
  reordered.set(file.subarray(12, 12 + sealedSize), 12 + sealedSize);
  reordered.set(file.subarray(12 + sealedSize, 12 + 2 * sealedSize), 12);
  assert.equal(hex(await sha256(reordered)), vectors.file.reorderedSha256);
  await assert.rejects(decryptFile(inputs.fk, reordered, inputs.np), /decryption failed/);
});

test("a truncated, extended or shortened-by-a-chunk file fails to decrypt", async () => {
  const file = await encryptFile(inputs.fk, inputs.np, filePattern(inputs.fileLength));
  // Cut at a chunk boundary: the last chunk left was sealed as non-final.
  await assert.rejects(decryptFile(inputs.fk, file.subarray(0, 12 + 2 * sealedSize), inputs.np), /decryption failed/);
  // Cut inside a chunk.
  await assert.rejects(decryptFile(inputs.fk, file.subarray(0, file.length - 1), inputs.np), /decryption failed/);
  // A whole sealed chunk appended: the old final chunk is now read as non-final.
  const extended = new Uint8Array(file.length + sealedSize);
  extended.set(file);
  extended.set(file.subarray(12, 12 + sealedSize), file.length);
  await assert.rejects(decryptFile(inputs.fk, extended, inputs.np), /bytes|decryption failed/);
  // Chunk 1 removed.
  const dropped = new Uint8Array(file.length - sealedSize);
  dropped.set(file.subarray(0, 12 + sealedSize));
  dropped.set(file.subarray(12 + 2 * sealedSize), 12 + sealedSize);
  await assert.rejects(decryptFile(inputs.fk, dropped, inputs.np), /decryption failed/);
  // Too short to hold a header and a tag.
  await assert.rejects(decryptFile(inputs.fk, file.subarray(0, 20), inputs.np), /too short/);
  await assert.rejects(decryptFile(inputs.fk, new Uint8Array(0), inputs.np), /too short/);
});

test("the wrong key, a wrong prefix or a wrong magic fails to decrypt", async () => {
  const file = await encryptFile(inputs.fk, inputs.np, filePattern(inputs.fileLength));
  await assert.rejects(decryptFile(inputs.fk, file, newFilePrefix()), /prefix does not match/);
  // A header rewritten with another prefix, presented as that prefix's push: the check
  // passes and the nonces no longer match the tags.
  const other = newFilePrefix();
  const swapped = Uint8Array.from(file);
  swapped.set(other, 4);
  await assert.rejects(decryptFile(inputs.fk, swapped, other), /decryption failed/);
  await assert.rejects(decryptFile(newFileKey(), file, inputs.np), /decryption failed/);
  await assert.rejects(decryptFile(inputs.fk, file), /np is required/);
  await assert.rejects(decryptFile(inputs.fk, file, new Uint8Array(7)), /np is required/);
  const wrongMagic = Uint8Array.from(file);
  wrongMagic[0] = 0x51;
  await assert.rejects(decryptFile(inputs.fk, wrongMagic, inputs.np), /not an encrypted file/);
});

test("the empty file is the header and one empty final chunk, and matches the vector", async () => {
  const empty = await encryptFile(inputs.fk, inputs.np, new Uint8Array(0));
  assert.equal(empty.length, 28);
  assert.equal(hex(empty), vectors.emptyFile.encrypted);
  assert.equal(hex(await sha256(empty)), vectors.emptyFile.encryptedSha256);
  assert.equal((await decryptFile(inputs.fk, empty, inputs.np)).length, 0);
  // Without the final flag it would be a non-final chunk of the wrong size.
  const sealed = await sealChunk(inputs.fk, inputs.np, 0, new Uint8Array(0), true);
  assert.equal(hex(sealed), hex(empty.subarray(12)));
  await assert.rejects(openChunk(inputs.fk, inputs.np, 0, sealed, false), /bytes/);
});

test("files of 1 byte, exactly 1 MiB, 1 MiB + 1 and exactly 2 MiB round-trip with the expected chunk counts", async () => {
  const fk = newFileKey();
  const np = newFilePrefix();
  for (const [length, chunks] of [[1, 1], [CHUNK_SIZE, 1], [CHUNK_SIZE + 1, 2], [2 * CHUNK_SIZE, 2]]) {
    const plain = filePattern(length);
    const file = await encryptFile(fk, np, plain);
    assert.equal(file.length, 12 + length + 16 * chunks, `${length} bytes`);
    assert.equal(hex(await decryptFile(fk, file, np)), hex(plain), `${length} bytes`);
  }
});

test("every chunk but the last must be exactly 1 MiB", async () => {
  await assert.rejects(sealChunk(inputs.fk, inputs.np, 0, new Uint8Array(10), false), /10 bytes/);
  await assert.rejects(sealChunk(inputs.fk, inputs.np, 0, new Uint8Array(CHUNK_SIZE + 1), true), /bytes/);
  const ok = await sealChunk(inputs.fk, inputs.np, 3, new Uint8Array(10), true);
  assert.equal(hex(await openChunk(inputs.fk, inputs.np, 3, ok, true)), hex(new Uint8Array(10)));
  await assert.rejects(openChunk(inputs.fk, inputs.np, 2, ok, true), /decryption failed/);
});

// ---------------------------------------------------------------------------------------
// The file on disk

test("vectors.json is what vectors.mjs generates", async () => {
  assert.equal(readFileSync(VECTORS_PATH, "utf8"), render(await generate()));
});

test("vectors.json is ASCII, so the decomposed password is visible as an escape", () => {
  const text = readFileSync(VECTORS_PATH, "utf8");
  assert.match(text, /^[\x00-\x7f]*$/);
  assert.match(text, /Cafe\\u0301 latte/);
});
