// The web app's copy of the encryption keys (src/services/e2ee.ts) against the test
// vectors the reference produced (packages/push-test/vectors.json): `npm run
// test:keys`. Node runs the TypeScript as it is, by stripping its types, so nothing is
// built first. Not a `*.test.mjs`, which `npm run test:rules` would pick up and run under
// the emulators it does not need.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  KDF,
  accountBaseKey,
  accountSubkeyKeys,
  accountSubkeys,
  aesGcmSeal,
  base64,
  decodeRecoveryKey,
  deriveKeys,
  encodeRecoveryKey,
  hmacSha256,
  newDeviceId,
  recoveryWrappingKey,
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
