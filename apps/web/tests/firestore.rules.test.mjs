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

// The tiers' limits: Free 50 URL and 3 file pushes a month, Pro 10,000 and 100
// (docs/billing.md in pushthat-functions).
describe('the push quota', () => {
  const push = (type = 'url') => addDoc(collection(alice(), 'pushes'), { userId: 'alice', type, url: 'https://x.com' });
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
