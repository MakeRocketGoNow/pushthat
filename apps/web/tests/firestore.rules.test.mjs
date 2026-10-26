// The Firestore rules against the emulator: `npm run test:rules`, which needs the Firebase CLI
// and Java. The user document is the one clients must not be able to grant themselves Pro
// through, so every client's real write is here, next to the writes the rules must refuse.
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  Timestamp,
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

let env;
const now = new Date();
const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
// Anchored on the 1st, so the current period is always this calendar month.
const anchoredOnFirst = Timestamp.fromDate(new Date(Date.UTC(2025, 0, 1)));
const farFuture = Timestamp.fromDate(new Date(Date.UTC(2099, 0, 1)));

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-pushthat',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const alice = () => env.authenticatedContext('alice').firestore();
const aliceDoc = () => doc(alice(), 'users/alice');
const seed = (data) => env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'users/alice'), data));

// A push as the web app writes it (apps/web/src/pages/Push.tsx); the other clients'
// shapes are in 'the shape of a push' below.
const webPush = (fields = {}) => ({
  url: 'https://example.com/a',
  userId: 'alice',
  createdAt: serverTimestamp(),
  title: 'A page',
  type: 'url',
  deviceName: 'Mozilla/5.0',
  searchTokens: ['a', 'p', 'pa', 'pag', 'page'],
  ...fields,
});
const tokens = (count) => Array.from({ length: count }, (_, i) => `token-${i}`);

// An encrypted push (docs/e2ee.md): what the server needs in plaintext, and enc. The
// values are the right lengths and obviously made up: a 12-byte nonce in base64, a
// deviceId and an objectId of 16 bytes in base64url, blind tokens of 16 characters.
const envelope = { v: 1, n: 'AAECAwQFBgcICQoL', ct: 'bm90IHJlYWxseSBjaXBoZXJ0ZXh0' };
const encryptedPush = (fields = {}) => ({
  userId: 'alice',
  type: 'url',
  createdAt: serverTimestamp(),
  deviceId: 'ZGV2aWNlLWlkLTAwMDAwMA',
  keyVersion: 1,
  enc: envelope,
  searchTokens: ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'],
  ...fields,
});
const objectPath = 'uploads/alice/b2JqZWN0LWlkLTAwMDAwMA';
const encryptedFile = (fields = {}) => encryptedPush({ type: 'file', objectPath, ...fields });

describe('creating the user document, as each client does', () => {
  test('Android sign-up', () => assertSucceeds(setDoc(aliceDoc(), { email: 'a@x.com', createdAt: serverTimestamp() })));
  test('Android first token', () =>
    assertSucceeds(setDoc(aliceDoc(), { fcmTokens: ['t1'], createdAt: serverTimestamp() })));
  test('iOS and macOS sign-up', () =>
    assertSucceeds(setDoc(aliceDoc(), { email: 'a@x.com', createdAt: serverTimestamp(), fcmTokens: [] })));
  test('web sign-up', () => assertSucceeds(setDoc(aliceDoc(), { email: 'a@x.com', createdAt: new Date() })));
  test('Chrome extension first token', () =>
    assertSucceeds(setDoc(aliceDoc(), { fcmTokens: ['t1'], createdAt: serverTimestamp() })));
  test('an older Chrome extension, without createdAt', () => assertSucceeds(setDoc(aliceDoc(), { fcmTokens: ['t1'] })));

  test('with a subscription', () =>
    assertFails(setDoc(aliceDoc(), { email: 'a@x.com', subscription: { expiresAt: farFuture } })));
  test('with usageRecords', () => assertFails(setDoc(aliceDoc(), { email: 'a@x.com', usageRecords: {} })));
  test('with a billing id', () =>
    assertFails(setDoc(aliceDoc(), { email: 'a@x.com', billing: { customerId: 'cus_1' } })));
  test('with a createdAt that is not a timestamp', () => assertFails(setDoc(aliceDoc(), { createdAt: 'yesterday' })));
  test('with a hundred tokens', () => assertSucceeds(setDoc(aliceDoc(), { fcmTokens: tokens(100) })));
  test('with more tokens than that', () => assertFails(setDoc(aliceDoc(), { fcmTokens: tokens(101) })));
  test('with a token the size of the document', () =>
    assertFails(setDoc(aliceDoc(), { fcmTokens: ['x'.repeat(60_000)] })));
  test('with an email that is not one', () => assertFails(setDoc(aliceDoc(), { email: 'a'.repeat(321) })));
  test("someone else's", () => assertFails(setDoc(doc(alice(), 'users/bob'), { email: 'a@x.com' })));
  test('signed out', () =>
    assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), 'users/alice'), { email: 'a@x.com' })));
});

describe('changing an existing user document', () => {
  beforeEach(() =>
    seed({
      email: 'a@x.com',
      createdAt: anchoredOnFirst,
      fcmTokens: ['t1'],
      usageRecords: { [periodKey]: { url: 1000 } },
      periodStart: anchoredOnFirst,
      lastPushWasActiveSubscription: false,
    })
  );

  test('add a device token', () => assertSucceeds(updateDoc(aliceDoc(), { fcmTokens: arrayUnion('t2') })));
  test('grow the token list past a hundred', () =>
    assertFails(updateDoc(aliceDoc(), { fcmTokens: arrayUnion(...tokens(100)) })));
  test('grow the token list to the size of the document', () =>
    assertFails(updateDoc(aliceDoc(), { fcmTokens: arrayUnion('x'.repeat(60_000)) })));
  test('make the token list something else', () => assertFails(updateDoc(aliceDoc(), { fcmTokens: 't2' })));

  test('add a subscription', () => assertFails(updateDoc(aliceDoc(), { subscription: { expiresAt: farFuture } })));
  test('reset usageRecords', () => assertFails(updateDoc(aliceDoc(), { usageRecords: {} })));
  test('move createdAt', () =>
    assertFails(updateDoc(aliceDoc(), { createdAt: Timestamp.fromDate(new Date(Date.UTC(2025, 0, 28))) })));
  test('move periodStart', () => assertFails(updateDoc(aliceDoc(), { periodStart: Timestamp.now() })));
  test('add a billing id', () => assertFails(updateDoc(aliceDoc(), { billing: { customerId: 'cus_1' } })));
  test('change email', () => assertFails(updateDoc(aliceDoc(), { email: 'b@x.com' })));
  test('replace the whole document', () =>
    assertFails(setDoc(aliceDoc(), { email: 'a@x.com', createdAt: serverTimestamp() })));
  test('delete it', () => assertFails(deleteDoc(aliceDoc())));

  test('read your own', () => assertSucceeds(getDoc(aliceDoc())));
  test("read someone else's", () =>
    assertFails(getDoc(doc(env.authenticatedContext('bob').firestore(), 'users/alice'))));
});

// users/{uid}.e2ee (docs/e2ee.md, The user document): the wrapped account key, which a
// client writes at registration, on a password change or reset, and when the push
// migration is done. keyVersion never goes back, and the map is bounded whole, since the
// user document's size is what keeps the trigger's write to it working.
describe('the wrapped keys on the user document', () => {
  const wrap = (by = 'password') => ({ by, n: 'AAAAAAAAAAAAAAAA', ct: 'A'.repeat(64) });
  const e2ee = (fields = {}) => ({
    v: 1,
    kdf: 'pbkdf2-sha256-600000',
    keyVersion: 1,
    wraps: { pwWrapId0001: wrap(), rcWrapId0001: wrap('recovery') },
    ...fields,
  });
  const webUser = { email: 'a@x.com', createdAt: anchoredOnFirst };

  test('a registration that writes them with the document', () =>
    assertSucceeds(setDoc(aliceDoc(), { email: 'a@x.com', createdAt: serverTimestamp(), e2ee: e2ee() })));
  test('the reset page, for an account with no document yet', () =>
    assertSucceeds(setDoc(aliceDoc(), { email: 'a@x.com', createdAt: new Date(), e2ee: e2ee() })));
  test('a registration with keys that are not a map', () =>
    assertFails(setDoc(aliceDoc(), { email: 'a@x.com', e2ee: 'key' })));

  test('added to a web sign-up, which has no device tokens', async () => {
    await seed(webUser);
    await assertSucceeds(updateDoc(aliceDoc(), { e2ee: e2ee() }));
  });
  test('added beside a device token', async () => {
    await seed({ ...webUser, fcmTokens: ['t1'] });
    await assertSucceeds(updateDoc(aliceDoc(), { e2ee: e2ee(), fcmTokens: arrayUnion('t2') }));
  });
  test('a device token added once they are there', async () => {
    await seed({ ...webUser, fcmTokens: ['t1'], e2ee: e2ee() });
    await assertSucceeds(updateDoc(aliceDoc(), { fcmTokens: arrayUnion('t2') }));
  });
  test('a password change caught between its steps, with three wraps', async () => {
    await seed({ ...webUser, e2ee: e2ee() });
    const wraps = { pwWrapId0001: wrap(), pwWrapId0002: wrap(), rcWrapId0001: wrap('recovery') };
    await assertSucceeds(updateDoc(aliceDoc(), { e2ee: e2ee({ wraps }) }));
  });
  test('rewrapped under the same key version', async () => {
    await seed({ ...webUser, e2ee: e2ee() });
    await assertSucceeds(updateDoc(aliceDoc(), { e2ee: e2ee({ wraps: { pwWrapId0002: wrap() } }) }));
  });
  test('a new account key after a reset without the recovery key', async () => {
    await seed({ ...webUser, e2ee: e2ee() });
    await assertSucceeds(updateDoc(aliceDoc(), { e2ee: e2ee({ keyVersion: 2 }) }));
  });
  test('the push migration marked done', async () => {
    await seed({ ...webUser, e2ee: e2ee() });
    await assertSucceeds(updateDoc(aliceDoc(), { 'e2ee.migratedAt': serverTimestamp() }));
  });

  test('an older account key written back', async () => {
    await seed({ ...webUser, e2ee: e2ee({ keyVersion: 2 }) });
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ keyVersion: 1 }) }));
  });
  test('removed', async () => {
    await seed({ ...webUser, e2ee: e2ee() });
    await assertFails(updateDoc(aliceDoc(), { e2ee: deleteField() }));
  });
  test('with a key version that is not a count', async () => {
    await seed(webUser);
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ keyVersion: '1' }) }));
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ keyVersion: 0 }) }));
  });
  test('without a key version', async () => {
    await seed(webUser);
    const { keyVersion: _keyVersion, ...rest } = e2ee();
    await assertFails(updateDoc(aliceDoc(), { e2ee: rest }));
  });
  test('without wraps', async () => {
    await seed(webUser);
    const { wraps: _wraps, ...rest } = e2ee();
    await assertFails(updateDoc(aliceDoc(), { e2ee: rest }));
  });
  test('with a field of its own', async () => {
    await seed(webUser);
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ subscription: { expiresAt: farFuture } }) }));
  });
  test('with five wraps', async () => {
    await seed(webUser);
    const wraps = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`wrapId000${i}`, wrap()]));
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ wraps }) }));
  });
  test('with a wrap by something else', async () => {
    await seed(webUser);
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ wraps: { pwWrapId0001: wrap('email') } }) }));
  });
  test('with a wrap of the wrong size', async () => {
    await seed(webUser);
    await assertFails(
      updateDoc(aliceDoc(), { e2ee: e2ee({ wraps: { pwWrapId0001: { ...wrap(), ct: 'A'.repeat(60_000) } } }) })
    );
  });
  test('with a fourth wrap that is not one, after three that are', async () => {
    await seed(webUser);
    const wraps = { a: wrap(), b: wrap(), c: wrap('recovery'), d: { ...wrap(), padding: 'x'.repeat(60_000) } };
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ wraps }) }));
  });
  // Firestore itself refuses a field name past 1500 bytes, so four of these are the most
  // the bound on the key saves; it is kept so the wraps stay what the spec makes them.
  test('with a wrap id longer than one', async () => {
    await seed(webUser);
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee({ wraps: { ['x'.repeat(1000)]: wrap() } }) }));
  });
  test('beside a subscription', async () => {
    await seed(webUser);
    await assertFails(updateDoc(aliceDoc(), { e2ee: e2ee(), subscription: { expiresAt: farFuture } }));
  });
  test("on someone else's document", async () => {
    await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'users/bob'), webUser));
    await assertFails(updateDoc(doc(alice(), 'users/bob'), { e2ee: e2ee() }));
  });
});

// The tiers' limits: Free 50 URL and 3 file pushes a month, Pro 10,000 and 100
// (docs/billing.md at the repository root).
describe('the push quota', () => {
  const push = (type = 'url') => addDoc(collection(alice(), 'pushes'), webPush({ type }));
  const pro = { startedAt: anchoredOnFirst, expiresAt: farFuture };

  test('free, under the URL limit', async () => {
    await seed({ createdAt: anchoredOnFirst, usageRecords: { [periodKey]: { url: 49 } } });
    await assertSucceeds(push());
  });
  test('free, at the URL limit', async () => {
    await seed({ createdAt: anchoredOnFirst, usageRecords: { [periodKey]: { url: 50 } } });
    await assertFails(push());
  });
  test('free, under the file limit', async () => {
    await seed({ createdAt: anchoredOnFirst, usageRecords: { [periodKey]: { file: 2 } } });
    await assertSucceeds(push('file'));
  });
  test('free, at the file limit', async () => {
    await seed({ createdAt: anchoredOnFirst, usageRecords: { [periodKey]: { file: 3 } } });
    await assertFails(push('file'));
  });
  test('pro, past the free limits', async () => {
    await seed({ createdAt: anchoredOnFirst, subscription: pro, usageRecords: { [periodKey]: { url: 9999, file: 99 } } });
    await assertSucceeds(push());
    await assertSucceeds(push('file'));
  });
  test('pro, at its limits', async () => {
    await seed({ createdAt: anchoredOnFirst, subscription: pro, usageRecords: { [periodKey]: { url: 10000, file: 100 } } });
    await assertFails(push());
    await assertFails(push('file'));
  });
  test('a lapsed subscription is free', async () => {
    const past = Timestamp.fromDate(new Date(Date.UTC(2025, 0, 2)));
    await seed({
      createdAt: anchoredOnFirst,
      subscription: { startedAt: anchoredOnFirst, expiresAt: past },
      usageRecords: { [periodKey]: { url: 50 } },
    });
    await assertFails(push());
  });
  test('a document with no createdAt', async () => {
    await seed({ fcmTokens: ['t1'] });
    await assertSucceeds(push());
  });
  test('no document yet', () => assertSucceeds(push()));

  const encrypted = (type = 'url') =>
    addDoc(collection(alice(), 'pushes'), type === 'file' ? encryptedFile() : encryptedPush());
  test('an encrypted push, under the limits', async () => {
    await seed({ createdAt: anchoredOnFirst, usageRecords: { [periodKey]: { url: 49, file: 2 } } });
    await assertSucceeds(encrypted());
    await assertSucceeds(encrypted('file'));
  });
  test('an encrypted push, at the limits', async () => {
    await seed({ createdAt: anchoredOnFirst, usageRecords: { [periodKey]: { url: 50, file: 3 } } });
    await assertFails(encrypted());
    await assertFails(encrypted('file'));
  });

  // A comp is written by hand as {type, expiresAt} alone (docs/billing.md). Reading its
  // startedAt was an error once usageRecords existed, which refused every push after
  // the first.
  test('a comp, with usage already counted', async () => {
    await seed({
      createdAt: anchoredOnFirst,
      subscription: { type: 'comp', expiresAt: farFuture },
      usageRecords: { [periodKey]: { url: 9999, file: 99 } },
    });
    await assertSucceeds(push());
    await assertSucceeds(push('file'));
  });
  test('a comp, at the Pro limits', async () => {
    await seed({
      createdAt: anchoredOnFirst,
      subscription: { type: 'comp', expiresAt: farFuture },
      usageRecords: { [periodKey]: { url: 10000, file: 100 } },
    });
    await assertFails(push());
    await assertFails(push('file'));
  });
  test('a subscription with no expiresAt is free', async () => {
    await seed({ createdAt: anchoredOnFirst, subscription: { type: 'pro' }, usageRecords: { [periodKey]: { url: 50 } } });
    await assertFails(push());
  });

  // The period's anchor: the subscription's start while it runs, the account's creation
  // otherwise, as usageOf in functions/src/plan.ts has it. Anchored on the last day of a
  // month, the period is the previous calendar month on every day but the last.
  const anchoredOnLastDay = Timestamp.fromDate(new Date(Date.UTC(2025, 0, 31)));
  const previousPeriodKey = (() => {
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  })();
  const lastDayOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const todayIsLastDay = now.getUTCDate() === lastDayOfMonth;

  test('a lapsed subscription counts from the account, not from the subscription', async () => {
    const past = Timestamp.fromDate(new Date(Date.UTC(2025, 0, 2)));
    await seed({
      createdAt: anchoredOnFirst,
      subscription: { startedAt: anchoredOnLastDay, expiresAt: past },
      usageRecords: { [periodKey]: { url: 50 }, [previousPeriodKey]: { url: 0 } },
    });
    // Anchored on the subscription this would read the previous month's 0 and pass.
    await assertFails(push());
  });
  test('a running subscription counts from its start', async () => {
    await seed({
      createdAt: anchoredOnFirst,
      subscription: { startedAt: anchoredOnLastDay, expiresAt: farFuture },
      usageRecords: { [periodKey]: { url: 10000 }, [previousPeriodKey]: { url: 0 } },
    });
    // On the last day of the month both anchors name this month, whose count is full.
    await (todayIsLastDay ? assertFails(push()) : assertSucceeds(push()));
  });
});

// What each client writes is accepted as it is, and nothing beyond it: a field no
// client writes, a value of the wrong type, or one past the bound. The bounds keep the
// push inside what onNewPushCreated sends in the notification.
describe('the shape of a push', () => {
  const create = (data) => addDoc(collection(alice(), 'pushes'), data);
  const storageUrl = 'https://firebasestorage.googleapis.com/v0/b/b/o/uploads%2Falice%2Fa.pdf?alt=media&token=t';

  test('the web app, a URL', () => assertSucceeds(create(webPush())));
  test('the web app, a file', () =>
    assertSucceeds(create(webPush({ url: storageUrl, title: 'a.pdf', type: 'file', ext: 'pdf' }))));
  test('Android, a URL with no extension', () =>
    assertSucceeds(create(webPush({ deviceName: 'Pixel', ext: null }))));
  test('Android, a file', () =>
    assertSucceeds(create(webPush({ url: storageUrl, title: 'a.pdf', type: 'file', deviceName: 'Pixel', ext: 'pdf' }))));
  test('Android, a retried push, which has no search tokens', () =>
    assertSucceeds(create({ url: 'https://example.com/a', userId: 'alice', createdAt: serverTimestamp(), title: 'A', type: 'url', deviceName: 'Pixel' })));
  test('iOS, a queued push with the time it was queued', () =>
    assertSucceeds(create(webPush({ createdAt: new Date(Date.now() - 86_400_000), deviceName: 'iPhone' }))));

  test('with a field no client writes', () => assertFails(create(webPush({ pinned: true }))));
  test('with an expiresAt', () => assertFails(create(webPush({ type: 'file', expiresAt: farFuture }))));
  test('with a type of its own', () => assertFails(create(webPush({ type: 'note' }))));
  test('without createdAt', async () => {
    const { createdAt: _createdAt, ...rest } = webPush();
    await assertFails(create(rest));
  });
  test('with a createdAt that is not a timestamp', () => assertFails(create(webPush({ createdAt: 'now' }))));
  test('without a URL', async () => {
    const { url: _url, ...rest } = webPush();
    await assertFails(create(rest));
  });
  test('with a URL that is not a string', () => assertFails(create(webPush({ url: 42 }))));
  test('with a URL past the bound', () => assertFails(create(webPush({ url: `https://example.com/${'a'.repeat(1500)}` }))));
  test('with a URL at the bound', () => assertSucceeds(create(webPush({ url: `https://example.com/${'a'.repeat(1480)}` }))));
  test('without a title', async () => {
    const { title: _title, ...rest } = webPush();
    await assertFails(create(rest));
  });
  test('with a title past the bound', () => assertFails(create(webPush({ title: 'a'.repeat(1501) }))));
  test('with a device name past the bound', () => assertFails(create(webPush({ deviceName: 'a'.repeat(513) }))));
  test('with a device name that is not a string', () => assertFails(create(webPush({ deviceName: ['Pixel'] }))));
  test('with search tokens that are not a list', () => assertFails(create(webPush({ searchTokens: 'a' }))));
  test('with more search tokens than the title and URL could give', () =>
    assertFails(create(webPush({ searchTokens: Array.from({ length: 3001 }, (_, i) => `t${i}`) }))));
  test('with an extension past the bound', () => assertFails(create(webPush({ ext: 'a'.repeat(65) }))));
  test('with an extension that is not a string', () => assertFails(create(webPush({ ext: 7 }))));
});

// The encrypted shape (docs/e2ee.md, Rules) is accepted beside the plaintext one until
// phase 5 of that plan. Nothing a downgraded client could leak in plaintext sits beside
// enc, and a file push names an object its owner uploaded, since onPushRecordDeleted
// deletes whatever it names.
describe('the shape of an encrypted push', () => {
  const create = (data) => addDoc(collection(alice(), 'pushes'), data);
  const without = (key, data) => {
    const { [key]: _omitted, ...rest } = data;
    return rest;
  };

  test('a URL', () => assertSucceeds(create(encryptedPush())));
  test('a file', () => assertSucceeds(create(encryptedFile())));
  test('a retried push, with no search tokens', () => assertSucceeds(create(without('searchTokens', encryptedPush()))));
  test('a queued push with the time it was queued', () =>
    assertSucceeds(create(encryptedPush({ createdAt: new Date(Date.now() - 86_400_000) }))));
  test('under a later key version', () => assertSucceeds(create(encryptedPush({ keyVersion: 2 }))));

  for (const [key, value] of [
    ['url', 'https://example.com/a'],
    ['title', 'A page'],
    ['deviceName', 'Pixel'],
    ['ext', 'pdf'],
  ]) {
    test(`with a plaintext ${key} beside enc`, () => assertFails(create(encryptedPush({ [key]: value }))));
  }
  test('with an expiresAt', () => assertFails(create(encryptedFile({ expiresAt: farFuture }))));
  test('with a field no client writes', () => assertFails(create(encryptedPush({ pinned: true }))));
  test('with a type of its own', () => assertFails(create(encryptedPush({ type: 'note' }))));
  test('without createdAt', () => assertFails(create(without('createdAt', encryptedPush()))));
  test('with a createdAt that is not a timestamp', () => assertFails(create(encryptedPush({ createdAt: 'now' }))));
  test('without a key version', () => assertFails(create(without('keyVersion', encryptedPush()))));
  test('with a key version that is not a count', () => {
    return Promise.all([
      assertFails(create(encryptedPush({ keyVersion: '1' }))),
      assertFails(create(encryptedPush({ keyVersion: 0 }))),
      assertFails(create(encryptedPush({ keyVersion: 1.5 }))),
    ]);
  });
  test('without a device id', () => assertFails(create(without('deviceId', encryptedPush()))));
  test('with a device id past the bound', () => assertFails(create(encryptedPush({ deviceId: 'a'.repeat(65) }))));
  test('with search tokens that are not a list', () => assertFails(create(encryptedPush({ searchTokens: 'a' }))));
  test('for someone else', () => assertFails(create(encryptedPush({ userId: 'bob' }))));

  test('with an envelope of version 1, as a number', () => assertSucceeds(create(encryptedPush({ enc: envelope }))));
  test('with a version that is a string', () => assertFails(create(encryptedPush({ enc: { ...envelope, v: '1' } }))));
  test('with an envelope that is not a map', () => assertFails(create(encryptedPush({ enc: 'ciphertext' }))));
  test('with an envelope missing its nonce', () => assertFails(create(encryptedPush({ enc: without('n', envelope) }))));
  test('with an envelope missing its ciphertext', () =>
    assertFails(create(encryptedPush({ enc: without('ct', envelope) }))));
  test('with a field in the envelope', () =>
    assertFails(create(encryptedPush({ enc: { ...envelope, title: 'A page' } }))));
  test('with a nonce that is not 12 bytes', () =>
    assertFails(create(encryptedPush({ enc: { ...envelope, n: 'AAECAwQFBgcICQoLDA==' } }))));
  test('with a ciphertext at the bound', () =>
    assertSucceeds(create(encryptedPush({ enc: { ...envelope, ct: 'A'.repeat(16384) } }))));
  test('with a ciphertext past the bound', () =>
    assertFails(create(encryptedPush({ enc: { ...envelope, ct: 'A'.repeat(16385) } }))));

  test('a file without an objectPath', () => assertFails(create(without('objectPath', encryptedFile()))));
  test("a file naming someone else's object", () =>
    assertFails(create(encryptedFile({ objectPath: 'uploads/bob/b2JqZWN0LWlkLTAwMDAwMA' }))));
  test('a file naming something outside uploads', () =>
    assertFails(create(encryptedFile({ objectPath: 'other/alice/b2JqZWN0LWlkLTAwMDAwMA' }))));
  test('a file naming a nested path', () => assertFails(create(encryptedFile({ objectPath: `${objectPath}/x` }))));
  test('a file naming the folder itself', () => assertFails(create(encryptedFile({ objectPath: 'uploads/alice/' }))));
  test('a file naming an objectPath that is not a string', () =>
    assertFails(create(encryptedFile({ objectPath: ['uploads', 'alice', 'x'] }))));
  test('a URL with an objectPath', () => assertFails(create(encryptedPush({ objectPath }))));
});

// expiresAt is when the sweep deletes a file push; only onNewPushCreated sets it.
describe('a push document', () => {
  const pushRef = () => doc(alice(), 'pushes/p1');
  const seedPush = (data) =>
    env.withSecurityRulesDisabled((c) =>
      setDoc(doc(c.firestore(), 'pushes/p1'), { userId: 'alice', type: 'file', url: 'https://x.com', ...data })
    );

  test('created with an expiresAt', () =>
    assertFails(addDoc(collection(alice(), 'pushes'), { userId: 'alice', type: 'file', url: 'https://x.com', expiresAt: farFuture })));
  test('a URL push retitled by the title scraper', async () => {
    await seedPush({ type: 'url' });
    await assertSucceeds(updateDoc(pushRef(), { title: 'The page', searchTokens: ['the', 'page'] }));
  });
  test('a URL push retitled past the bound', async () => {
    await seedPush({ type: 'url' });
    await assertFails(updateDoc(pushRef(), { title: 'a'.repeat(1501) }));
  });
  test('a URL push retitled with something that is not a title', async () => {
    await seedPush({ type: 'url' });
    await assertFails(updateDoc(pushRef(), { title: { text: 'The page' } }));
  });
  test('a URL push given search tokens that are not a list', async () => {
    await seedPush({ type: 'url' });
    await assertFails(updateDoc(pushRef(), { searchTokens: 'the page' }));
  });
  test('a file push retitled, which would strand its stored object', async () => {
    await seedPush({ expiresAt: farFuture });
    await assertFails(updateDoc(pushRef(), { title: 'renamed' }));
  });
  test('a file push made a URL push, which the delete trigger would then skip', async () => {
    await seedPush({ expiresAt: farFuture });
    await assertFails(updateDoc(pushRef(), { type: 'url' }));
  });
  test('a URL push given a file', async () => {
    await seedPush({ type: 'url' });
    await assertFails(updateDoc(pushRef(), { url: 'https://y.com' }));
  });
  test('kept past its expiry', async () => {
    await seedPush({ expiresAt: anchoredOnFirst });
    await assertFails(updateDoc(pushRef(), { expiresAt: farFuture }));
  });
  test('handed to someone else', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), { userId: 'bob' }));
  });
  test('deleted by its owner', async () => {
    await seedPush({ expiresAt: farFuture });
    await assertSucceeds(deleteDoc(pushRef()));
  });
});

// The update a client makes to an encrypted push: the scraped title re-encrypted with the
// URL, which rewrites enc and the blind index and nothing else.
describe('an encrypted push document', () => {
  const pushRef = () => doc(alice(), 'pushes/p1');
  const seedPush = (data) =>
    env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'pushes/p1'), encryptedPush(data)));
  const retitled = { enc: { ...envelope, n: 'CwoJCAcGBQQDAgEA' }, searchTokens: ['CCCCCCCCCCCCCCCC'] };

  test('a URL push retitled', async () => {
    await seedPush({});
    await assertSucceeds(updateDoc(pushRef(), retitled));
  });
  test('a URL push given a plaintext title, as an old scraper would', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), { title: 'The page', searchTokens: ['the', 'page'] }));
  });
  test('a URL push given a bad envelope', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), { enc: { ...envelope, n: 'short' } }));
  });
  test('a URL push moved to another key version', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), { ...retitled, keyVersion: 2 }));
  });
  test('a URL push given an objectPath', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), { objectPath }));
  });
  test('a file push re-encrypted, which a file push never is', async () => {
    await seedPush({ type: 'file', objectPath, expiresAt: farFuture });
    await assertFails(updateDoc(pushRef(), retitled));
  });
  test('a file push pointed at another object', async () => {
    await seedPush({ type: 'file', objectPath, expiresAt: farFuture });
    await assertFails(updateDoc(pushRef(), { objectPath: 'uploads/alice/YW5vdGhlci1vYmplY3QtMDAw' }));
  });
  test('kept past its expiry', async () => {
    await seedPush({ type: 'file', objectPath, expiresAt: anchoredOnFirst });
    await assertFails(updateDoc(pushRef(), { expiresAt: farFuture }));
  });
  test('handed to someone else', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), { ...retitled, userId: 'bob' }));
  });
  test('updated by someone else', async () => {
    await seedPush({});
    await assertFails(updateDoc(doc(env.authenticatedContext('bob').firestore(), 'pushes/p1'), retitled));
  });
  test('deleted by its owner', async () => {
    await seedPush({});
    await assertSucceeds(deleteDoc(pushRef()));
  });
});

// A plaintext push encrypted in place (docs/e2ee.md, Migration): enc, the blind index,
// keyVersion and deviceId in; url, title, deviceName and ext out; a file push gains the
// objectPath its title named. Once, since the result has enc and the encrypted rules
// apply from then on.
describe('migrating a plaintext push', () => {
  const pushRef = () => doc(alice(), 'pushes/p1');
  const seedPush = (data) =>
    env.withSecurityRulesDisabled((c) =>
      setDoc(doc(c.firestore(), 'pushes/p1'), webPush({ createdAt: anchoredOnFirst, deviceName: 'Pixel', ...data }))
    );
  const migration = (fields = {}) => ({
    enc: envelope,
    searchTokens: ['AAAAAAAAAAAAAAAA'],
    keyVersion: 1,
    deviceId: 'ZGV2aWNlLWlkLTAwMDAwMA',
    url: deleteField(),
    title: deleteField(),
    deviceName: deleteField(),
    ext: deleteField(),
    ...fields,
  });
  const legacyFile = {
    type: 'file',
    url: 'https://firebasestorage.googleapis.com/v0/b/b/o/uploads%2Falice%2Fa.pdf?alt=media&token=t',
    title: 'a.pdf',
    ext: 'pdf',
    expiresAt: farFuture,
  };

  test('a URL push', async () => {
    await seedPush({});
    await assertSucceeds(updateDoc(pushRef(), migration()));
  });
  test('a URL push an old client made with no search tokens or extension', async () => {
    const { searchTokens: _searchTokens, ...old } = webPush({ createdAt: anchoredOnFirst, deviceName: 'Pixel' });
    await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'pushes/p1'), old));
    await assertSucceeds(updateDoc(pushRef(), migration()));
  });
  test('a file push, keeping its expiry, with the path its title named', async () => {
    await seedPush(legacyFile);
    await assertSucceeds(updateDoc(pushRef(), migration({ objectPath: 'uploads/alice/a.pdf' })));
  });
  // The shape was bounded on 2026-10-26; a push from before may hold a field no client
  // writes now, and the migration drops it with the plaintext ones.
  test('a push from before the shape was bounded, with a field no client writes now', async () => {
    await seedPush({ pinned: true });
    await assertSucceeds(updateDoc(pushRef(), migration({ pinned: deleteField() })));
  });
  test('the same push keeping that field', async () => {
    await seedPush({ pinned: true });
    await assertFails(updateDoc(pushRef(), migration()));
  });
  test('then its title rewritten as an encrypted push', async () => {
    await seedPush({});
    await updateDoc(pushRef(), migration());
    await assertSucceeds(updateDoc(pushRef(), { enc: { ...envelope, n: 'CwoJCAcGBQQDAgEA' } }));
  });

  for (const key of ['url', 'title', 'deviceName']) {
    test(`keeping its plaintext ${key}`, async () => {
      await seedPush({ ext: 'html' });
      const { [key]: _kept, ...rest } = migration();
      await assertFails(updateDoc(pushRef(), rest));
    });
  }
  test('keeping its plaintext ext', async () => {
    await seedPush({ ext: 'html' });
    const { ext: _kept, ...rest } = migration();
    await assertFails(updateDoc(pushRef(), rest));
  });
  test('without an envelope', async () => {
    await seedPush({});
    const { enc: _enc, ...rest } = migration();
    await assertFails(updateDoc(pushRef(), rest));
  });
  test('without a key version', async () => {
    await seedPush({});
    const { keyVersion: _keyVersion, ...rest } = migration();
    await assertFails(updateDoc(pushRef(), rest));
  });
  test('without a device id', async () => {
    await seedPush({});
    const { deviceId: _deviceId, ...rest } = migration();
    await assertFails(updateDoc(pushRef(), rest));
  });
  test('with a bad envelope', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), migration({ enc: { ...envelope, v: '1' } })));
  });
  test('a URL push given an objectPath', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), migration({ objectPath })));
  });
  test('a file push without an objectPath', async () => {
    await seedPush(legacyFile);
    await assertFails(updateDoc(pushRef(), migration()));
  });
  test("a file push naming someone else's object", async () => {
    await seedPush(legacyFile);
    await assertFails(updateDoc(pushRef(), migration({ objectPath: 'uploads/bob/a.pdf' })));
  });
  test('a file push made a URL push on the way', async () => {
    await seedPush(legacyFile);
    await assertFails(updateDoc(pushRef(), migration({ type: 'url', expiresAt: deleteField() })));
  });
  test('a file push kept past its expiry on the way', async () => {
    await seedPush(legacyFile);
    await assertFails(
      updateDoc(pushRef(), migration({ objectPath: 'uploads/alice/a.pdf', expiresAt: anchoredOnFirst }))
    );
  });
  test('moved to another day on the way', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), migration({ createdAt: Timestamp.now() })));
  });
  test('handed to someone else on the way', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), migration({ userId: 'bob' })));
  });
  test('with a field no client writes', async () => {
    await seedPush({});
    await assertFails(updateDoc(pushRef(), migration({ pinned: true })));
  });
});
