/**
 * The plan, as the pages describe it (docs/billing.md in pushthat-functions). The
 * numbers the functions enforce and report are in `functions/src/plan.ts` there and
 * the rules carry them too; these are what the front page quotes before anyone has
 * signed in, and the Plan page reads its own from `getPlan`. The copies are changed
 * together.
 */

/** The Pro price, a year at a time, before tax. Stripe's catalog holds the price that is charged. */
export const PRO_PRICE_USD = 24;

export interface TierLimits {
  url: number;
  file: number;
  fileBytes: number;
  keepDays: number;
}

const MB = 1024 * 1024;

export const LIMITS: Record<'free' | 'pro', TierLimits> = {
  free: { url: 50, file: 3, fileBytes: 25 * MB, keepDays: 7 },
  pro: { url: 10_000, file: 100, fileBytes: 100 * MB, keepDays: 30 },
};

/**
 * Whether the Plan page is reachable from the navigation. On since launch (2026-10-25),
 * when production moved to the live Stripe account. Turn it off only together with a
 * move back to sandbox keys: on sandbox keys, anyone who reached the page could
 * subscribe with a test card and get Pro. The route exists either way.
 */
export const PLAN_PAGE_LINKED = true;

export const SUPPORT_EMAIL = 'hello@pushthat.link';

/** How long after any charge a refund is given in full, no reason asked. */
export const REFUND_DAYS = 14;

export function formatMb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}
