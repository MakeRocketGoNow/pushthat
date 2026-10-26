import { getAuth } from 'firebase-admin/auth';
import { DocumentReference, Firestore, getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { defineSecret } from 'firebase-functions/params';
import { CallableRequest, HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';

import { PlanUser, canSubscribe, compRunning, planReportOf } from './plan';
import {
  ENDED_SUBSCRIPTION,
  StripeCharge,
  StripeConfig,
  StripeDispute,
  StripeError,
  StripeInvoice,
  createCustomer,
  ensureSubscriptionCanceled,
  expireOpenCheckouts,
  getCharge,
  getInvoice,
  getSubscription,
  invoicesOfPayment,
  newestSubscription,
  createCheckoutSession as stripeCheckout,
  stripeOf,
  createPortalSession as stripePortal,
  subscriptionsOf,
  verifyWebhookSignature,
  webhookSourceOf,
} from './stripe';
import {
  PlanPatch,
  REFUND_EVENTS,
  RefundEffect,
  StripeEvent,
  eventStamp,
  invoiceSubscriptionOf,
  planPatchFor,
  refundEffectOf,
  refundPatchFor,
} from './stripe-events';

/**
 * Billing (docs/billing.md): the checkout and the portal that change an account's
 * plan, Stripe's webhook, which is how the change comes back, and a read of the
 * subscription for the page that cannot wait for it. The same design as Unbent's
 * `routes/billing.ts`, on Firestore and Cloud Functions.
 *
 * The three settings are secrets, and billing is on only when all three are set
 * (`stripeOf`): with any missing, the callables refuse and the webhook answers 404,
 * which is the emulator's case, since a deploy refuses a function whose secret does
 * not exist. The
 * three come from one Stripe environment together, sandbox or live, since the key
 * picks the account checkouts are made in, the webhook secret verifies only that
 * account's endpoint, and the price must be a price in it.
 *
 * On `users/{uid}`, `subscription` is what the Firestore rules read to pick the
 * account's limits and `billing` is how the webhook finds and orders its events
 * (`PlanUser` in plan.ts). `stripeCustomers/{customerId}` names the account a customer
 * belongs to, written before the first checkout opens so the first event can find it,
 * and `billingEvents/{eventId}` records each event once.
 */

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');
const STRIPE_PRO_PRICE_ID = defineSecret('STRIPE_PRO_PRICE_ID');
const secrets = [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRO_PRICE_ID];

/** Where the checkout and the portal come back to. The emulator may point it elsewhere. */
const APP_URL = (process.env.APP_URL || 'https://pushthat.link').replace(/\/$/, '');

function planPageUrl(query?: string): string {
  return `${APP_URL}/plan${query ? `?${query}` : ''}`;
}

function stripeConfig(): StripeConfig | undefined {
  return stripeOf({
    STRIPE_SECRET_KEY: STRIPE_SECRET_KEY.value(),
    STRIPE_WEBHOOK_SECRET: STRIPE_WEBHOOK_SECRET.value(),
    STRIPE_PRO_PRICE_ID: STRIPE_PRO_PRICE_ID.value(),
    STRIPE_API_URL: process.env.STRIPE_API_URL,
  });
}

/** The signed-in account, or the refusal a callable gives without one. */
function uidOf(request: CallableRequest): string {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  return request.auth.uid;
}

/** Billing on, or the refusal a callable gives while it is off. */
function stripeOrRefuse(): StripeConfig {
  const stripe = stripeConfig();
  if (!stripe) throw new HttpsError('failed-precondition', 'There is no plan to sell right now.');
  return stripe;
}

/**
 * A refusal from Stripe is `unavailable` with Stripe's own words, not `internal`: the
 * request was sound and the fault is on the other side of a network, which is the one
 * thing the person can do something about: try again. Logged with the account, since
 * the message the page shows says nothing about which call it was.
 */
function stripeRefused(err: unknown, what: string, userId: string): never {
  if (!(err instanceof StripeError)) throw err;
  logger.error(`[billing] ${what} for user=${userId} refused: ${err.message}`);
  throw new HttpsError('unavailable', `Stripe could not ${what} right now. Try again shortly.`);
}

/** How long an event's record is kept: well past the three days Stripe retries a delivery for. */
const EVENT_RECORD_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ALREADY_SUBSCRIBED = 'This account already has a subscription. Manage it from the billing portal.';

const userRef = (db: Firestore, uid: string): DocumentReference => db.collection('users').doc(uid);
const customerRef = (db: Firestore, customerId: string): DocumentReference =>
  db.collection('stripeCustomers').doc(customerId);
const eventRef = (db: Firestore, eventId: string): DocumentReference => db.collection('billingEvents').doc(eventId);

async function readUser(db: Firestore, uid: string): Promise<PlanUser | undefined> {
  return (await userRef(db, uid).get()).data() as PlanUser | undefined;
}

/**
 * The email the Stripe customer is made with: the sign-in's, else the document's, else
 * the Auth record's. An account always has one here, since the apps and the web sign
 * up with email and password.
 */
async function emailOf(request: CallableRequest, user: PlanUser | undefined): Promise<string> {
  const fromToken = request.auth?.token.email;
  if (typeof fromToken === 'string' && fromToken) return fromToken;
  const fromDoc = (user as { email?: unknown } | undefined)?.email;
  if (typeof fromDoc === 'string' && fromDoc) return fromDoc;
  const record = await getAuth().getUser(request.auth!.uid);
  if (!record.email) throw new HttpsError('failed-precondition', 'This account has no email address to bill.');
  return record.email;
}

type PatchOutcome = 'written' | 'older' | 'other subscription' | 'duplicate' | 'nothing';

/**
 * Writes the patch `patchOf` makes for the account, guarded the way the webhook needs:
 * `notBefore` skips it when the document's newest event is after this one,
 * `onlyIfSubscription` skips it when the document no longer names the subscription it
 * is about, and `advanceStamp` moves `billing.eventAt` forward only (a refund's cancel
 * is stamped with the refund, which can be older than the `customer.subscription.deleted`
 * it caused). The patch is worked out from the document as the transaction reads it,
 * never from a read taken before: a patch made from an older copy would carry that
 * copy's end date past a refund's cancel that landed in between, since `planPatchFor`
 * keeps the held date on a canceled snapshot. The event's record goes in the same
 * transaction, so a record with no change behind it cannot happen, and a duplicate
 * delivery racing this one finds the record and writes nothing. Returns whether the
 * patch was written, and why not, with the patch for the log. Exported for the emulator
 * tests (test/emulator).
 */
export async function applyPatch(
  db: Firestore,
  uid: string,
  patchOf: (user: PlanUser | undefined) => PlanPatch | null,
  opts: { notBefore?: string; onlyIfSubscription?: string; advanceStamp?: boolean },
  record?: { eventId: string; type: string; occurredAt: string }
): Promise<{ outcome: PatchOutcome; patch: PlanPatch | null }> {
  return db.runTransaction(async (tx) => {
    const ref = userRef(db, uid);
    const user = (await tx.get(ref)).data() as PlanUser | undefined;
    if (record) {
      const seen = await tx.get(eventRef(db, record.eventId));
      if (seen.exists) return { outcome: 'duplicate', patch: null };
      // `expireAt` is for a Firestore TTL policy on the collection (docs/billing.md):
      // a record only has to outlive Stripe's three days of retries.
      tx.set(eventRef(db, record.eventId), {
        ...record,
        userId: uid,
        receivedAt: new Date(),
        expireAt: new Date(Date.now() + EVENT_RECORD_TTL_MS),
      });
    }
    const patch = patchOf(user);
    if (!patch) return { outcome: 'nothing', patch };
    const stamp = user?.billing?.eventAt ?? null;
    if (opts.notBefore && stamp && stamp > opts.notBefore) return { outcome: 'older', patch };
    if (opts.onlyIfSubscription && user?.billing?.subscriptionId !== opts.onlyIfSubscription)
      return { outcome: 'other subscription', patch };
    const billing = { ...patch.billing };
    if (opts.advanceStamp && stamp && billing.eventAt && stamp > billing.eventAt) billing.eventAt = stamp;
    tx.set(
      ref,
      { ...(patch.subscription ? { subscription: patch.subscription } : {}), ...(patch.billing ? { billing } : {}) },
      { merge: true }
    );
    return { outcome: 'written', patch };
  });
}

/**
 * The account's plan for the Plan page and the apps: the tier, this period's usage
 * against its limits, and the subscription as the webhook last wrote it. Worked out
 * here, from the user document, so every client shows the same numbers and none of
 * them carries the period arithmetic. Reads nothing from Stripe, so it needs no secret
 * and answers the same with billing off.
 */
export const getPlan = onCall({ cors: true }, async (request) =>
  planReportOf(await readUser(getFirestore(), uidOf(request)), new Date())
);

/**
 * A checkout for the page to send the person to. The answer is the address of Stripe's
 * hosted page; the page redirects there, and Stripe sends the person back to the Plan
 * page with `?checkout=complete` once paid, or without it from the back button. The
 * account's customer is ours before the session is made, so the document and
 * `stripeCustomers` hold Stripe's id by the time the first event names it, and the
 * page never learns a price id.
 *
 * Only for an account with no subscription: one that has one changes it through the
 * portal, and a second checkout would be a second subscription for one account. A
 * lapsed subscription (`canceled`, its period over) is the one case a new checkout is
 * right for, since Stripe does not revive a canceled subscription. A running comp is
 * refused too: the webhook would ignore the subscription's events and the person
 * would be charged for a plan the document never took.
 */
export const createCheckoutSession = onCall({ cors: true, secrets }, async (request) => {
  const stripe = stripeOrRefuse();
  const uid = uidOf(request);
  const db = getFirestore();
  const now = new Date();
  const user = await readUser(db, uid);
  const billing = user?.billing;
  // The comp first, so it gets its own sentence; then the one test the report's
  // `canSubscribe` is drawn from, so the page and the callable cannot drift.
  if (compRunning(user?.subscription, now)) {
    throw new HttpsError('failed-precondition', 'This account is complimentary; there is nothing to pay for.');
  }
  if (!canSubscribe(user, now)) throw new HttpsError('already-exists', ALREADY_SUBSCRIBED);
  try {
    let customerId = billing?.customerId;
    if (!customerId) {
      customerId = (await createCustomer(stripe, await emailOf(request, user), uid)).id;
      const batch = db.batch();
      batch.set(userRef(db, uid), { billing: { customerId } }, { merge: true });
      batch.set(customerRef(db, customerId), { userId: uid, createdAt: now });
      await batch.commit();
    }
    // Asked even of a customer made a moment ago: a second tab's press gets the same one.
    await expireOpenCheckouts(stripe, customerId);
    // The document hears of a paid checkout's subscription only by webhook, so in that
    // lag a second tab still showing Subscribe, or Back from Stripe's success page,
    // would pass the check above. Stripe is asked too, after expiring sessions, so a
    // payment that completed while those were being closed is still seen.
    const subs = await subscriptionsOf(stripe, customerId);
    if (subs.some((sub) => !ENDED_SUBSCRIPTION.has(sub.status))) {
      throw new HttpsError('already-exists', ALREADY_SUBSCRIBED);
    }
    const session = await stripeCheckout(stripe, {
      customerId,
      userId: uid,
      successUrl: planPageUrl('checkout=complete'),
      cancelUrl: planPageUrl(),
    });
    if (!session.url) throw new StripeError(502, null, 'the checkout session has no address');
    return { url: session.url };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    return stripeRefused(err, 'start the checkout', uid);
  }
});

/**
 * A link into Stripe's customer portal, where the person sees their invoices, changes
 * the card and cancels. A fresh session per press, since each link is short-lived.
 * `flow: 'payment'` opens it on the card form; the portal comes back to the Plan page.
 */
export const createPortalSession = onCall({ cors: true, secrets }, async (request) => {
  const stripe = stripeOrRefuse();
  const uid = uidOf(request);
  const user = await readUser(getFirestore(), uid);
  const customerId = user?.billing?.customerId;
  if (!customerId)
    throw new HttpsError('failed-precondition', 'Nothing to manage yet: this account has never subscribed.');
  const flow =
    (request.data as { flow?: unknown } | undefined)?.flow === 'payment' ? 'payment_method_update' : undefined;
  try {
    const session = await stripePortal(stripe, customerId, planPageUrl(), flow);
    return { url: session.url };
  } catch (err) {
    return stripeRefused(err, 'open the billing portal', uid);
  }
});

/**
 * A read of the subscription as Stripe has it now, applied to the document as an event
 * would be, and the plan as it then stands. For the page after a checkout or a portal
 * visit: the webhook usually lands within seconds, but a page that re-reads its plan
 * before it has would say the old thing. Also the way back when a webhook was lost for
 * longer than Stripe retries, and the only way at all on the emulator without the CLI
 * forwarding. Writes nothing for an account with no customer.
 *
 * The subscription read is the document's own while it is not canceled, else the
 * customer's newest: a document with none yet and one naming a canceled subscription
 * both find the new one this way. Stamped with the clock, which is safe because the
 * read is of the newest subscription: its events describe nothing the read did not
 * already reflect, and an event a second after the read still applies.
 */
export const refreshSubscription = onCall({ cors: true, secrets }, async (request) => {
  const uid = uidOf(request);
  const db = getFirestore();
  const now = new Date();
  const stripe = stripeConfig();
  const user = await readUser(db, uid);
  const customerId = user?.billing?.customerId;
  if (!stripe || !customerId) return planReportOf(user, now);
  try {
    const sub =
      user?.billing?.subscriptionId && user.billing.subscriptionStatus !== 'canceled'
        ? await getSubscription(stripe, user.billing.subscriptionId, { expandLatestInvoice: true })
        : await newestSubscription(stripe, customerId);
    // A canceled subscription is applied only when it is the document's own: that is
    // how a lost `customer.subscription.deleted` is repaired, and without it the
    // document would say `active` for good and the checkout refuse a new subscription.
    // A canceled one that is not the document's is nothing to it.
    const own = sub !== null && sub.id === user?.billing?.subscriptionId;
    if (sub && (sub.status !== 'canceled' || own)) {
      const created = Math.floor(now.getTime() / 1000);
      const event: StripeEvent = {
        id: `read-${created}`,
        type: 'customer.subscription.updated',
        created,
        data: { object: sub },
      };
      await applyPatch(db, uid, (fresh) => planPatchFor(event, fresh), { notBefore: eventStamp(created) });
      // The snapshot grants a renewal only its grace; the paid invoice is what gives the
      // year, and a lost `invoice.paid` is repaired here from the invoice the
      // subscription carries, applied as the webhook would apply it.
      const invoice = sub.latest_invoice;
      if (
        invoice &&
        typeof invoice === 'object' &&
        invoice.status === 'paid' &&
        invoiceSubscriptionOf(invoice) === sub.id
      ) {
        const paid: StripeEvent = {
          id: `read-invoice-${created}`,
          type: 'invoice.paid',
          created,
          data: { object: invoice },
        };
        await applyPatch(db, uid, (fresh) => planPatchFor(paid, fresh), {});
      }
    }
    return planReportOf(await readUser(db, uid), now);
  } catch (err) {
    return stripeRefused(err, 'read the subscription', uid);
  }
});

/**
 * The invoice a refunded or disputed charge paid, for the refund rules. Since
 * 2025-03-31.basil a charge names no invoice; the way back is its payment intent, the
 * list of invoice payments that intent made, and the first invoice among them that
 * bills a subscription. Null for a charge that paid none.
 */
async function invoiceOfCharge(stripe: StripeConfig, paymentIntentId: string | null): Promise<StripeInvoice | null> {
  if (!paymentIntentId) return null;
  for (const invoiceId of (await invoicesOfPayment(stripe, paymentIntentId)).slice(0, 3)) {
    const invoice = await getInvoice(stripe, invoiceId);
    if (invoiceSubscriptionOf(invoice)) return invoice;
  }
  return null;
}

/**
 * The sender's address as Google's front end delivers it: the last hop of
 * `X-Forwarded-For`. The front end keeps whatever the caller sent in that header and
 * appends the address it saw, so the first hop is the caller's to choose and only the
 * last is observed. True of a function reached at its `cloudfunctions.net` address,
 * with nothing in front of it; a load balancer put in front later would append its own
 * address after the client's, and this would then need the one before last.
 */
function senderOf(headers: Record<string, string | string[] | undefined>, fallback?: string): string | undefined {
  const forwarded = headers['x-forwarded-for'];
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? ''))
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] || fallback;
}

/**
 * Stripe's webhook: what happened to a subscription, signed with the endpoint's
 * secret. No session (Stripe sends none), so the signature is the authority, and the
 * raw body is what it signs, read before anything parses it. Before either, the
 * sender's address must be one Stripe publishes (`webhookSourceOf`): a 403 for any
 * other, and a 503 when Stripe's list cannot be read, which Stripe retries.
 *
 * Two answers for a sound event: 200 having applied it, or 200 having found nothing to
 * apply: an event already applied by id (Stripe retries anything not answered 2xx, for
 * three days), a customer no account holds (a checkout from the dashboard, a test from
 * the CLI), or a type the rules do not follow. All 200, since a 4xx would be retried
 * until Stripe gave up and then listed as failed; the log line says which it was. A
 * bad signature is 401 and a body that is not an event is 400, both worth seeing fail.
 *
 * A refund is one of two events that act on Stripe rather than only on the document
 * (the other is a new subscription, which ends the customer's other open checkouts):
 * the subscription is cancelled before anything is recorded, so a call Stripe refuses
 * or does not answer is a 502 and the event is delivered again. Once the call is
 * through, the document is written as the cancel will leave it. That cancel's
 * `customer.subscription.deleted` often lands first, and `planPatchFor` keeps
 * `expiresAt` as the year's end on a canceled snapshot (a cancel at the period's end
 * must), so `notBefore` would skip the refund's patch and leave a refunded account Pro
 * until that date. A refund cancel therefore writes without `notBefore`, scoped to the
 * subscription it named, and only advances the stamp.
 */
export const stripeWebhook = onRequest({ cors: false, secrets }, async (req, res) => {
  const stripe = stripeConfig();
  if (!stripe) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const address = senderOf(req.headers, req.ip);
  const source = await webhookSourceOf(address, process.env.FUNCTIONS_EMULATOR === 'true');
  if (source === 'unknown') {
    res.status(503).json({ error: 'Stripe addresses unavailable; deliver again' });
    return;
  }
  if (source === 'refused') {
    logger.warn(`[billing] webhook from ${address ?? 'no address'} refused: not one of Stripe's`);
    res.status(403).json({ error: 'Not from Stripe' });
    return;
  }
  const raw = req.rawBody;
  const signature = req.headers['stripe-signature'];
  if (!raw || !verifyWebhookSignature(stripe.webhookSecret, Array.isArray(signature) ? signature[0] : signature, raw)) {
    res.status(401).json({ error: 'Bad signature' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Not JSON' });
    return;
  }
  const event = parsed as Partial<StripeEvent> | null;
  const object = event?.data?.object as { customer?: unknown } | undefined;
  if (
    !event ||
    typeof event.id !== 'string' ||
    typeof event.type !== 'string' ||
    typeof event.created !== 'number' ||
    !object
  ) {
    res.status(400).json({ error: 'Not a Stripe event' });
    return;
  }
  const { id, type, created } = event;
  const occurredAt = eventStamp(created);
  const db = getFirestore();

  if ((await eventRef(db, id).get()).exists) {
    logger.info(`[billing] ${type} ${id} already applied`);
    res.json({ applied: false, reason: 'duplicate' });
    return;
  }
  // A dispute names its charge and no customer; the charge has both the customer and
  // the payment intent the refund rules will need.
  let charge: StripeCharge | undefined;
  let customerId = typeof object.customer === 'string' ? object.customer : null;
  if (type === 'charge.dispute.created') {
    try {
      charge = await getCharge(stripe, (object as unknown as StripeDispute).charge);
    } catch (err) {
      logger.error(`[billing] read the disputed charge of ${id} refused: ${(err as Error).message}`);
      res.status(502).json({ error: 'Stripe could not be read; deliver again' });
      return;
    }
    customerId = charge.customer;
  } else if (type === 'charge.refunded') {
    charge = object as unknown as StripeCharge;
  }
  const owner = customerId ? (await customerRef(db, customerId).get()).data() : undefined;
  const uid = typeof owner?.userId === 'string' ? owner.userId : null;
  if (!uid) {
    logger.info(`[billing] ${type} ${id} names no account (customer ${customerId ?? 'none'})`);
    res.json({ applied: false, reason: 'no account' });
    return;
  }
  // A subscription made is a checkout paid, so any other checkout of the customer's
  // that is still open is a second subscription waiting to happen. Ended here, before
  // anything is recorded, so a refused call is a 502 and the event is delivered again.
  if (type === 'customer.subscription.created') {
    try {
      await expireOpenCheckouts(stripe, customerId!);
    } catch (err) {
      logger.error(`[billing] end the other checkouts after ${id} for user=${uid} refused: ${(err as Error).message}`);
      res.status(502).json({ error: 'Stripe could not be reached; deliver again' });
      return;
    }
  }
  // This read decides what to ask of Stripe for a refund; the patch itself is made from
  // the document as `applyPatch`'s transaction reads it.
  const user = await readUser(db, uid);
  const stripeEvent = event as StripeEvent;
  let effect: RefundEffect | null = null;
  if (REFUND_EVENTS.has(type)) {
    effect = refundEffectOf(stripeEvent, user);
    try {
      if (effect === 'needs-invoice') {
        effect = refundEffectOf(stripeEvent, user, await invoiceOfCharge(stripe, charge?.payment_intent ?? null));
      }
      if (effect === 'cancel') await ensureSubscriptionCanceled(stripe, user!.billing!.subscriptionId!);
    } catch (err) {
      logger.error(`[billing] act on the refund ${id} for user=${uid} refused: ${(err as Error).message}`);
      res.status(502).json({ error: 'Stripe could not be reached; deliver again' });
      return;
    }
    if (effect === 'cancel') logger.info(`[billing] ${type} ${id} for user=${uid}: refund, subscription cancelled`);
  }
  const refundCancel = effect === 'cancel';
  // A paid invoice is applied without the stamp: it only ever extends, and a renewal's
  // invoice delivered after a newer snapshot or a refresh is the one thing that can
  // give the paid year (`planPatchFor`).
  const writeOpts = refundCancel
    ? { onlyIfSubscription: user!.billing!.subscriptionId!, advanceStamp: true }
    : type === 'invoice.paid'
      ? {}
      : { notBefore: occurredAt };
  const patchOf = refundCancel
    ? () => refundPatchFor(stripeEvent)
    : (fresh: PlanUser | undefined) => planPatchFor(stripeEvent, fresh);
  const { outcome, patch } = await applyPatch(db, uid, patchOf, writeOpts, { eventId: id, type, occurredAt });
  if (outcome === 'written') {
    logger.info(
      `[billing] ${type} ${id} for user=${uid}: ${patch?.billing?.subscriptionStatus ?? 'invoice'} until ${patch?.subscription?.expiresAt?.toDate().toISOString() ?? 'as before'}`
    );
    res.json({ applied: true });
    return;
  }
  const why =
    outcome === 'older'
      ? "older than the document's newest event"
      : outcome === 'other subscription'
        ? 'the document no longer names the refunded subscription'
        : outcome === 'duplicate'
          ? 'already applied'
          : 'nothing to apply';
  logger.info(`[billing] ${type} ${id} for user=${uid}: skipped, ${why}`);
  res.json({ applied: false, reason: outcome === 'nothing' ? 'not followed' : outcome });
});
