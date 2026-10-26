import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { createCheckoutSession, refreshSubscription } from '../../src/stripe-functions';
import {
  DAY,
  PRICE_ID,
  StripeStandIn,
  YEAR,
  billingOff,
  billingOn,
  call,
  clearFirestore,
  closeFirestore,
  db,
  invoice,
  list,
  millisOf,
  msOf,
  seedCustomer,
  stripeRefusal,
  subscription,
  userDoc,
} from './harness';

/**
 * The two callables that read Stripe and write the document: `refreshSubscription`,
 * which applies the subscription as an event would, and `createCheckoutSession`, which
 * makes the customer before the checkout. Against the Firestore emulator and a stand-in
 * for Stripe.
 */

const UID = 'user_1';
const CUSTOMER = 'cus_1';

const stripe = new StripeStandIn();

beforeAll(() => stripe.start());

afterAll(async () => {
  await stripe.stop();
  await closeFirestore();
});

beforeEach(async () => {
  await clearFirestore();
  stripe.reset();
  billingOn(stripe);
});

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

describe('refreshSubscription', () => {
  const refresh = () => call(refreshSubscription, UID);

  test('an account with no customer gets its report, and Stripe is not asked', async () => {
    await db().collection('users').doc(UID).set({ createdAt: Timestamp.now() });
    const report = await refresh();
    expect(report).toMatchObject({ tier: 'free' });
    expect(stripe.requests).toHaveLength(0);
  });

  test('with billing off it answers from the document alone', async () => {
    billingOff();
    await seedCustomer(UID, CUSTOMER);
    await refresh();
    expect(stripe.requests).toHaveLength(0);
  });

  test("a document with a customer and no subscription yet takes the customer's newest", async () => {
    await seedCustomer(UID, CUSTOMER);
    const start = nowSeconds() - DAY;
    stripe.route(
      'GET /v1/subscriptions',
      list([
        subscription('sub_old', { created: start - YEAR, status: 'canceled' }),
        subscription('sub_1', { created: start }),
      ])
    );

    const report = await refresh();

    // Asserted here rather than in the route, where a failure would throw in the stand-in's
    // server and reach the test only as a dropped connection.
    const [listed] = stripe.made('GET /v1/subscriptions');
    expect(listed.query.get('customer')).toBe(CUSTOMER);
    expect(listed.query.get('status')).toBe('all');
    expect(report).toMatchObject({ tier: 'pro' });
    const user = await userDoc(UID);
    expect(user.billing).toMatchObject({ subscriptionId: 'sub_1', subscriptionStatus: 'active' });
    expect(millisOf(user.subscription.expiresAt)).toBe(msOf(start + YEAR));
  });

  test('a lost renewal `invoice.paid` is repaired from the invoice the subscription carries', async () => {
    // The document as the first year left it: that year's end just passed, and the
    // renewal's snapshot and invoice both lost.
    const renewal = nowSeconds() - DAY;
    await seedCustomer(UID, CUSTOMER, {
      subscription: { type: 'pro', expiresAt: Timestamp.fromMillis(msOf(renewal)), status: 'active' },
      billing: {
        subscriptionId: 'sub_1',
        subscriptionStatus: 'active',
        eventAt: new Date(msOf(renewal - YEAR)).toISOString(),
      },
    });
    stripe.route(
      'GET /v1/subscriptions/sub_1',
      subscription('sub_1', {
        created: renewal - YEAR,
        periodStart: renewal,
        latestInvoice: invoice('in_2', { subscription: 'sub_1', periodStart: renewal }),
      })
    );

    const report = await refresh();

    expect(stripe.made('GET /v1/subscriptions/sub_1')[0].query.get('expand[]')).toBe('latest_invoice');
    expect(report).toMatchObject({ tier: 'pro' });
    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(renewal + YEAR));
  });

  test('an unpaid renewal is given only the grace', async () => {
    const renewal = nowSeconds() - DAY;
    await seedCustomer(UID, CUSTOMER, {
      subscription: { type: 'pro', expiresAt: Timestamp.fromMillis(msOf(renewal)), status: 'active' },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    });
    stripe.route(
      'GET /v1/subscriptions/sub_1',
      subscription('sub_1', {
        created: renewal - YEAR,
        periodStart: renewal,
        latestInvoice: invoice('in_2', { subscription: 'sub_1', periodStart: renewal, status: 'open' }),
      })
    );

    await refresh();

    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(renewal + 3 * DAY));
  });

  test("a lost `customer.subscription.deleted` is repaired when the canceled subscription is the document's own", async () => {
    const start = nowSeconds() - 30 * DAY;
    await seedCustomer(UID, CUSTOMER, {
      subscription: { type: 'pro', expiresAt: Timestamp.fromMillis(msOf(start + YEAR)), status: 'active' },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    });
    stripe.route(
      'GET /v1/subscriptions/sub_1',
      subscription('sub_1', { created: start, status: 'canceled', canceledAt: start + DAY })
    );

    await refresh();

    const user = await userDoc(UID);
    expect(user.billing.subscriptionStatus).toBe('canceled');
    expect(user.subscription.status).toBe('canceled');
  });

  test("a canceled subscription that is not the document's changes nothing", async () => {
    await seedCustomer(UID, CUSTOMER);
    stripe.route(
      'GET /v1/subscriptions',
      list([subscription('sub_old', { created: nowSeconds() - YEAR, status: 'canceled' })])
    );
    const before = await userDoc(UID);

    expect(await refresh()).toMatchObject({ tier: 'free' });
    expect(await userDoc(UID)).toEqual(before);
  });

  test('a refusal from Stripe is `unavailable`, and nothing is written', async () => {
    await seedCustomer(UID, CUSTOMER);
    stripe.route('GET /v1/subscriptions', () => stripeRefusal(500, 'Stripe is having a moment'));
    const before = await userDoc(UID);

    expect(await refusal(refresh())).toMatch(/^unavailable: Stripe could not read the subscription/);
    expect(await userDoc(UID)).toEqual(before);
  });
});

describe('createCheckoutSession', () => {
  const checkout = (uid: string | null = UID) => call(createCheckoutSession, uid) as Promise<{ url: string }>;

  /** Stripe as a new customer finds it: no subscriptions, and a session made on asking. */
  function stripeForANewCustomer() {
    stripe.route('POST /v1/customers', { id: CUSTOMER, email: `${UID}@example.com` });
    stripe.route('GET /v1/subscriptions', list([]));
    stripe.route('POST /v1/checkout/sessions', {
      id: 'cs_1',
      url: 'https://checkout.stripe.test/cs_1',
      status: 'open',
      customer: CUSTOMER,
      subscription: null,
    });
  }

  test('a first checkout makes the customer, writes it on the document and the mapping, then the session', async () => {
    await db().collection('users').doc(UID).set({ createdAt: Timestamp.now() });
    stripeForANewCustomer();

    expect(await checkout()).toEqual({ url: 'https://checkout.stripe.test/cs_1' });

    const [customer] = stripe.made('POST /v1/customers');
    expect(customer.form.get('email')).toBe(`${UID}@example.com`);
    expect(customer.form.get('metadata[user_id]')).toBe(UID);
    expect(customer.headers['idempotency-key']).toMatch(new RegExp(`^customer-${UID}-\\d+$`));
    expect((await userDoc(UID)).billing).toEqual({ customerId: CUSTOMER });
    expect((await db().collection('stripeCustomers').doc(CUSTOMER).get()).data()).toMatchObject({ userId: UID });

    const [session] = stripe.made('POST /v1/checkout/sessions');
    expect(Object.fromEntries(session.form)).toMatchObject({
      mode: 'subscription',
      'managed_payments[enabled]': 'true',
      customer: CUSTOMER,
      client_reference_id: UID,
      'line_items[0][price]': PRICE_ID,
      'line_items[0][quantity]': '1',
      success_url: 'https://pushthat.link/plan?checkout=complete',
      cancel_url: 'https://pushthat.link/plan',
      'subscription_data[metadata][user_id]': UID,
    });
    expect(session.headers.authorization).toBe('Bearer sk_test_emulator');
    expect(session.headers['stripe-version']).toBe('2025-03-31.basil');
    // The customer's open sessions are ended before a new one is made.
    const order = stripe.requests.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('GET /v1/checkout/sessions')).toBeLessThan(order.indexOf('POST /v1/checkout/sessions'));
  });

  test('a returning customer is not made again, and its open checkouts are ended', async () => {
    await seedCustomer(UID, CUSTOMER);
    stripeForANewCustomer();
    stripe.route('GET /v1/checkout/sessions', list([{ id: 'cs_old', status: 'open' }]));
    // Completed in the moment between the list and the expire: already what is wanted.
    stripe.route('POST /v1/checkout/sessions/cs_old/expire', () => stripeRefusal(400, 'Only open sessions'));

    expect((await checkout()).url).toBe('https://checkout.stripe.test/cs_1');
    expect(stripe.made('POST /v1/customers')).toHaveLength(0);
    expect(stripe.made('POST /v1/checkout/sessions/cs_old/expire')).toHaveLength(1);
  });

  test('a subscription Stripe has and the document has not heard of yet is refused', async () => {
    await seedCustomer(UID, CUSTOMER);
    stripeForANewCustomer();
    stripe.route('GET /v1/subscriptions', list([subscription('sub_1', { created: nowSeconds() })]));

    expect(await refusal(checkout())).toMatch(/^already-exists:/);
    expect(stripe.made('POST /v1/checkout/sessions')).toHaveLength(0);
  });

  test('an account the document holds as subscribed is refused before Stripe is asked', async () => {
    await seedCustomer(UID, CUSTOMER, {
      subscription: { type: 'pro', expiresAt: Timestamp.fromMillis(Date.now() + YEAR * 1000), status: 'active' },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    });
    expect(await refusal(checkout())).toMatch(/^already-exists:/);
    expect(stripe.requests).toHaveLength(0);
  });

  test('a lapsed subscriber may check out again', async () => {
    await seedCustomer(UID, CUSTOMER, {
      subscription: { type: 'pro', expiresAt: Timestamp.fromMillis(Date.now() - DAY * 1000), status: 'canceled' },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'canceled' },
    });
    stripeForANewCustomer();
    stripe.route(
      'GET /v1/subscriptions',
      list([subscription('sub_1', { created: nowSeconds() - YEAR, status: 'canceled' })])
    );
    expect((await checkout()).url).toBe('https://checkout.stripe.test/cs_1');
  });

  test('a running comp is refused', async () => {
    await db()
      .collection('users')
      .doc(UID)
      .set({ subscription: { type: 'comp', expiresAt: Timestamp.fromMillis(Date.now() + YEAR * 1000) } });
    expect(await refusal(checkout())).toMatch(/^failed-precondition: This account is complimentary/);
    expect(stripe.requests).toHaveLength(0);
  });

  test('signed out, or with billing off, it is refused', async () => {
    expect(await refusal(checkout(null))).toMatch(/^unauthenticated:/);
    billingOff();
    expect(await refusal(checkout())).toMatch(/^failed-precondition: There is no plan to sell/);
  });

  test('a refusal from Stripe is `unavailable`, and a customer it did not make is not written', async () => {
    await db().collection('users').doc(UID).set({ createdAt: Timestamp.now() });
    stripe.route('POST /v1/customers', () => stripeRefusal(500, 'Stripe is having a moment'));

    expect(await refusal(checkout())).toMatch(/^unavailable: Stripe could not start the checkout/);
    expect((await userDoc(UID)).billing).toBeUndefined();
    expect((await db().collection('stripeCustomers').get()).empty).toBe(true);
  });
});
