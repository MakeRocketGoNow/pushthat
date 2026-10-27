// The web app's copy of the encryption keys (src/services/e2ee.ts) against the test
// vectors the reference produced (packages/push-test/vectors.json): `npm run
// test:vectors`. Node runs the TypeScript as it is, by stripping its types, so nothing is
// built first. Not a `*.test.mjs`, which `npm run test:rules` would pick up and run under
// the emulators it does not need.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  KDF,
  base64,
  decodeRecoveryKey,
  deriveKeys,
  encodeRecoveryKey,
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
