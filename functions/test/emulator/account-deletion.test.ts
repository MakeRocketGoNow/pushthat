import { getAuth } from 'firebase-admin/auth';
import { Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError } from 'firebase-functions/v2/https';

import {
  DELETION_SETTLE_MS,
  FRESH_SIGN_IN_S,
  deleteAccount,
  deleteAccountOf,
  finishDeletions,
} from '../../src/account-deletion';
import { stripeOf } from '../../src/stripe';
import {
  PRICE_ID,
  StripeStandIn,
  WEBHOOK_SECRET,
  billingOff,
  billingOn,
  call,
  clearAuth,
  clearFirestore,
  closeFirestore,
  db,
  list,
  stripeRefusal,
  subscription,
} from './harness';

/**
 * Account deletion against the Auth, Firestore and Storage emulators and a stand-in for
 * Stripe: that every place the project keeps something under an account is empty
 * afterwards, that another account is untouched, and that the call can be made twice.
 *
 * "Every place" is checked by walking the whole database and the whole bucket for the
 * account's id, not by naming collections, so a collection added later that is keyed by
 * the account and missed by the purge fails here without anyone remembering to list it.
 */

const UID = 'user_gone';
const OTHER = 'user_staying';
const CUSTOMER = 'cus_gone';
const OTHER_CUSTOMER = 'cus_staying';
const NOW = new Date('2026-11-12T12:00:00Z');

const stripe = new StripeStandIn();
const bucket = () => getStorage().bucket();

beforeAll(() => stripe.start());

afterAll(async () => {
  await stripe.stop();
  await clearBucket();
  await closeFirestore();
});

beforeEach(async () => {
  await Promise.all([clearFirestore(), clearAuth(), clearBucket()]);
  stripe.reset();
  billingOn(stripe);
});

async function clearBucket(): Promise<void> {
  const [files] = await bucket().getFiles();
  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
}

/** Everything a real account accumulates, in every collection and in Storage. */
async function seedAccount(uid: string, customerId: string): Promise<void> {
  await getAuth().createUser({ uid, email: `${uid}@example.com`, password: 'a password for the emulator' });
  const firestore = db();
  const batch = firestore.batch();
  batch.set(firestore.collection('users').doc(uid), {
    email: `${uid}@example.com`,
    createdAt: Timestamp.fromDate(NOW),
    fcmTokens: [`token-of-${uid}-phone`, `token-of-${uid}-browser`],
    e2ee: {
      v: 1,
      kdf: 'pbkdf2-sha256-600000',
      keyVersion: 1,
      wraps: {
        wrapPassword: { by: 'password', n: 'n'.repeat(16), ct: 'c'.repeat(64) },
        wrapRecovery: { by: 'recovery', n: 'n'.repeat(16), ct: 'c'.repeat(64) },
      },
    },
    usageRecords: { '2026-11': { url: 3, file: 1 } },
    subscription: { type: 'pro', status: 'active', expiresAt: Timestamp.fromMillis(NOW.getTime() + 1000) },
    billing: { customerId, subscriptionId: `sub_${uid}`, subscriptionStatus: 'active' },
  });
  // A subcollection the rules still name, though nothing writes it now.
  batch.set(firestore.collection('users').doc(uid).collection('usage').doc('2026-10'), { url: 1 });
  batch.set(firestore.collection('stripeCustomers').doc(customerId), { userId: uid, createdAt: NOW });
  batch.set(firestore.collection('billingEvents').doc(`evt_${uid}`), {
    eventId: `evt_${uid}`,
    type: 'invoice.paid',
    userId: uid,
    receivedAt: NOW,
  });
  const enc = { v: 1, n: 'n'.repeat(16), ct: 'ciphertext' };
  batch.set(firestore.collection('pushes').doc(), { userId: uid, type: 'url', createdAt: NOW, keyVersion: 1, enc });
  batch.set(firestore.collection('pushes').doc(), {
    userId: uid,
    type: 'file',
    createdAt: NOW,
    keyVersion: 1,
    enc,
    objectPath: `uploads/${uid}/RandomObjectId0000000A`,
  });
  // A push from before encryption, which names its file by its title.
  batch.set(firestore.collection('pushes').doc(), {
    userId: uid,
    type: 'file',
    createdAt: NOW,
    title: 'Report (final) v2.pdf',
  });
  await batch.commit();
  await Promise.all(
    [
      `uploads/${uid}/RandomObjectId0000000A`,
      `uploads/${uid}/Report (final) v2.pdf`,
      // An upload whose push never came: no document names it.
      `uploads/${uid}/RandomObjectId0000000B`,
    ].map((path) => bucket().file(path).save(Buffer.from('x')))
  );
}

/** Every document in the database, whatever collection it is in and however deep. */
async function everyDocument(): Promise<{ path: string; data: unknown }[]> {
  const found: { path: string; data: unknown }[] = [];
  const walk = async (collections: FirebaseFirestore.CollectionReference[]): Promise<void> => {
    for (const collection of collections) {
      // `listDocuments` also gives a document that is only the parent of a subcollection.
      for (const ref of await collection.listDocuments()) {
        const snapshot = await ref.get();
        if (snapshot.exists) found.push({ path: ref.path, data: snapshot.data() });
        await walk(await ref.listCollections());
      }
    }
  };
  await walk(await db().listCollections());
  return found;
}

/** Where `uid` still appears: a document's path or contents, a stored object, the Auth user. */
async function tracesOf(uid: string): Promise<string[]> {
  const traces = (await everyDocument())
    .filter((doc) => doc.path.includes(uid) || JSON.stringify(doc.data).includes(uid))
    .map((doc) => doc.path);
  const [files] = await bucket().getFiles();
  traces.push(...files.map((file) => file.name).filter((name) => name.includes(uid)));
  const user = await getAuth()
    .getUser(uid)
    .catch(() => null);
  if (user) traces.push(`auth:${uid}`);
  return traces.sort();
}

function stripeHasCustomer(customerId: string, subscriptionId: string, status = 'active'): void {
  stripe.route('GET /v1/subscriptions', (req) => ({
    body: list(
      req.query.get('customer') === customerId
        ? [subscription(subscriptionId, { customer: customerId, status, created: 1 })]
        : []
    ),
  }));
  stripe.route(`DELETE /v1/subscriptions/${subscriptionId}`, { id: subscriptionId, status: 'canceled' });
  stripe.route(`DELETE /v1/customers/${customerId}`, { id: customerId, deleted: true });
}

const config = () =>
  stripeOf({
    STRIPE_SECRET_KEY: 'sk_test_emulator',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STRIPE_PRO_PRICE_ID: PRICE_ID,
    STRIPE_API_URL: stripe.url,
  });

const settled = (from: Date) => new Date(from.getTime() + DELETION_SETTLE_MS + 1000);

describe('deleteAccountOf', () => {
  test('leaves nothing under the account but the marker, and the second purge removes that', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    // The seed itself must be findable, or an empty result below would prove nothing.
    expect((await tracesOf(UID)).length).toBeGreaterThan(8);

    await deleteAccountOf(UID, { stripe: config(), now: NOW });

    expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
    // The marker holds two times and nothing about the person.
    const marker = (await db().collection('accountDeletions').doc(UID).get()).data()!;
    expect(Object.keys(marker).sort()).toEqual(['deletedAt', 'settleAt']);

    expect(await finishDeletions(settled(NOW))).toEqual([UID]);
    expect(await tracesOf(UID)).toEqual([]);
  });

  test('another account keeps everything', async () => {
    await seedAccount(UID, CUSTOMER);
    await seedAccount(OTHER, OTHER_CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    const before = await tracesOf(OTHER);

    await deleteAccountOf(UID, { stripe: config(), now: NOW });
    await finishDeletions(settled(NOW));

    expect(await tracesOf(OTHER)).toEqual(before);
    expect(stripe.made(`DELETE /v1/customers/${OTHER_CUSTOMER}`)).toHaveLength(0);
  });

  test('the subscription is cancelled and the customer deleted at Stripe', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);

    await deleteAccountOf(UID, { stripe: config(), now: NOW });

    expect(stripe.made(`DELETE /v1/subscriptions/sub_${UID}`)).toHaveLength(1);
    expect(stripe.made(`DELETE /v1/customers/${CUSTOMER}`)).toHaveLength(1);
  });

  test('a subscription already over is not cancelled again', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`, 'canceled');

    await deleteAccountOf(UID, { stripe: config(), now: NOW });

    expect(stripe.made(`DELETE /v1/subscriptions/sub_${UID}`)).toHaveLength(0);
    expect(stripe.made(`DELETE /v1/customers/${CUSTOMER}`)).toHaveLength(1);
  });

  test('a subscription Stripe will not cancel stops the deletion with everything still there', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    stripe.route(`DELETE /v1/subscriptions/sub_${UID}`, () => stripeRefusal(500, 'try again'));
    stripe.route(`GET /v1/subscriptions/sub_${UID}`, subscription(`sub_${UID}`, { customer: CUSTOMER, created: 1 }));
    const before = await tracesOf(UID);

    await expect(deleteAccountOf(UID, { stripe: config(), now: NOW })).rejects.toThrow(/Stripe answered 500/);

    expect(await tracesOf(UID)).toEqual(before);
  });

  test('a customer Stripe will not delete does not stop it', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    stripe.route(`DELETE /v1/customers/${CUSTOMER}`, () => stripeRefusal(500, 'try again'));

    await deleteAccountOf(UID, { stripe: config(), now: NOW });

    expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
  });

  test('an account that never subscribed asks nothing of Stripe', async () => {
    await getAuth().createUser({ uid: UID, email: `${UID}@example.com` });
    await db()
      .collection('users')
      .doc(UID)
      .set({ email: `${UID}@example.com`, fcmTokens: ['t'] });

    await deleteAccountOf(UID, { stripe: config(), now: NOW });

    expect(stripe.requests).toHaveLength(0);
    expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
  });

  test('a second call for the same account succeeds and changes nothing', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    await deleteAccountOf(UID, { stripe: config(), now: NOW });
    const later = new Date(NOW.getTime() + 60_000);

    await expect(deleteAccountOf(UID, { stripe: config(), now: later })).resolves.toBeUndefined();

    expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
    // The customer's row went with the first call, so Stripe is not asked a second time.
    expect(stripe.made(`DELETE /v1/customers/${CUSTOMER}`)).toHaveLength(1);
  });

  test('a call that stopped halfway is finished by the next', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    const failing = {
      revokeRefreshTokens: () => Promise.reject(new Error('the Auth service is down')),
      deleteUser: () => Promise.resolve(),
    };
    await expect(deleteAccountOf(UID, { stripe: config(), now: NOW, auth: failing })).rejects.toThrow(/is down/);
    // Stopped after Stripe and before the data: the person can still sign in and ask again.
    expect(await tracesOf(UID)).toContain(`auth:${UID}`);

    await deleteAccountOf(UID, { stripe: config(), now: NOW });

    expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
  });

  test('every session is ended: the refresh tokens are revoked before the user is deleted', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    const calls: string[] = [];
    const auth = {
      revokeRefreshTokens: async (uid: string) => void calls.push(`revoke ${uid}`),
      deleteUser: async (uid: string) => {
        calls.push(`delete ${uid}`);
        await getAuth().deleteUser(uid);
      },
    };

    await deleteAccountOf(UID, { stripe: config(), now: NOW, auth });

    expect(calls).toEqual([`revoke ${UID}`, `delete ${UID}`]);
  });
});

describe('finishDeletions', () => {
  test('removes what a device still signed in wrote after the deletion', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    await deleteAccountOf(UID, { stripe: config(), now: NOW });
    // An ID token lives up to an hour past the deletion, and the rules still take it.
    await db()
      .collection('users')
      .doc(UID)
      .set({ fcmTokens: ['token-written-late'] });
    await db().collection('pushes').add({ userId: UID, type: 'url', createdAt: NOW });
    await bucket().file(`uploads/${UID}/late`).save(Buffer.from('x'));

    expect(await finishDeletions(settled(NOW))).toEqual([UID]);

    expect(await tracesOf(UID)).toEqual([]);
  });

  test('leaves a deletion whose tokens may still be alive', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    await deleteAccountOf(UID, { stripe: config(), now: NOW });

    expect(await finishDeletions(new Date(NOW.getTime() + 30 * 60 * 1000))).toEqual([]);

    expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
  });
});

describe('deleteAccount', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  /** The refusal `promise` ends in, as `code: message`. */
  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      if (err instanceof HttpsError) return `${err.code}: ${err.message}`;
      throw err;
    }
    throw new Error('expected a refusal');
  }

  test('refuses a caller who is not signed in', async () => {
    expect(await refusal(call(deleteAccount, null))).toMatch(/^unauthenticated/);
  });

  test('refuses a session whose sign-in is old, and deletes nothing', async () => {
    await seedAccount(UID, CUSTOMER);
    const before = await tracesOf(UID);

    const stale = { auth_time: nowSeconds() - FRESH_SIGN_IN_S - 60 };
    expect(await refusal(call(deleteAccount, UID, {}, stale))).toMatch(/^failed-precondition: Enter your password/);
    // A token with no sign-in time at all is refused the same way.
    expect(await refusal(call(deleteAccount, UID))).toMatch(/^failed-precondition/);

    expect(await tracesOf(UID)).toEqual(before);
    expect(stripe.requests).toHaveLength(0);
  });

  test('deletes the account of a caller who has just signed in, and answers the same a second time', async () => {
    await seedAccount(UID, CUSTOMER);
    await seedAccount(OTHER, OTHER_CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    const fresh = { auth_time: nowSeconds() - 3 };

    expect(await call(deleteAccount, UID, {}, fresh)).toEqual({ deleted: true });
    expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
    expect(await tracesOf(OTHER)).not.toEqual([]);

    // The deleted account's last ID token is good for up to an hour more.
    expect(await call(deleteAccount, UID, {}, fresh)).toEqual({ deleted: true });
  });

  test('says so, and deletes nothing, when the subscription cannot be cancelled', async () => {
    await seedAccount(UID, CUSTOMER);
    stripeHasCustomer(CUSTOMER, `sub_${UID}`);
    stripe.route(`DELETE /v1/subscriptions/sub_${UID}`, () => stripeRefusal(500, 'try again'));
    stripe.route(`GET /v1/subscriptions/sub_${UID}`, subscription(`sub_${UID}`, { customer: CUSTOMER, created: 1 }));
    const before = await tracesOf(UID);

    expect(await refusal(call(deleteAccount, UID, {}, { auth_time: nowSeconds() }))).toMatch(
      /^unavailable: Your subscription could not be cancelled/
    );

    expect(await tracesOf(UID)).toEqual(before);
  });

  describe('with billing off', () => {
    const emulator = process.env.FUNCTIONS_EMULATOR;
    afterEach(() => {
      if (emulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
      else process.env.FUNCTIONS_EMULATOR = emulator;
    });

    test('on the emulator it deletes the account and asks nothing of Stripe', async () => {
      billingOff();
      process.env.FUNCTIONS_EMULATOR = 'true';
      await seedAccount(UID, CUSTOMER);

      expect(await call(deleteAccount, UID, {}, { auth_time: nowSeconds() })).toEqual({ deleted: true });

      expect(stripe.requests).toHaveLength(0);
      expect(await tracesOf(UID)).toEqual([`accountDeletions/${UID}`]);
    });

    test('deployed, it refuses an account with a customer, and deletes nothing', async () => {
      billingOff();
      delete process.env.FUNCTIONS_EMULATOR;
      await seedAccount(UID, CUSTOMER);
      const before = await tracesOf(UID);

      expect(await refusal(call(deleteAccount, UID, {}, { auth_time: nowSeconds() }))).toMatch(
        /^unavailable: Your subscription could not be cancelled/
      );

      expect(await tracesOf(UID)).toEqual(before);
    });

    test('deployed, an account that never subscribed is still deleted', async () => {
      billingOff();
      delete process.env.FUNCTIONS_EMULATOR;
      await getAuth().createUser({ uid: UID, email: `${UID}@example.com` });
      await db()
        .collection('users')
        .doc(UID)
        .set({ email: `${UID}@example.com` });

      expect(await call(deleteAccount, UID, {}, { auth_time: nowSeconds() })).toEqual({ deleted: true });
    });
  });
});
