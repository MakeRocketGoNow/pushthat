import { Timestamp } from 'firebase-admin/firestore';

import { Billing, PlanUser, Subscription, compRunning } from './plan';
import { StripeCharge, StripeDispute, StripeInvoice, StripeSubscription, periodEndOf, periodStartOf } from './stripe';

/**
 * What a Stripe event does to a user document: the pure half of the webhook, so the
 * rules are tested without a request or a database. A port of Unbent's
 * `lib/billing-events.ts` without the storage add-on. The webhook (stripe-functions.ts)
 * finds the account by the event's customer id, asks this for the patch, and writes it.
 *
 * Every patch is absolute (the status and the end date as they stand), never an
 * increment, so an event applied twice lands as it landed once. Stripe promises
 * delivery, not order, and retries for three days anything not answered 2xx; the
 * webhook refuses an event it has seen by id and `billing.eventAt` keeps an older
 * event from writing over a newer one, so a delivery can be late or repeated and the
 * document still ends where the newest event put it. The one exception is a refund's
 * cancel, which ends the period even under the newer stamp its own
 * `customer.subscription.deleted` left (`refundPatchFor`, and the webhook's comment).
 *
 * Stripe stamps an event with `created` in whole seconds, so two events in the same
 * second order as equals and both apply (`notBefore` is "not after"); the snapshots a
 * checkout fires in one second agree with each other, and an event a second later
 * still wins.
 */

export interface StripeEvent {
  id: string;
  type: string;
  /** When it happened, unix seconds. */
  created: number;
  data: { object: StripeSubscription | StripeInvoice | StripeCharge | StripeDispute };
}

/** The change to write on `users/{uid}`, merged into the document. */
export interface PlanPatch {
  subscription?: Partial<Subscription>;
  billing?: Partial<Billing>;
}

/** An event's time as the document keeps and compares it: ISO 8601 at millisecond precision. */
export function eventStamp(created: number): string {
  return new Date(created * 1000).toISOString();
}

/** The subscription events the document follows. The rest (`customer.subscription.trial_will_end`, say) are ignored by name. */
export const SUBSCRIPTION_EVENTS: ReadonlySet<string> = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

/**
 * The events a refund arrives on. `charge.refunded` is a refund that went through,
 * whoever made it: the operator from the dashboard, or Stripe itself, which under
 * Managed Payments may refund a buyer within sixty days without asking. A
 * `charge.dispute.created` is the card issuer's refund, and is read as one.
 */
export const REFUND_EVENTS: ReadonlySet<string> = new Set(['charge.refunded', 'charge.dispute.created']);

/** Which events the endpoint is asked for, for the setup notes. */
export const HANDLED_EVENTS: readonly string[] = [...SUBSCRIPTION_EVENTS, 'invoice.paid', ...REFUND_EVENTS];

/**
 * How far past its last paid period a renewing subscription stays Pro before the
 * renewal's invoice is paid. Stripe moves a subscription's period forward the moment
 * it renews and sends `customer.subscription.updated` with `status: 'active'`, then
 * finalizes and charges the invoice about an hour later; a snapshot alone is no proof
 * the year was paid for, and a card that then fails would have kept Pro for the whole
 * of it. So a subscription event extends an existing subscription by this much at most,
 * from the new period's start, and only `invoice.paid` extends it to the period's end.
 * Three days covers the hour, and Stripe's first retries, at the cost of three days of
 * Pro for a renewal that never pays.
 */
export const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether news of `subscriptionId` is the document's to take: it names the document's subscription, or the document's is canceled or none. */
function theirs(billing: Billing | undefined, subscriptionId: string): boolean {
  return (
    !billing?.subscriptionId || billing.subscriptionStatus === 'canceled' || billing.subscriptionId === subscriptionId
  );
}

/** The subscription an invoice bills, since 2025-03-31.basil under `parent`; null for an invoice that bills none. */
export function invoiceSubscriptionOf(invoice: StripeInvoice): string | null {
  return invoice.parent?.type === 'subscription_details'
    ? (invoice.parent.subscription_details?.subscription ?? null)
    : null;
}

const millis = (t: Timestamp | null | undefined): number | null => (t instanceof Timestamp ? t.toMillis() : null);

/**
 * The patch for `event` on `user`, or null for an event that changes nothing here.
 *
 * A subscription event carries the whole subscription, so the document is written from
 * it whole: Stripe's status, the end of the period paid for, and a cancellation asked
 * for ahead. The account is Pro for as long as `expiresAt` is ahead of the clock. Only
 * an event whose subscription is `active` or `trialing` moves that date, since only
 * those name a period that has been paid for: a `past_due` or `unpaid` subscription's
 * current period is the one whose renewal failed, and a `canceled` one is over. For
 * those the end date the document already holds stands, which is the end of the last
 * period paid for; a document that never had one ends at the event. An `incomplete`
 * subscription, whose first payment has not gone through, changes nothing.
 *
 * A new subscription (the first checkout, whose first invoice Checkout collected before
 * it was made) takes the period's end outright. One the document already holds takes
 * it only as far as `RENEWAL_GRACE_MS` past the new period's start, and never less
 * than it holds: a renewal's snapshot arrives before its invoice is paid, and the paid
 * invoice is what extends the year (`invoice.paid` below). From the period's start
 * rather than from what the document holds, so a second snapshot in the same unpaid
 * period cannot add another grace.
 *
 * `startedAt` anchors the month the usage is counted in (`getBillingPeriodKey`), so it
 * is set once per subscription, from its creation, and kept across its later events;
 * a new subscription (a lapsed subscriber coming back) starts a new anchor.
 *
 * A paid invoice is the other way the first checkout reaches the document: Stripe
 * sends it and `customer.subscription.created` for the same moment in no promised
 * order, so either makes the account Pro with the period the invoice's lines cover.
 * And since a renewal's snapshot grants only the grace, a paid invoice is the one
 * thing that extends a subscription the document holds. For that it is applied
 * without the stamp, both ways: it neither moves `billing.eventAt` (a subscription
 * event stamped the second before would be refused as older) nor is refused by it (a
 * snapshot or a refresh stamped after the invoice was paid would drop it, and nothing
 * could bring it back). That is safe because the patch only ever moves `expiresAt`
 * forward and does nothing to a subscription the document holds as canceled.
 *
 * Two events change nothing however new they are: one about a subscription that is
 * not the document's while its own is live (a former subscription's late news), and
 * any event while the account is comped, since a comp is the operator's word that the
 * account is not Stripe's to move. Once the comp has ended the account is Free like
 * any other, and a new subscription's events are its way to Pro.
 */
export function planPatchFor(event: StripeEvent, user: PlanUser | undefined): PlanPatch | null {
  const at = event.created * 1000;
  const now = new Date(at);
  if (compRunning(user?.subscription, now)) return null;
  const billing = user?.billing;
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const sub = event.data.object as StripeSubscription;
    if (!theirs(billing, sub.id)) return null;
    if (sub.status === 'incomplete' || sub.status === 'incomplete_expired') return null;
    const sameSubscription = billing?.subscriptionId === sub.id;
    const paidFor = sub.status === 'active' || sub.status === 'trialing';
    const periodEndSeconds = paidFor ? periodEndOf(sub) : null;
    const periodEnd = periodEndSeconds === null ? null : periodEndSeconds * 1000;
    const periodStartSeconds = periodStartOf(sub);
    const held = millis(user?.subscription?.expiresAt);
    const expiresAt =
      periodEnd === null
        ? (held ?? at)
        : !sameSubscription || held === null
          ? periodEnd
          : Math.max(
              held,
              Math.min(periodEnd, (periodStartSeconds === null ? at : periodStartSeconds * 1000) + RENEWAL_GRACE_MS)
            );
    // A cancellation ahead while the subscription still runs: a dated one, or the
    // period's end when it is to cancel there. Nothing once it has taken effect.
    const cancelsAt =
      sub.status === 'canceled'
        ? null
        : sub.cancel_at !== null
          ? sub.cancel_at * 1000
          : sub.cancel_at_period_end
            ? periodEnd
            : null;
    const startedAt =
      sameSubscription && user?.subscription?.startedAt instanceof Timestamp
        ? user.subscription.startedAt
        : Timestamp.fromMillis(sub.created * 1000);
    return {
      subscription: {
        type: 'pro',
        interval: 'yearly',
        startedAt,
        expiresAt: Timestamp.fromMillis(expiresAt),
        status: sub.status,
        cancelsAt: cancelsAt === null ? null : Timestamp.fromMillis(cancelsAt),
        canceledAt: sub.canceled_at === null ? null : Timestamp.fromMillis(sub.canceled_at * 1000),
      },
      billing: { subscriptionId: sub.id, subscriptionStatus: sub.status, eventAt: eventStamp(event.created) },
    };
  }
  if (event.type === 'invoice.paid') {
    const invoice = event.data.object as StripeInvoice;
    const subscriptionId = invoiceSubscriptionOf(invoice);
    if (!subscriptionId || !theirs(billing, subscriptionId)) return null;
    // The document holds this subscription as canceled: a refund's cancel, which its
    // invoice arriving late must not undo. (A lapse is the same status with its period
    // over, and a paid invoice for it cannot arrive, since Stripe collects nothing on a
    // canceled subscription.)
    if (billing?.subscriptionId === subscriptionId && billing.subscriptionStatus === 'canceled') return null;
    const ends = invoice.lines.data.map((l) => l.period.end).filter((n) => typeof n === 'number');
    const periodEnd = ends.length ? Math.max(...ends) * 1000 : null;
    const newSubscription = subscriptionId !== billing?.subscriptionId;
    // Adopting a subscription the document does not name is not an extension, so the
    // stamp's order is kept for it: a former subscription's invoice, delivered late
    // after a newer one was made and canceled, must not revive it. `<`, not `<=`, so
    // the first checkout's invoice and snapshot, stamped the same second, both land.
    if (newSubscription && billing?.eventAt && eventStamp(event.created) < billing.eventAt) return null;
    // Extend only, never back: that is what lets the webhook apply an invoice without
    // the stamp, so one delivered after a newer snapshot or a refresh still lands.
    const held = millis(user?.subscription?.expiresAt) ?? 0;
    return {
      subscription: {
        type: 'pro',
        interval: 'yearly',
        ...(periodEnd !== null ? { expiresAt: Timestamp.fromMillis(Math.max(periodEnd, held)) } : {}),
        ...(newSubscription
          ? { startedAt: Timestamp.fromMillis(at), status: 'active', cancelsAt: null, canceledAt: null }
          : {}),
      },
      ...(newSubscription ? { billing: { subscriptionId, subscriptionStatus: 'active' } } : {}),
    };
  }
  return null;
}

/**
 * What a refund does to the subscription it was for: the terms say a refunded plan is
 * cancelled and does not renew, and nothing in Stripe keeps that: a refund there is
 * money back on a charge, and the subscription the charge paid for stays active and
 * renews at the period's end. So the webhook ends it.
 *
 * `cancel` is any refund of an invoice that billed the document's subscription: the
 * subscription is cancelled at once and the account turns Free from the refund, not
 * from the period's end, since the period was given back. A chargeback is the card
 * issuer's refund and is read as one, whatever its amount. `needs-invoice` is a refund
 * whose invoice has not been read yet; the caller finds it through the charge's
 * payment intent (`invoicesOfPayment`) and asks again with it, since the charge itself
 * names no subscription on this API version.
 *
 * Nothing for a refund of a charge that paid no invoice, for one whose invoice bills a
 * subscription that is not the document's, for one whose subscription the document
 * holds as canceled with its period already ended by the refund (which is how a
 * second delivery finds nothing left to do), or while the account is comped.
 *
 * Canceled alone is not enough to call a refund done: the cancel can go through at
 * Stripe and its answer be lost, so nothing is written here, and
 * `customer.subscription.deleted` then lands and leaves the year's end on the
 * document; the refund's redelivery is what has to end it. Only a period that already
 * ends by the refund says the patch is on the document.
 */
export type RefundEffect = 'cancel' | 'needs-invoice';

export function refundEffectOf(
  event: StripeEvent,
  user: PlanUser | undefined,
  invoice?: StripeInvoice | null
): RefundEffect | null {
  if (!REFUND_EVENTS.has(event.type)) return null;
  const at = event.created * 1000;
  if (compRunning(user?.subscription, new Date(at))) return null;
  const billing = user?.billing;
  if (!billing?.subscriptionId) return null;
  const canceled = billing.subscriptionStatus === 'canceled';
  const expiresAt = millis(user?.subscription?.expiresAt);
  if (canceled && (expiresAt === null || expiresAt <= at)) return null;
  if (event.type === 'charge.refunded' && (event.data.object as StripeCharge).amount_refunded <= 0) return null;
  if (invoice === undefined) return 'needs-invoice';
  if (invoice === null || invoiceSubscriptionOf(invoice) !== billing.subscriptionId) return null;
  return 'cancel';
}

/**
 * The document after a refund's cancel has gone through at Stripe: the plan ends at
 * the refund (`expiresAt` at the event, and the status Stripe will confirm), so the
 * `customer.subscription.deleted` that follows, which carries no paid period, keeps
 * that date rather than the year's end the document held. Stamped with the refund's
 * time: the cancel it caused happened after it, so the confirming event still applies.
 */
export function refundPatchFor(event: StripeEvent): PlanPatch {
  const at = Timestamp.fromMillis(event.created * 1000);
  return {
    subscription: { expiresAt: at, status: 'canceled', cancelsAt: null, canceledAt: at },
    billing: { subscriptionStatus: 'canceled', eventAt: eventStamp(event.created) },
  };
}
