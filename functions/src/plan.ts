import { Timestamp } from 'firebase-admin/firestore';

import { getBillingPeriodKey } from './billing';

/**
 * The plan: what Free and Pro allow, and where an account stands (docs/billing.md).
 *
 * Decided 2026-10-25. A URL push costs about $0.00002 to serve, so the URL limits are
 * abuse caps; files cost through storage and download egress, so their count, size and
 * how long they are kept are what bound an account's cost. The numbers here are what
 * the functions enforce and report; `firestore.rules` and `storage.rules` carry the same
 * numbers for the writes they refuse, and the three are changed together.
 *
 * The Firestore rules decide a push by `users/{uid}.subscription.expiresAt` alone, so
 * that field is the one source of "is this account Pro": the Stripe webhook keeps it
 * in step with the subscription, and a comp sets it by hand with `type: 'comp'`.
 */

export type Tier = 'free' | 'pro';

export interface TierLimits {
  /** URL pushes a month. */
  url: number;
  /** File pushes a month. */
  file: number;
  /** The largest file, in bytes. */
  fileBytes: number;
  /** How long a file push is kept before the sweep deletes it. */
  keepDays: number;
}

const MB = 1024 * 1024;

export const LIMITS: Record<Tier, TierLimits> = {
  free: { url: 50, file: 3, fileBytes: 25 * MB, keepDays: 7 },
  pro: { url: 10_000, file: 100, fileBytes: 100 * MB, keepDays: 30 },
};

/** The Pro price, a year at a time, before tax. Stripe's catalog holds the price that is charged; this is what the pages say. */
export const PRO_PRICE_USD = 24;

/** `users/{uid}.subscription`, as the webhook and a comp write it and the rules read it. */
export interface Subscription {
  /** `pro` from Stripe; `comp` set by hand, which the webhook never touches while it runs. */
  type?: 'pro' | 'comp';
  interval?: 'yearly' | 'monthly' | null;
  /** When the account first became Pro: anchors the monthly usage period (`getBillingPeriodKey`). */
  startedAt?: Timestamp;
  /** The end of the period paid for, or the comp's end. Pro while this is ahead of the clock. */
  expiresAt?: Timestamp;
  /** Stripe's status, for the Plan page: `active`, `past_due`, `canceled`, ... */
  status?: string;
  /** A cancellation ahead: the subscription ends then, and `expiresAt` says the same. */
  cancelsAt?: Timestamp | null;
  canceledAt?: Timestamp | null;
}

/** The ids the Stripe webhook finds an account by and orders its events with. Never written by a client. */
export interface Billing {
  customerId?: string;
  subscriptionId?: string | null;
  subscriptionStatus?: string | null;
  /** The newest event applied, ISO 8601, so an older delivery cannot write over a newer one. */
  eventAt?: string | null;
}

/** The fields of a user document the plan reads. */
export interface PlanUser {
  createdAt?: Timestamp;
  subscription?: Subscription;
  billing?: Billing;
  usageRecords?: Record<string, Partial<Record<'url' | 'file', number>>>;
}

/** Whether the subscription is in force at `now`: the same test as `getUserLimit` in the rules. */
export function subscriptionActive(sub: Subscription | undefined, now: Date): boolean {
  const expiresAt = sub?.expiresAt;
  return expiresAt instanceof Timestamp && expiresAt.toMillis() > now.getTime();
}

/** A comp in force at `now`: the operator's word that the account is not Stripe's to move. */
export function compRunning(sub: Subscription | undefined, now: Date): boolean {
  return sub?.type === 'comp' && subscriptionActive(sub, now);
}

export function tierOf(user: PlanUser | undefined, now: Date): Tier {
  return subscriptionActive(user?.subscription, now) ? 'pro' : 'free';
}

/** The limits that apply to the account at `now`. */
export function limitsOf(user: PlanUser | undefined, now: Date): TierLimits {
  return LIMITS[tierOf(user, now)];
}

/**
 * The account's usage this period, with the period it is counted in. The period is the
 * one `onNewPushCreated` counts into and the rules check against, anchored on the day the
 * subscription started or the account was made.
 */
export function usageOf(user: PlanUser | undefined, now: Date): { periodKey: string; url: number; file: number } {
  const createdAt = user?.createdAt instanceof Timestamp ? user.createdAt : Timestamp.fromDate(now);
  const sub = user?.subscription;
  const active = subscriptionActive(sub, now);
  const periodKey = getBillingPeriodKey(
    active && sub?.startedAt instanceof Timestamp
      ? { startedAt: sub.startedAt, interval: sub.interval ?? null }
      : undefined,
    createdAt,
    now
  );
  const record = user?.usageRecords?.[periodKey];
  return { periodKey, url: record?.url ?? 0, file: record?.file ?? 0 };
}

/** When a file pushed at `at` is deleted: the tier's retention from the moment of the push. */
export function fileExpiryOf(user: PlanUser | undefined, at: Date): Timestamp {
  const days = limitsOf(user, at).keepDays;
  return Timestamp.fromMillis(at.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * What the Plan page and the apps are told. One shape for every client, so the tier,
 * the numbers and the sentence are worked out here and nowhere else.
 */
export interface PlanReport {
  tier: Tier;
  limits: TierLimits;
  usage: { periodKey: string; url: number; file: number };
  subscription: {
    type: 'pro' | 'comp';
    status: string | null;
    /** ISO 8601. */
    expiresAt: string | null;
    cancelsAt: string | null;
  } | null;
  /** Whether this account has ever had a Stripe customer, so the billing portal has something to open. */
  hasCustomer: boolean;
  /**
   * Whether a checkout is the thing to offer: the test `createCheckoutSession` refuses
   * on, so the page and the apps draw the button where the function would accept the
   * press (the function also asks Stripe, which can know of a subscription the document
   * has not heard of yet). False while a subscription is live or being collected, and
   * while a comp runs.
   */
  canSubscribe: boolean;
  priceUsd: number;
}

/** Whether `createCheckoutSession` would make a checkout for the account at `now`; the callable refuses on the same test. */
export function canSubscribe(user: PlanUser | undefined, now: Date): boolean {
  if (compRunning(user?.subscription, now)) return false;
  const billing = user?.billing;
  const lapsed = billing?.subscriptionStatus === 'canceled' && !subscriptionActive(user?.subscription, now);
  return !billing?.subscriptionId || lapsed;
}

export function planReportOf(user: PlanUser | undefined, now: Date): PlanReport {
  const sub = user?.subscription;
  const iso = (t: Timestamp | null | undefined) => (t instanceof Timestamp ? t.toDate().toISOString() : null);
  const hasCustomer = typeof user?.billing?.customerId === 'string';
  return {
    tier: tierOf(user, now),
    limits: limitsOf(user, now),
    usage: usageOf(user, now),
    subscription:
      sub && (sub.type === 'comp' || sub.type === 'pro' || sub.expiresAt)
        ? {
            type: sub.type === 'comp' ? 'comp' : 'pro',
            status: sub.status ?? null,
            expiresAt: iso(sub.expiresAt),
            cancelsAt: iso(sub.cancelsAt),
          }
        : null,
    hasCustomer,
    canSubscribe: canSubscribe(user, now),
    priceUsd: PRO_PRICE_USD,
  };
}
