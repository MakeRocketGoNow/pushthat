import { Timestamp } from 'firebase-admin/firestore';

import { PlanUser } from './plan';
import { StripeInvoice, StripeSubscription } from './stripe';
import { StripeEvent, eventStamp, planPatchFor, refundEffectOf, refundPatchFor } from './stripe-events';

const T0 = 1_800_000_000; // unix seconds, some day in 2027
const YEAR = 365 * 24 * 60 * 60;

function subscription(over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: 'sub_1',
    status: 'active',
    customer: 'cus_1',
    created: T0,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: null,
    metadata: {},
    items: {
      data: [
        {
          id: 'si_1',
          price: { id: 'price_pro' },
          quantity: 1,
          current_period_start: T0,
          current_period_end: T0 + YEAR,
        },
      ],
      has_more: false,
    },
    ...over,
  };
}

function event(type: string, object: StripeEvent['data']['object'], created = T0 + 1): StripeEvent {
  return { id: `evt_${type}_${created}`, type, created, data: { object } };
}

function invoice(subscriptionId: string | null, periodEnd = T0 + YEAR): StripeInvoice {
  return {
    id: 'in_1',
    customer: 'cus_1',
    status: 'paid',
    parent: subscriptionId
      ? { type: 'subscription_details', subscription_details: { subscription: subscriptionId } }
      : null,
    lines: {
      data: [
        {
          id: 'il_1',
          amount: 2400,
          quantity: 1,
          pricing: { price_details: { price: 'price_pro' } },
          period: { start: T0, end: periodEnd },
        },
      ],
      has_more: false,
    },
  };
}

const ms = (seconds: number) => Timestamp.fromMillis(seconds * 1000);

describe('planPatchFor', () => {
  test('a new subscription makes the account Pro until the period ends', () => {
    const patch = planPatchFor(event('customer.subscription.created', subscription()), {
      billing: { customerId: 'cus_1' },
    });
    expect(patch?.subscription).toMatchObject({ type: 'pro', interval: 'yearly', status: 'active', cancelsAt: null });
    expect(patch?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR) * 1000);
    expect(patch?.subscription?.startedAt?.toMillis()).toBe(T0 * 1000);
    expect(patch?.billing).toEqual({
      subscriptionId: 'sub_1',
      subscriptionStatus: 'active',
      eventAt: eventStamp(T0 + 1),
    });
  });

  test('a later event keeps the anchor the subscription started with', () => {
    const user: PlanUser = {
      subscription: { startedAt: ms(T0 - 100), expiresAt: ms(T0 + YEAR) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    };
    const patch = planPatchFor(
      event('customer.subscription.updated', subscription({ cancel_at_period_end: true })),
      user
    );
    expect(patch?.subscription?.startedAt?.toMillis()).toBe((T0 - 100) * 1000);
    expect(patch?.subscription?.cancelsAt?.toMillis()).toBe((T0 + YEAR) * 1000);
  });

  test('a cancellation keeps the end of the period already paid for', () => {
    const user: PlanUser = {
      subscription: { expiresAt: ms(T0 + YEAR) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    };
    const patch = planPatchFor(
      event('customer.subscription.deleted', subscription({ status: 'canceled', canceled_at: T0 + 10 }), T0 + 10),
      user
    );
    expect(patch?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR) * 1000);
    expect(patch?.subscription?.status).toBe('canceled');
    expect(patch?.subscription?.cancelsAt).toBeNull();
  });

  test('a renewal extends the plan by the grace only, until its invoice is paid', () => {
    const DAY = 24 * 60 * 60;
    const user: PlanUser = {
      subscription: { startedAt: ms(T0), expiresAt: ms(T0 + YEAR) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    };
    const renewed = subscription({
      items: {
        data: [
          {
            id: 'si_1',
            price: { id: 'price_pro' },
            quantity: 1,
            current_period_start: T0 + YEAR,
            current_period_end: T0 + 2 * YEAR,
          },
        ],
        has_more: false,
      },
    });
    // The snapshot Stripe sends as the period rolls over, an hour before it charges.
    const first = planPatchFor(event('customer.subscription.updated', renewed, T0 + YEAR + 1), user);
    expect(first?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR + 3 * DAY) * 1000);
    // A second snapshot in the same unpaid period adds nothing.
    const graced: PlanUser = {
      ...user,
      subscription: { ...user.subscription, expiresAt: first!.subscription!.expiresAt },
    };
    const second = planPatchFor(event('customer.subscription.updated', renewed, T0 + YEAR + 60), graced);
    expect(second?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR + 3 * DAY) * 1000);
    // The card fails: past_due, then canceled, and the grace is all the year ever gets.
    const late = planPatchFor(
      event('customer.subscription.updated', { ...renewed, status: 'past_due' }, T0 + YEAR + 3600),
      graced
    );
    expect(late?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR + 3 * DAY) * 1000);
    const gone = planPatchFor(
      event('customer.subscription.deleted', { ...renewed, status: 'canceled' }, T0 + YEAR + 10 * DAY),
      graced
    );
    expect(gone?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR + 3 * DAY) * 1000);
    // The card pays: the invoice extends the year, and a later snapshot keeps it.
    const paid = planPatchFor(event('invoice.paid', invoice('sub_1', T0 + 2 * YEAR), T0 + YEAR + 3600), graced);
    expect(paid?.subscription?.expiresAt?.toMillis()).toBe((T0 + 2 * YEAR) * 1000);
    const extended: PlanUser = {
      ...user,
      subscription: { ...user.subscription, expiresAt: paid!.subscription!.expiresAt },
    };
    const after = planPatchFor(event('customer.subscription.updated', renewed, T0 + YEAR + 7200), extended);
    expect(after?.subscription?.expiresAt?.toMillis()).toBe((T0 + 2 * YEAR) * 1000);
  });

  test('a past-due renewal does not extend the plan', () => {
    const user: PlanUser = {
      subscription: { expiresAt: ms(T0 + YEAR) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    };
    const late = subscription({
      status: 'past_due',
      items: {
        data: [
          {
            id: 'si_1',
            price: { id: 'price_pro' },
            quantity: 1,
            current_period_start: T0 + YEAR,
            current_period_end: T0 + 2 * YEAR,
          },
        ],
        has_more: false,
      },
    });
    const patch = planPatchFor(event('customer.subscription.updated', late, T0 + YEAR + 1), user);
    expect(patch?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR) * 1000);
    expect(patch?.subscription?.status).toBe('past_due');
  });

  test('an incomplete subscription changes nothing', () => {
    expect(
      planPatchFor(event('customer.subscription.created', subscription({ status: 'incomplete' })), undefined)
    ).toBeNull();
  });

  test("a former subscription's late news is ignored while the current one runs", () => {
    const user: PlanUser = { billing: { subscriptionId: 'sub_2', subscriptionStatus: 'active' } };
    expect(
      planPatchFor(event('customer.subscription.deleted', subscription({ id: 'sub_1', status: 'canceled' })), user)
    ).toBeNull();
  });

  test('a lapsed subscriber coming back gets a new anchor', () => {
    const user: PlanUser = {
      subscription: { startedAt: ms(T0 - YEAR), expiresAt: ms(T0 - 1) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'canceled' },
    };
    const patch = planPatchFor(
      event('customer.subscription.created', subscription({ id: 'sub_2', created: T0 + 5 })),
      user
    );
    expect(patch?.billing?.subscriptionId).toBe('sub_2');
    expect(patch?.subscription?.startedAt?.toMillis()).toBe((T0 + 5) * 1000);
  });

  test('nothing moves while a comp runs', () => {
    const user: PlanUser = { subscription: { type: 'comp', expiresAt: ms(T0 + YEAR) } };
    expect(planPatchFor(event('customer.subscription.created', subscription()), user)).toBeNull();
    expect(planPatchFor(event('invoice.paid', invoice('sub_1')), user)).toBeNull();
  });

  test('a paid invoice makes a new subscriber Pro without a stamp', () => {
    const patch = planPatchFor(event('invoice.paid', invoice('sub_1')), { billing: { customerId: 'cus_1' } });
    expect(patch?.subscription?.expiresAt?.toMillis()).toBe((T0 + YEAR) * 1000);
    expect(patch?.subscription?.status).toBe('active');
    expect(patch?.billing).toEqual({ subscriptionId: 'sub_1', subscriptionStatus: 'active' });
    expect(patch?.billing?.eventAt).toBeUndefined();
  });

  test('a paid invoice only ever extends, and leaves a refunded subscription canceled', () => {
    const later: PlanUser = {
      subscription: { startedAt: ms(T0), expiresAt: ms(T0 + 2 * YEAR) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active', eventAt: eventStamp(T0 + YEAR + 100) },
    };
    // An invoice for a shorter period than the document holds moves nothing back.
    const shorter = planPatchFor(event('invoice.paid', invoice('sub_1', T0 + YEAR), T0 + YEAR), later);
    expect(shorter?.subscription?.expiresAt?.toMillis()).toBe((T0 + 2 * YEAR) * 1000);
    // A refund's cancel is not undone by its invoice arriving late.
    const refunded: PlanUser = {
      subscription: { expiresAt: ms(T0 + 50) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'canceled' },
    };
    expect(planPatchFor(event('invoice.paid', invoice('sub_1')), refunded)).toBeNull();
  });

  test('a former subscription’s late invoice cannot revive it over a newer, canceled one', () => {
    const moved: PlanUser = {
      subscription: { expiresAt: ms(T0 + 10) },
      billing: { subscriptionId: 'sub_2', subscriptionStatus: 'canceled', eventAt: eventStamp(T0 + 100) },
    };
    expect(planPatchFor(event('invoice.paid', invoice('sub_1'), T0 + 1), moved)).toBeNull();
    // A newer invoice for a subscription the document does not name is still adopted.
    expect(planPatchFor(event('invoice.paid', invoice('sub_3'), T0 + 200), moved)?.billing?.subscriptionId).toBe(
      'sub_3'
    );
  });

  test('a renewal invoice extends the plan and leaves the ids alone', () => {
    const user: PlanUser = {
      subscription: { startedAt: ms(T0), expiresAt: ms(T0 + YEAR) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    };
    const patch = planPatchFor(event('invoice.paid', invoice('sub_1', T0 + 2 * YEAR), T0 + YEAR), user);
    expect(patch?.subscription?.expiresAt?.toMillis()).toBe((T0 + 2 * YEAR) * 1000);
    expect(patch?.subscription?.startedAt).toBeUndefined();
    expect(patch?.billing).toBeUndefined();
  });

  test('an invoice that bills no subscription is not the plan’s', () => {
    expect(planPatchFor(event('invoice.paid', invoice(null)), undefined)).toBeNull();
  });

  test('an unfollowed event changes nothing', () => {
    expect(planPatchFor(event('customer.subscription.trial_will_end', subscription()), undefined)).toBeNull();
  });
});

describe('refunds', () => {
  const subscribed: PlanUser = {
    subscription: { expiresAt: ms(T0 + YEAR) },
    billing: { subscriptionId: 'sub_1', subscriptionStatus: 'active' },
  };
  const charge = {
    id: 'ch_1',
    amount: 2400,
    amount_refunded: 2400,
    refunded: true,
    payment_intent: 'pi_1',
    customer: 'cus_1',
  };

  test('a refund asks for the invoice, then cancels', () => {
    const e = event('charge.refunded', charge);
    expect(refundEffectOf(e, subscribed)).toBe('needs-invoice');
    expect(refundEffectOf(e, subscribed, invoice('sub_1'))).toBe('cancel');
  });

  test('a partial refund cancels too: there is one product to refund', () => {
    expect(
      refundEffectOf(
        event('charge.refunded', { ...charge, amount_refunded: 100, refunded: false }),
        subscribed,
        invoice('sub_1')
      )
    ).toBe('cancel');
  });

  test('a dispute cancels', () => {
    expect(
      refundEffectOf(
        event('charge.dispute.created', {
          id: 'dp_1',
          charge: 'ch_1',
          payment_intent: 'pi_1',
          amount: 2400,
          status: 'needs_response',
        }),
        subscribed,
        invoice('sub_1')
      )
    ).toBe('cancel');
  });

  test("a refund of another subscription's invoice, or of no invoice, does nothing", () => {
    expect(refundEffectOf(event('charge.refunded', charge), subscribed, invoice('sub_9'))).toBeNull();
    expect(refundEffectOf(event('charge.refunded', charge), subscribed, null)).toBeNull();
  });

  test('a second delivery finds the period already ended', () => {
    const ended: PlanUser = {
      subscription: { expiresAt: ms(T0) },
      billing: { subscriptionId: 'sub_1', subscriptionStatus: 'canceled' },
    };
    expect(refundEffectOf(event('charge.refunded', charge, T0 + 1), ended)).toBeNull();
  });

  test('nothing while a comp runs, or with no subscription', () => {
    expect(
      refundEffectOf(event('charge.refunded', charge), { subscription: { type: 'comp', expiresAt: ms(T0 + YEAR) } })
    ).toBeNull();
    expect(refundEffectOf(event('charge.refunded', charge), { billing: { customerId: 'cus_1' } })).toBeNull();
  });

  test('the cancel ends the plan at the refund', () => {
    const patch = refundPatchFor(event('charge.refunded', charge, T0 + 50));
    expect(patch.subscription?.expiresAt?.toMillis()).toBe((T0 + 50) * 1000);
    expect(patch.subscription?.status).toBe('canceled');
    expect(patch.billing).toEqual({ subscriptionStatus: 'canceled', eventAt: eventStamp(T0 + 50) });
  });
});
