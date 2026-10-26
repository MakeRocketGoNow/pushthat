// What the web app's account key writes decide (src/services/keyDecisions.ts): what a
// password finds in the stored keys, and which wraps each write keeps, against the
// rules' four. Run with the vector test by `npm run test:keys`; not a `*.test.mjs`, which
// `npm run test:rules` would run under the emulators it does not need.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  KeysChangedError,
  openWithPassword,
  sameKeys,
  withNewKeys,
  withNewRecoveryWrap,
  withRewrappedPassword,
} from '../src/services/keyDecisions.ts';

const vectors = JSON.parse(readFileSync(new URL('../../../packages/push-test/vectors.json', import.meta.url), 'utf8'));
const { account, keys } = vectors;
const fromHex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const masterKey = fromHex(keys.masterKey);

// The vectors' two wraps, under made-up ids. The recovery wrap is relabelled as a password
// wrap where a test needs a password wrap this password does not open.
const passwordWrap = { by: 'password', n: account.passwordWrap.n, ct: account.passwordWrap.ct };
const recoveryWrap = { by: 'recovery', n: account.recovery.wrap.n, ct: account.recovery.wrap.ct };
const stalePasswordWrap = { ...recoveryWrap, by: 'password' };
const e2ee = (wraps, rest = {}) => ({ v: 1, kdf: vectors.kdf, keyVersion: 1, wraps, ...rest });

describe('what a password finds', () => {
  test('no keys at all', async () => {
    assert.deepEqual(await openWithPassword(undefined, account.uid, masterKey), {
      kind: 'needsNewKeys',
      e2ee: undefined,
    });
  });

  test('a password wrap it opens', async () => {
    const outcome = await openWithPassword(e2ee({ p1: passwordWrap, r1: recoveryWrap }), account.uid, masterKey);
    assert.equal(outcome.kind, 'opened');
    assert.equal(outcome.wrapId, 'p1');
    assert.equal(hex(outcome.accountKey), account.accountKey);
  });

  test('a password wrap it does not open, beside a recovery wrap', async () => {
    const outcome = await openWithPassword(e2ee({ p1: stalePasswordWrap, r1: recoveryWrap }), account.uid, masterKey);
    assert.equal(outcome.kind, 'needsRecovery');
  });

  test('a password wrap it does not open, and no recovery wrap', async () => {
    const outcome = await openWithPassword(e2ee({ p1: stalePasswordWrap }), account.uid, masterKey);
    assert.equal(outcome.kind, 'needsNewKeys');
  });

  test('its own wrap, for another account', async () => {
    const outcome = await openWithPassword(e2ee({ p1: passwordWrap }), 'someone-else', masterKey);
    assert.equal(outcome.kind, 'needsNewKeys');
  });
});

describe('whether the keys moved since they were read', () => {
  const read = e2ee({ p1: passwordWrap, r1: recoveryWrap });

  test('the same keys', () => assert.equal(sameKeys(e2ee({ r1: recoveryWrap, p1: passwordWrap }), read), true));
  test('none then, none now', () => assert.equal(sameKeys(undefined, undefined), true));
  test('none then, some now', () => assert.equal(sameKeys(read, undefined), false));
  test('a new version', () => assert.equal(sameKeys({ ...read, keyVersion: 2 }, read), false));
  test('a wrap added', () => assert.equal(sameKeys(e2ee({ ...read.wraps, p2: passwordWrap }), read), false));
});

describe('new keys', () => {
  const wraps = { p9: passwordWrap, r9: recoveryWrap };

  test('start at version 1', () => {
    assert.deepEqual(withNewKeys(undefined, { e2ee: undefined }, wraps), e2ee(wraps));
  });

  test('go one version past the stored keys, keeping what else is stored', () => {
    const stored = e2ee({ p1: stalePasswordWrap }, { keyVersion: 3, migratedAt: 'a timestamp' });
    assert.deepEqual(
      withNewKeys(stored, { e2ee: stored }, wraps),
      e2ee(wraps, { keyVersion: 4, migratedAt: 'a timestamp' })
    );
  });

  test('stop when another device made keys after the read', () => {
    assert.throws(() => withNewKeys(e2ee({ p1: passwordWrap }), { e2ee: undefined }, wraps), KeysChangedError);
  });

  test('go past them for the reset page, which decides from nothing', () => {
    assert.equal(withNewKeys(e2ee({ p1: passwordWrap }), undefined, wraps).keyVersion, 2);
  });
});

describe('a rewrap with the recovery key', () => {
  const stored = e2ee({ p1: stalePasswordWrap, r1: recoveryWrap, r2: recoveryWrap, r3: recoveryWrap });

  test('keeps the new password wrap and the recovery wrap that opened, inside four', () => {
    const written = withRewrappedPassword(stored, stored, 'r2', 'p9', passwordWrap);
    assert.deepEqual(Object.keys(written.wraps).sort(), ['p9', 'r2']);
  });

  test('keeps at most three recovery wraps when the one that opened has gone', () => {
    const now = e2ee({ p1: stalePasswordWrap, r1: recoveryWrap, r3: recoveryWrap, r4: recoveryWrap, r5: recoveryWrap });
    const written = withRewrappedPassword(now, stored, 'r2', 'p9', passwordWrap);
    assert.equal(Object.keys(written.wraps).length, 4);
    assert.equal(written.wraps.p9, passwordWrap);
  });

  test('stops when the account key was replaced meanwhile', () => {
    assert.throws(
      () => withRewrappedPassword({ ...stored, keyVersion: 2 }, stored, 'r2', 'p9', passwordWrap),
      KeysChangedError
    );
  });
});

describe('a new recovery key', () => {
  test('replaces every recovery wrap and keeps the password wraps', () => {
    const stored = e2ee({ p1: passwordWrap, r1: recoveryWrap, r2: recoveryWrap, r3: recoveryWrap });
    const written = withNewRecoveryWrap(stored, 1, 'r9', recoveryWrap);
    assert.deepEqual(Object.keys(written.wraps).sort(), ['p1', 'r9']);
  });

  test('stops when the account key was replaced meanwhile', () => {
    assert.throws(() => withNewRecoveryWrap(e2ee({}, { keyVersion: 2 }), 1, 'r9', recoveryWrap), KeysChangedError);
  });
});
