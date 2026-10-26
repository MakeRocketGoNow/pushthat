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
