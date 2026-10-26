import { signWebhook } from '../../src/stripe';
import { eventStamp } from '../../src/stripe-events';
import { applyPatch, stripeWebhook } from '../../src/stripe-functions';
import {
  DAY,
  STRIPE_IP,
  StripeStandIn,
  WEBHOOK_SECRET,
  YEAR,
  billingOff,
  billingOn,
  charge,
  clearFirestore,
  closeFirestore,
  db,
  deliver,
  event,
  invoice,
  list,
  millisOf,
  msOf,
  restoreFetch,
  seedCustomer,
  serve,
  standInForStripeIps,
  stripeRefusal,
  subscription,
  userDoc,
} from './harness';

/**
 * `stripeWebhook` end to end: a signed delivery over HTTP, the Firestore emulator for the
 * documents, and a stand-in for the Stripe calls it makes. The rules themselves are
 * tested in stripe-events.test.ts; these are about the glue: the refusals, the event
 * record, the stamp's guard and the order deliveries land in.
 */

const T0 = Date.UTC(2026, 0, 1) / 1000;
const UID = 'user_1';
const CUSTOMER = 'cus_1';

const stripe = new StripeStandIn();
let webhook: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  await stripe.start();
  webhook = await serve(stripeWebhook as never);
});

afterAll(async () => {
  await webhook.close();
  await stripe.stop();
  restoreFetch();
  await closeFirestore();
});

beforeEach(async () => {
  await clearFirestore();
  stripe.reset();
  billingOn(stripe);
  standInForStripeIps();
});

const post = (e: unknown, opts?: Parameters<typeof deliver>[2]) => deliver(webhook.url, e, opts);
const eventRecord = async (id: string) => (await db().collection('billingEvents').doc(id).get()).data();

/** The first checkout's subscription, delivered and applied: the document names `sub_1`, Pro for the year from `T0`. */
async function subscribed(subId = 'sub_1', created = T0) {
  await seedCustomer(UID, CUSTOMER);
  const res = await post(event('customer.subscription.created', subscription(subId, { created }), created));
  expect(res).toEqual({ status: 200, body: { applied: true } });
}

/**
 * Stripe's side of a refund: `sub_1` as Stripe holds it, cancelled by the DELETE (a
 * second DELETE is refused, as Stripe refuses one of a canceled subscription), and the
 * way from the charge's payment intent to the invoice that billed it.
 */
function stripeHoldsRefundable(subId = 'sub_1') {
  let status = 'active';
  stripe.route(`GET /v1/subscriptions/${subId}`, () => ({ body: subscription(subId, { created: T0, status }) }));
  stripe.route(`DELETE /v1/subscriptions/${subId}`, () => {
    if (status === 'canceled') return stripeRefusal(400, 'This subscription has already been canceled.');
    status = 'canceled';
    return { body: subscription(subId, { created: T0, status }) };
  });
  stripe.route('GET /v1/invoice_payments', (req) =>
    req.query.get('payment[payment_intent]') === 'pi_1'
      ? { body: list([{ id: 'inpay_1', invoice: 'in_1', status: 'paid' }]) }
      : { body: list([]) }
  );
  stripe.route('GET /v1/invoices/in_1', invoice('in_1', { subscription: subId, periodStart: T0 }));
  return {
    cancel: () => {
      status = 'canceled';
    },
  };
}

describe('refusals', () => {
  test('404 while billing is off', async () => {
    billingOff();
    expect((await post(event('customer.subscription.created', {}, T0))).status).toBe(404);
  });

  test('405 for anything but a POST', async () => {
    expect((await post(null, { method: 'GET' })).status).toBe(405);
  });

  test("403 from an address that is not one of Stripe's, whatever the signature", async () => {
    await seedCustomer(UID, CUSTOMER);
    const e = event('customer.subscription.created', subscription('sub_1', { created: T0 }), T0);
    const res = await post(e, { address: '203.0.113.9' });
    expect(res).toEqual({ status: 403, body: { error: 'Not from Stripe' } });
    expect(await eventRecord(e.id)).toBeUndefined();
    expect((await userDoc(UID)).subscription).toBeUndefined();
  });

  test("403 for a caller who puts Stripe's address first in X-Forwarded-For", async () => {
    // Google's front end appends the address it saw; only the last hop is observed.
    const res = await post(event('customer.subscription.created', {}, T0), { address: `${STRIPE_IP}, 203.0.113.9` });
    expect(res.status).toBe(403);
  });

  test('401 for a body signed with another secret, or not signed', async () => {
    await seedCustomer(UID, CUSTOMER);
    const e = event('customer.subscription.created', subscription('sub_1', { created: T0 }), T0);
    const raw = JSON.stringify(e);
    const wrong = signWebhook('whsec_someone_else', raw, Math.floor(Date.now() / 1000));
    expect(await post(e, { signature: wrong })).toEqual({ status: 401, body: { error: 'Bad signature' } });
    expect((await post(e, { signature: '' })).status).toBe(401);
    expect(await eventRecord(e.id)).toBeUndefined();
  });

  test('401 for a signature over different bytes than were sent', async () => {
    const e = event('customer.subscription.created', subscription('sub_1', { created: T0 }), T0);
    // Signed compact, sent pretty-printed: the same event, but not the bytes signed.
    const signature = signWebhook(WEBHOOK_SECRET, JSON.stringify(e), Math.floor(Date.now() / 1000));
    expect((await post(e, { raw: JSON.stringify(e, null, 2), signature })).status).toBe(401);
  });

  test('400 for a signed body that is not JSON', async () => {
    expect(await post(null, { raw: 'not json' })).toEqual({ status: 400, body: { error: 'Not JSON' } });
  });

  test('400 for signed JSON that is not an event', async () => {
    for (const body of [{ hello: 'world' }, { id: 'evt_x', type: 'invoice.paid', created: T0 }, null]) {
      expect(await post(body)).toEqual({ status: 400, body: { error: 'Not a Stripe event' } });
    }
  });
});

describe('200', () => {
  test('applied: the subscription on the document, the event recorded, the open checkouts ended', async () => {
    await seedCustomer(UID, CUSTOMER);
    stripe.route('GET /v1/checkout/sessions', { object: 'list', data: [{ id: 'cs_open' }], has_more: false });
    stripe.route('POST /v1/checkout/sessions/cs_open/expire', { id: 'cs_open', status: 'expired' });
    const e = event('customer.subscription.created', subscription('sub_1', { created: T0 }), T0);

    expect(await post(e)).toEqual({ status: 200, body: { applied: true } });

    const user = await userDoc(UID);
    expect(user.billing).toEqual({
      customerId: CUSTOMER,
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      eventAt: eventStamp(T0),
    });
    expect(user.subscription).toMatchObject({ type: 'pro', interval: 'yearly', status: 'active', cancelsAt: null });
    expect(millisOf(user.subscription.expiresAt)).toBe(msOf(T0 + YEAR));
    expect(millisOf(user.subscription.startedAt)).toBe(msOf(T0));

    const record = await eventRecord(e.id);
    expect(record).toMatchObject({ eventId: e.id, type: e.type, occurredAt: eventStamp(T0), userId: UID });
    // Kept for a TTL policy: about thirty days from now.
    expect(millisOf(record!.expireAt)! - Date.now()).toBeGreaterThan(29 * DAY * 1000);

    const [listed] = stripe.made('GET /v1/checkout/sessions');
    expect(listed.query.get('customer')).toBe(CUSTOMER);
    expect(listed.query.get('status')).toBe('open');
    expect(stripe.made('POST /v1/checkout/sessions/cs_open/expire')).toHaveLength(1);
  });

  test('a duplicate by event id: 200, and nothing written or asked of Stripe again', async () => {
    await subscribed();
    const e = event(
      'customer.subscription.updated',
      subscription('sub_1', { created: T0, status: 'past_due' }),
      T0 + 100
    );
    expect(await post(e)).toEqual({ status: 200, body: { applied: true } });
    const before = await userDoc(UID);
    const asked = stripe.requests.length;

    expect(await post(e)).toEqual({ status: 200, body: { applied: false, reason: 'duplicate' } });
    expect(await userDoc(UID)).toEqual(before);
    expect(stripe.requests).toHaveLength(asked);
  });

  test('two deliveries of one event at once: one applies it, the other finds the record', async () => {
    await seedCustomer(UID, CUSTOMER);
    const e = event('customer.subscription.created', subscription('sub_1', { created: T0 }), T0);
    const answers = (await Promise.all([post(e), post(e)])).map((r) => r.body);
    expect(answers).toEqual(expect.arrayContaining([{ applied: true }, { applied: false, reason: 'duplicate' }]));
  });

  test('a customer no account holds: 200, and nothing recorded', async () => {
    const e = event(
      'customer.subscription.created',
      subscription('sub_1', { created: T0, customer: 'cus_dashboard' }),
      T0
    );
    expect(await post(e)).toEqual({ status: 200, body: { applied: false, reason: 'no account' } });
    expect(await eventRecord(e.id)).toBeUndefined();
    expect((await db().collection('users').get()).empty).toBe(true);
    // Nothing is asked of Stripe for a customer that is not ours.
    expect(stripe.requests).toHaveLength(0);
  });

  test('a type the rules do not follow: 200, recorded, the document untouched', async () => {
    await subscribed();
    const before = await userDoc(UID);
    const e = event('customer.subscription.trial_will_end', subscription('sub_1', { created: T0 }), T0 + 50);
    expect(await post(e)).toEqual({ status: 200, body: { applied: false, reason: 'not followed' } });
    expect(await eventRecord(e.id)).toBeDefined();
    expect(await userDoc(UID)).toEqual(before);
  });

  test('502 when the open checkouts cannot be ended, with nothing recorded, so Stripe delivers again', async () => {
    await seedCustomer(UID, CUSTOMER);
    stripe.route('GET /v1/checkout/sessions', () => stripeRefusal(500, 'Stripe is having a moment'));
    const e = event('customer.subscription.created', subscription('sub_1', { created: T0 }), T0);
    expect((await post(e)).status).toBe(502);
    expect(await eventRecord(e.id)).toBeUndefined();

    stripe.reset();
    expect(await post(e)).toEqual({ status: 200, body: { applied: true } });
  });
});

describe('order', () => {
  test("an older subscription event is skipped by the document's `billing.eventAt`", async () => {
    await subscribed();
    const newer = event(
      'customer.subscription.updated',
      subscription('sub_1', { created: T0, status: 'past_due' }),
      T0 + 200
    );
    const older = event(
      'customer.subscription.updated',
      { ...subscription('sub_1', { created: T0 }), cancel_at_period_end: true },
      T0 + 100
    );
    expect((await post(newer)).body).toEqual({ applied: true });

    expect(await post(older)).toEqual({ status: 200, body: { applied: false, reason: 'older' } });
    const user = await userDoc(UID);
    expect(user.billing.subscriptionStatus).toBe('past_due');
    expect(user.billing.eventAt).toBe(eventStamp(T0 + 200));
    expect(user.subscription.cancelsAt).toBeNull();
    // Recorded all the same, so a redelivery is a duplicate rather than a second look.
    expect(await eventRecord(older.id)).toBeDefined();
  });

  test("a renewal's `invoice.paid` landing after a newer snapshot still extends `expiresAt` to the paid year", async () => {
    await subscribed();
    const renewal = T0 + YEAR;
    const renewed = subscription('sub_1', { created: T0, periodStart: renewal });

    // The renewal's snapshot: the period has moved, the money has not come yet.
    await post(event('customer.subscription.updated', renewed, renewal));
    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(renewal + 3 * DAY));
    // A later snapshot (the card's details, say), applied before the invoice arrives.
    await post(event('customer.subscription.updated', renewed, renewal + 120));

    const paid = event('invoice.paid', invoice('in_2', { subscription: 'sub_1', periodStart: renewal }), renewal + 60);
    expect(await post(paid)).toEqual({ status: 200, body: { applied: true } });

    const user = await userDoc(UID);
    expect(millisOf(user.subscription.expiresAt)).toBe(msOf(renewal + YEAR));
    // The invoice neither moves the stamp nor is refused by it.
    expect(user.billing.eventAt).toBe(eventStamp(renewal + 120));
  });

  test("a former subscription's late `invoice.paid` does not revive it after a newer one was made and canceled", async () => {
    await subscribed('sub_old', T0);
    await post(
      event('customer.subscription.deleted', subscription('sub_old', { created: T0, status: 'canceled' }), T0 + DAY)
    );
    const back = T0 + 10 * DAY;
    await post(event('customer.subscription.created', subscription('sub_new', { created: back }), back));
    await post(
      event(
        'customer.subscription.deleted',
        subscription('sub_new', { created: back, status: 'canceled', canceledAt: back + DAY }),
        back + DAY
      )
    );
    const before = await userDoc(UID);
    expect(before.billing).toMatchObject({ subscriptionId: 'sub_new', subscriptionStatus: 'canceled' });

    // The first subscription's invoice, paid before any of that, delivered last.
    const late = event('invoice.paid', invoice('in_old', { subscription: 'sub_old', periodStart: T0 }), T0 + 60);
    expect(await post(late)).toEqual({ status: 200, body: { applied: false, reason: 'not followed' } });
    expect(await userDoc(UID)).toEqual(before);
  });

  test("a former subscription's late `invoice.paid` changes nothing while the document's own runs", async () => {
    await subscribed('sub_old', T0);
    await post(
      event('customer.subscription.deleted', subscription('sub_old', { created: T0, status: 'canceled' }), T0 + DAY)
    );
    const back = T0 + 10 * DAY;
    await post(event('customer.subscription.created', subscription('sub_new', { created: back }), back));
    const before = await userDoc(UID);

    const late = event('invoice.paid', invoice('in_old', { subscription: 'sub_old', periodStart: T0 }), back + 60);
    expect((await post(late)).body).toEqual({ applied: false, reason: 'not followed' });
    expect(await userDoc(UID)).toEqual(before);
  });
});

describe('refunds', () => {
  const REFUND_AT = T0 + 20 * DAY;
  const refunded = () => event('charge.refunded', charge('ch_1', { paymentIntent: 'pi_1' }), REFUND_AT);

  test('a refund cancels the subscription at Stripe and ends Pro at the refund', async () => {
    await subscribed();
    stripeHoldsRefundable();

    expect(await post(refunded())).toEqual({ status: 200, body: { applied: true } });

    expect(stripe.made('DELETE /v1/subscriptions/sub_1')).toHaveLength(1);
    const user = await userDoc(UID);
    expect(millisOf(user.subscription.expiresAt)).toBe(msOf(REFUND_AT));
    expect(user.subscription.status).toBe('canceled');
    expect(user.billing).toMatchObject({ subscriptionStatus: 'canceled', eventAt: eventStamp(REFUND_AT) });

    // The cancel's own event then lands, newer, and keeps the refund's end.
    const deleted = event(
      'customer.subscription.deleted',
      subscription('sub_1', { created: T0, status: 'canceled', canceledAt: REFUND_AT + 1 }),
      REFUND_AT + 1
    );
    expect((await post(deleted)).body).toEqual({ applied: true });
    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(REFUND_AT));
  });

  test('a refund ends Pro at the refund even when its `customer.subscription.deleted` was applied first', async () => {
    await subscribed();
    const stripeSide = stripeHoldsRefundable();
    // The cancel went through at Stripe on an earlier delivery whose answer was lost,
    // and its `customer.subscription.deleted` reached the document first.
    stripeSide.cancel();
    const deleted = event(
      'customer.subscription.deleted',
      subscription('sub_1', { created: T0, status: 'canceled', canceledAt: REFUND_AT + 1 }),
      REFUND_AT + 1
    );
    expect((await post(deleted)).body).toEqual({ applied: true });
    // Canceled, but Pro to the year's end: the snapshot carries no paid period.
    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(T0 + YEAR));

    expect(await post(refunded())).toEqual({ status: 200, body: { applied: true } });

    const user = await userDoc(UID);
    expect(millisOf(user.subscription.expiresAt)).toBe(msOf(REFUND_AT));
    expect(user.subscription.status).toBe('canceled');
    // The stamp only moves forward: the deleted event stays the newest.
    expect(user.billing.eventAt).toBe(eventStamp(REFUND_AT + 1));
    // Stripe refused the second cancel; the subscription read said it was done.
    expect(stripe.made('DELETE /v1/subscriptions/sub_1')).toHaveLength(1);
    expect(stripe.made('GET /v1/subscriptions/sub_1')).toHaveLength(1);
  });

  test('a cancel Stripe refuses is a 502 with nothing recorded, and the redelivery applies', async () => {
    await subscribed();
    stripeHoldsRefundable();
    stripe.route('DELETE /v1/subscriptions/sub_1', () => stripeRefusal(500, 'Stripe is having a moment'));
    const e = refunded();

    expect((await post(e)).status).toBe(502);
    expect(await eventRecord(e.id)).toBeUndefined();
    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(T0 + YEAR));

    stripeHoldsRefundable();
    expect((await post(e)).body).toEqual({ applied: true });
    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(REFUND_AT));
  });

  test('a dispute is read as a refund, through the charge it names', async () => {
    await subscribed();
    stripeHoldsRefundable();
    stripe.route('GET /v1/charges/ch_1', charge('ch_1', { paymentIntent: 'pi_1' }));
    const dispute = event(
      'charge.dispute.created',
      { id: 'dp_1', object: 'dispute', charge: 'ch_1', payment_intent: 'pi_1', amount: 2400, status: 'needs_response' },
      REFUND_AT
    );

    expect((await post(dispute)).body).toEqual({ applied: true });
    expect(stripe.made('DELETE /v1/subscriptions/sub_1')).toHaveLength(1);
    expect(millisOf((await userDoc(UID)).subscription.expiresAt)).toBe(msOf(REFUND_AT));
  });

  test("a refund of a charge that paid another subscription's invoice cancels nothing", async () => {
    await subscribed();
    stripeHoldsRefundable();
    stripe.route('GET /v1/invoices/in_1', invoice('in_1', { subscription: 'sub_other', periodStart: T0 }));
    const before = await userDoc(UID);

    expect((await post(refunded())).body).toEqual({ applied: false, reason: 'not followed' });
    expect(stripe.made('DELETE /v1/subscriptions/sub_1')).toHaveLength(0);
    expect(await userDoc(UID)).toEqual(before);
  });
});

describe('applyPatch', () => {
  const record = (eventId: string) => ({ eventId, type: 'test', occurredAt: eventStamp(T0) });
  const patch = (status: string, at: number) => () => ({
    billing: { subscriptionId: 'sub_1', subscriptionStatus: status, eventAt: eventStamp(at) },
  });

  beforeEach(() => seedCustomer(UID, CUSTOMER));

  test('merges the patch into the document and records the event once', async () => {
    expect((await applyPatch(db(), UID, patch('active', T0), {}, record('evt_a'))).outcome).toBe('written');
    expect((await userDoc(UID)).billing).toEqual({
      customerId: CUSTOMER,
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      eventAt: eventStamp(T0),
    });
    expect(await eventRecord('evt_a')).toMatchObject({ eventId: 'evt_a', userId: UID });

    expect((await applyPatch(db(), UID, patch('past_due', T0 + 1), {}, record('evt_a'))).outcome).toBe('duplicate');
    expect((await userDoc(UID)).billing.subscriptionStatus).toBe('active');
  });

  test('`notBefore` skips a patch older than the stamp, and lets an equal one through', async () => {
    await applyPatch(db(), UID, patch('active', T0 + 10), {});
    const older = await applyPatch(db(), UID, patch('past_due', T0 + 5), { notBefore: eventStamp(T0 + 5) });
    expect(older.outcome).toBe('older');
    const same = await applyPatch(db(), UID, patch('trialing', T0 + 10), { notBefore: eventStamp(T0 + 10) });
    expect(same.outcome).toBe('written');
    expect((await userDoc(UID)).billing.subscriptionStatus).toBe('trialing');
  });

  test('`onlyIfSubscription` skips a patch about a subscription the document no longer names', async () => {
    await applyPatch(db(), UID, patch('active', T0), {});
    const res = await applyPatch(db(), UID, patch('canceled', T0 + 1), { onlyIfSubscription: 'sub_0' });
    expect(res.outcome).toBe('other subscription');
    expect((await userDoc(UID)).billing.subscriptionStatus).toBe('active');
  });

  test('`advanceStamp` writes the patch but keeps a newer stamp', async () => {
    await applyPatch(db(), UID, patch('canceled', T0 + 100), {});
    await applyPatch(db(), UID, patch('canceled', T0 + 50), { advanceStamp: true });
    expect((await userDoc(UID)).billing.eventAt).toBe(eventStamp(T0 + 100));
    await applyPatch(db(), UID, patch('canceled', T0 + 150), { advanceStamp: true });
    expect((await userDoc(UID)).billing.eventAt).toBe(eventStamp(T0 + 150));
  });

  test('a null patch writes nothing but the record', async () => {
    const before = await userDoc(UID);
    expect((await applyPatch(db(), UID, () => null, {}, record('evt_n'))).outcome).toBe('nothing');
    expect(await userDoc(UID)).toEqual(before);
    expect(await eventRecord('evt_n')).toBeDefined();
  });

  test('the patch is made from the document as the transaction reads it', async () => {
    // Two writers at once, each adding to what it read: both land only if each patch
    // was worked out inside its own transaction, retried on contention.
    const bump = (user: { billing?: { eventAt?: string | null } } | undefined) => ({
      billing: { eventAt: String(Number(user?.billing?.eventAt ?? '0') + 1) },
    });
    await Promise.all(Array.from({ length: 5 }, () => applyPatch(db(), UID, bump, {})));
    expect((await userDoc(UID)).billing.eventAt).toBe('5');
  });
});
