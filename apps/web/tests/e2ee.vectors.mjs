// The web app's copy of the encryption keys (src/services/e2ee.ts) against the test
// vectors the reference produced (packages/push-test/vectors.json): `npm run
// test:keys`. Node runs the TypeScript as it is, by stripping its types, so nothing is
// built first. Not a `*.test.mjs`, which `npm run test:rules` would pick up and run under
// the emulators it does not need.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  CHUNK_SIZE,
  KDF,
  MAX_SEARCH_TOKENS,
  TAG_LENGTH,
  accountBaseKey,
  accountSubkeyKeys,
  accountSubkeys,
  aesGcmSeal,
  base64,
  blindIndex,
  chunkLayout,
  decodeRecoveryKey,
  decryptBlob,
  deriveKeys,
  encodeRecoveryKey,
  encryptBlob,
  hmacSha256,
  newDeviceId,
  openPush,
  openPushBytes,
  recoveryWrappingKey,
  sealPush,
  searchTokens,
  searchWord,
  unwrapAccountKey,
  wrapAccountKey,
} from '../src/services/e2ee.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../packages/push-test/vectors.json', import.meta.url), 'utf8'));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));

describe('the keys from the password and the email', () => {
  const { keys } = vectors;

  test('names the KDF the vectors were made with', () => assert.equal(KDF, vectors.kdf));
  test('match the vector byte for byte', async () => {
    const derived = await deriveKeys(keys.email, keys.password);
    assert.equal(hex(derived.salt), keys.salt);
    assert.equal(hex(derived.stretched), keys.stretched);
    assert.equal(hex(derived.authKey), keys.authKey);
    assert.equal(hex(derived.masterKey), keys.masterKey);
    assert.equal(derived.firebasePassword, keys.firebasePassword);
  });
});

describe('the account key and its subkeys', () => {
  const { account, push } = vectors;
  const accountKey = fromHex(account.accountKey);

  test('match the vector byte for byte', async () => {
    const { metaKey, searchKey } = await accountSubkeys(accountKey);
    assert.equal(hex(metaKey), account.metaKey);
    assert.equal(hex(searchKey), account.searchKey);
  });

  // What the app stores is the non-extractable base key, and the subkeys come from it by
  // WebCrypto's HKDF; they cannot be read to compare, so compare what they do instead.
  test('the stored form gives the same subkeys', async () => {
    const { metaKey, searchKey } = await accountSubkeyKeys(await accountBaseKey(accountKey));
    const raw = await accountSubkeys(accountKey);
    assert.equal(metaKey.extractable, false);
    assert.equal(searchKey.extractable, false);

    const message = new TextEncoder().encode('a message');
    const signed = new Uint8Array(await crypto.subtle.sign('HMAC', searchKey, message));
    assert.equal(hex(signed), hex(await hmacSha256(raw.searchKey, message)));

    const nonce = fromHex(push.nonce);
    const aad = fromHex(push.aad);
    const params = { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 };
    const sealed = new Uint8Array(await crypto.subtle.encrypt(params, metaKey, message));
    assert.equal(hex(sealed), hex(await aesGcmSeal(raw.metaKey, nonce, message, aad)));
  });

  test('a device id is 16 bytes in unpadded base64url', () => {
    assert.match(newDeviceId(), /^[A-Za-z0-9_-]{22}$/);
  });
});

describe('the account key wraps', () => {
  const { account, keys } = vectors;
  const accountKey = fromHex(account.accountKey);

  test('the password wrap', async () => {
    const wrap = await wrapAccountKey(
      fromHex(keys.masterKey),
      accountKey,
      account.uid,
      'password',
      fromHex(account.passwordWrap.nonce)
    );
    assert.deepEqual(wrap, { by: 'password', n: account.passwordWrap.n, ct: account.passwordWrap.ct });
    assert.equal(hex(await unwrapAccountKey(fromHex(keys.masterKey), wrap, account.uid)), account.accountKey);
  });

  test('the recovery key, its display and its wrap', async () => {
    const { recovery } = account;
    const bytes = fromHex(recovery.bytes);
    assert.equal(encodeRecoveryKey(bytes), recovery.display);
    assert.equal(hex(decodeRecoveryKey(recovery.display)), recovery.bytes);
    const wrappingKey = await recoveryWrappingKey(bytes);
    assert.equal(hex(wrappingKey), recovery.wrappingKey);
    const wrap = await wrapAccountKey(wrappingKey, accountKey, account.uid, 'recovery', fromHex(recovery.wrap.nonce));
    assert.deepEqual(wrap, { by: 'recovery', n: recovery.wrap.n, ct: recovery.wrap.ct });
    assert.equal(hex(await unwrapAccountKey(wrappingKey, wrap, account.uid)), account.accountKey);
  });

  test('a recovery key read back as someone would type it', () => {
    const typed = account.recovery.display.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l').replace(/0/g, 'o');
    assert.equal(hex(decodeRecoveryKey(typed)), account.recovery.bytes);
  });

  test('a wrap opened for another account fails', async () => {
    await assert.rejects(unwrapAccountKey(fromHex(keys.masterKey), account.passwordWrap, 'someone-else'));
  });

  test('a wrap with a nonce that is not base64 fails before it is opened', async () => {
    const wrap = { ...account.passwordWrap, n: base64(new Uint8Array(12)).replace('A', '*') };
    await assert.rejects(unwrapAccountKey(fromHex(keys.masterKey), wrap, account.uid), /not base64/);
  });
});

describe('the push envelope (vector 3)', () => {
  const { account, push } = vectors;
  const metaKey = fromHex(account.metaKey);

  test('seals the vector plaintext byte for byte and opens it again', async () => {
    const enc = await sealPush(metaKey, push.userId, push.pushId, fromHex(push.plaintextUtf8), fromHex(push.nonce));
    assert.deepEqual(enc, push.enc);
    assert.equal(hex(await openPushBytes(metaKey, push.userId, push.pushId, enc)), push.plaintextUtf8);
    assert.deepEqual(await openPush(metaKey, push.userId, push.pushId, enc), JSON.parse(push.plaintext));
  });

  // What the app holds is the stored key's metaKey, which cannot be read; it must open the
  // same ciphertext.
  test('opens with the stored, non-extractable metaKey', async () => {
    const { metaKey: stored } = await accountSubkeyKeys(await accountBaseKey(fromHex(account.accountKey)));
    assert.equal(hex(await openPushBytes(stored, push.userId, push.pushId, push.enc)), push.plaintextUtf8);
  });

  test('does not open under another push id or user', async () => {
    await assert.rejects(openPushBytes(metaKey, push.userId, 'another-push', push.enc));
    await assert.rejects(openPushBytes(metaKey, 'another-user', push.pushId, push.enc));
  });
});

describe('the blind index (vector 4)', () => {
  const { account, search } = vectors;

  test('the tokens and their blind form match the vector, in order', async () => {
    const tokens = searchTokens(search.text);
    assert.deepEqual(tokens, search.tokens);
    assert.deepEqual(await blindIndex(fromHex(account.searchKey), tokens), search.blind);
    const { searchKey } = await accountSubkeyKeys(await accountBaseKey(fromHex(account.accountKey)));
    assert.deepEqual(await blindIndex(searchKey, tokens), search.blind);
  });

  test('composes accents, splits on punctuation and underscores, keeps digits and scripts', () => {
    assert.deepEqual(searchTokens('Cafe\u0301'), searchTokens('Caf\u00e9'));
    assert.deepEqual(searchTokens('a_b.c-d'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(searchTokens('v2 2026'), ['v', 'v2', '2', '20', '202', '2026']);
    assert.deepEqual(searchTokens('\u041c\u0438\u0440'), ['\u043c', '\u043c\u0438', '\u043c\u0438\u0440']);
    assert.deepEqual(searchTokens('\u{20000}x'), ['\u{20000}', '\u{20000}x']);
    assert.equal(searchTokens('a'.repeat(3001)).length, MAX_SEARCH_TOKENS);
  });

  test('a search looks up the first word of the term', () => {
    assert.equal(searchWord('  GitHub repo'), 'github');
    assert.equal(searchWord('...'), undefined);
  });
});

describe('files (vectors 5 and 6)', () => {
  const { file, emptyFile } = vectors;
  const fk = fromHex(file.fk);
  const np = fromHex(file.np);
  const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const blobBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());

  const plaintext = Uint8Array.from({ length: file.length }, (_, i) => i % 251);
  let encrypted;

  test('the 3 MiB + 1 pattern encrypts to the vector', async () => {
    assert.equal(sha(plaintext), file.plaintextSha256);
    encrypted = await blobBytes(await encryptBlob(fk, np, new Blob([plaintext])));
    assert.equal(encrypted.length, file.encryptedLength);
    assert.equal(hex(encrypted.subarray(0, 12)), file.header);
    assert.equal(sha(encrypted), file.encryptedSha256);
    const decrypted = await blobBytes(await decryptBlob(fk, np, new Blob([encrypted])));
    assert.equal(sha(decrypted), file.plaintextSha256);
  });

  test('a tampered copy fails', async () => {
    const tampered = encrypted.slice();
    tampered[file.tamperOffset] ^= 0x01;
    assert.equal(sha(tampered), file.tamperedSha256);
    await assert.rejects(decryptBlob(fk, np, new Blob([tampered])));
  });

  test('a copy with chunks 0 and 1 swapped fails', async () => {
    const sealed = CHUNK_SIZE + TAG_LENGTH;
    const reordered = encrypted.slice();
    reordered.set(encrypted.subarray(12 + sealed, 12 + 2 * sealed), 12);
    reordered.set(encrypted.subarray(12, 12 + sealed), 12 + sealed);
    assert.equal(sha(reordered), file.reorderedSha256);
    await assert.rejects(decryptBlob(fk, np, new Blob([reordered])));
  });

  test("another push's prefix fails", async () => {
    await assert.rejects(decryptBlob(fk, new Uint8Array(8), new Blob([encrypted])), /prefix/);
  });

  test('the empty file is its 28 bytes, and opens to nothing', async () => {
    const empty = await blobBytes(await encryptBlob(fromHex(emptyFile.fk), fromHex(emptyFile.np), new Blob([])));
    assert.equal(hex(empty), emptyFile.encrypted);
    const opened = await decryptBlob(fromHex(emptyFile.fk), fromHex(emptyFile.np), new Blob([empty]));
    assert.equal(opened.size, 0);
  });

  test('a file of exactly 1 MiB is one final chunk, and a bare tag after a full chunk is refused', async () => {
    const oneMiB = await blobBytes(await encryptBlob(fk, np, new Blob([new Uint8Array(CHUNK_SIZE)])));
    assert.equal(oneMiB.length, 12 + CHUNK_SIZE + TAG_LENGTH);
    assert.equal(chunkLayout(oneMiB.length).length, 1);
    assert.throws(() => chunkLayout(12 + CHUNK_SIZE + TAG_LENGTH + TAG_LENGTH), /bad last chunk/);
    assert.throws(() => chunkLayout(12 + CHUNK_SIZE + TAG_LENGTH + 5), /bad last chunk/);
  });
});
