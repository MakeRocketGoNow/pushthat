import { Timestamp } from 'firebase-admin/firestore';

import { LIMITS, PlanUser, canSubscribe, fileExpiryOf, limitsOf, planReportOf, tierOf, usageOf } from './plan';

const NOW = new Date('2026-10-25T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => Timestamp.fromDate(new Date(iso));

describe('the tier', () => {
  test('no document is Free', () => expect(tierOf(undefined, NOW)).toBe('free'));
  test('no subscription is Free', () => expect(tierOf({ createdAt: at('2026-01-01T00:00:00Z') }, NOW)).toBe('free'));
  test('a subscription ahead of the clock is Pro', () =>
    expect(tierOf({ subscription: { expiresAt: at('2027-01-01T00:00:00Z') } }, NOW)).toBe('pro'));
  test('a lapsed subscription is Free', () =>
    expect(tierOf({ subscription: { expiresAt: at('2026-10-25T11:59:59Z') } }, NOW)).toBe('free'));
  test('a comp with an end ahead is Pro', () =>
    expect(tierOf({ subscription: { type: 'comp', expiresAt: at('2030-01-01T00:00:00Z') } }, NOW)).toBe('pro'));
  test('a subscription with no expiresAt is Free', () =>
    expect(tierOf({ subscription: { type: 'pro' } }, NOW)).toBe('free'));
});

describe('the limits', () => {
  test('Free: 50 URLs, 3 files of 25 MB, kept 7 days', () =>
    expect(LIMITS.free).toEqual({ url: 50, file: 3, fileBytes: 25 * 1024 * 1024, keepDays: 7 }));
  test('Pro: 10,000 URLs, 100 files of 100 MB, kept 30 days', () =>
    expect(LIMITS.pro).toEqual({ url: 10_000, file: 100, fileBytes: 100 * 1024 * 1024, keepDays: 30 }));
  test('follow the tier', () => {
    expect(limitsOf(undefined, NOW)).toBe(LIMITS.free);
    expect(limitsOf({ subscription: { expiresAt: at('2027-01-01T00:00:00Z') } }, NOW)).toBe(LIMITS.pro);
  });
});

describe('file expiry', () => {
  test('a Free file goes after 7 days', () =>
    expect(fileExpiryOf(undefined, NOW).toMillis()).toBe(NOW.getTime() + 7 * DAY));
  test('a Pro file goes after 30 days', () =>
    expect(fileExpiryOf({ subscription: { expiresAt: at('2027-01-01T00:00:00Z') } }, NOW).toMillis()).toBe(
      NOW.getTime() + 30 * DAY
    ));
});

describe('usage this period', () => {
  test('counts the period anchored on the account’s creation', () => {
    // Made on the 28th: on the 25th the period is still the one that began on 28 September.
    const user: PlanUser = {
      createdAt: at('2026-01-28T00:00:00Z'),
      usageRecords: { '2026-09': { url: 7, file: 1 }, '2026-10': { url: 2 } },
    };
    expect(usageOf(user, NOW)).toEqual({ periodKey: '2026-09', url: 7, file: 1 });
  });
  test('a Pro account counts from the day it subscribed', () => {
    const user: PlanUser = {
      createdAt: at('2026-01-28T00:00:00Z'),
      subscription: { startedAt: at('2026-10-02T00:00:00Z'), expiresAt: at('2027-10-02T00:00:00Z') },
      usageRecords: { '2026-10': { url: 12 } },
    };
    expect(usageOf(user, NOW)).toEqual({ periodKey: '2026-10', url: 12, file: 0 });
  });
  test('an account with nothing recorded is at zero', () =>
    expect(usageOf(undefined, NOW)).toMatchObject({ url: 0, file: 0 }));
});

describe('the report', () => {
  test('for a Free account', () => {
    const report = planReportOf({ createdAt: at('2026-10-01T00:00:00Z') }, NOW);
    expect(report).toMatchObject({
      tier: 'free',
      limits: LIMITS.free,
      subscription: null,
      hasCustomer: false,
      priceUsd: 24,
    });
  });
  test('for a subscriber', () => {
    const user: PlanUser = {
      createdAt: at('2026-10-01T00:00:00Z'),
      subscription: {
        type: 'pro',
        status: 'active',
        startedAt: at('2026-10-02T00:00:00Z'),
        expiresAt: at('2027-10-02T00:00:00Z'),
        cancelsAt: null,
      },
      billing: { customerId: 'cus_1', subscriptionId: 'sub_1', subscriptionStatus: 'active' },
    };
    expect(planReportOf(user, NOW)).toMatchObject({
      tier: 'pro',
      limits: LIMITS.pro,
      subscription: { type: 'pro', status: 'active', expiresAt: '2027-10-02T00:00:00.000Z', cancelsAt: null },
      hasCustomer: true,
    });
  });
  test('for a comp', () => {
    const report = planReportOf({ subscription: { type: 'comp', expiresAt: at('2030-01-01T00:00:00Z') } }, NOW);
    expect(report.tier).toBe('pro');
    expect(report.subscription).toMatchObject({ type: 'comp', status: null });
  });
});

describe('whether a checkout is the thing to offer', () => {
  const pro = {
    type: 'pro' as const,
    status: 'active',
    startedAt: at('2026-10-02T00:00:00Z'),
    expiresAt: at('2027-10-02T00:00:00Z'),
  };
  const live = { subscriptionId: 'sub_1', subscriptionStatus: 'active' };
  test('an account that never subscribed', () => expect(canSubscribe(undefined, NOW)).toBe(true));
  test('a live subscription, or one being collected', () => {
    expect(canSubscribe({ subscription: pro, billing: live }, NOW)).toBe(false);
    expect(
      canSubscribe(
        { subscription: { ...pro, status: 'past_due' }, billing: { ...live, subscriptionStatus: 'past_due' } },
        NOW
      )
    ).toBe(false);
  });
  test('a canceled subscription whose period is over', () => {
    const user: PlanUser = {
      subscription: { ...pro, status: 'canceled', expiresAt: at('2026-10-01T00:00:00Z') },
      billing: { ...live, subscriptionStatus: 'canceled' },
    };
    expect(canSubscribe(user, NOW)).toBe(true);
  });
  test('a canceled subscription still in its paid period', () => {
    const user: PlanUser = {
      subscription: { ...pro, status: 'canceled' },
      billing: { ...live, subscriptionStatus: 'canceled' },
    };
    expect(canSubscribe(user, NOW)).toBe(false);
  });
  test('a comp, while it runs and once it has ended', () => {
    expect(canSubscribe({ subscription: { type: 'comp', expiresAt: at('2030-01-01T00:00:00Z') } }, NOW)).toBe(false);
    expect(canSubscribe({ subscription: { type: 'comp', expiresAt: at('2026-01-01T00:00:00Z') } }, NOW)).toBe(true);
  });
  test('the report carries both answers', () => {
    expect(planReportOf(undefined, NOW)).toMatchObject({ canSubscribe: true, hasCustomer: false });
    expect(planReportOf({ subscription: pro, billing: { ...live, customerId: 'cus_1' } }, NOW)).toMatchObject({
      canSubscribe: false,
      hasCustomer: true,
    });
  });
});

describe('the period at the end of a short month', () => {
  test('30 March, anchored on the 31st, is still the period that began on 28 February', () => {
    const user: PlanUser = { createdAt: at('2026-01-31T00:00:00Z'), usageRecords: { '2026-02': { url: 5 } } };
    expect(usageOf(user, new Date('2026-03-30T12:00:00Z'))).toEqual({ periodKey: '2026-02', url: 5, file: 0 });
  });
});
