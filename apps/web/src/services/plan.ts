import { FunctionsError, getFunctions, httpsCallable } from 'firebase/functions';

import type { TierLimits } from '@/config/plan';

/** What `getPlan` answers: see `PlanReport` in functions/src/plan.ts. */
export interface PlanReport {
  tier: 'free' | 'pro';
  limits: TierLimits;
  usage: { periodKey: string; url: number; file: number };
  subscription: {
    type: 'pro' | 'comp';
    status: string | null;
    expiresAt: string | null;
    cancelsAt: string | null;
  } | null;
  hasCustomer: boolean;
  /** Whether a checkout is the thing to offer: the server's own test, so the button is drawn exactly where a press would be accepted. */
  canSubscribe: boolean;
  priceUsd: number;
}

const call = <T, R>(name: string) => httpsCallable<T, R>(getFunctions(), name);

/** The plan callables in functions/src/stripe-functions.ts, one wrapper each. */
export const planApi = {
  getPlan: () => call<void, PlanReport>('getPlan')().then((r) => r.data),
  refreshSubscription: () => call<void, PlanReport>('refreshSubscription')().then((r) => r.data),
  createCheckoutSession: () => call<void, { url: string }>('createCheckoutSession')().then((r) => r.data),
  createPortalSession: (flow?: 'payment') =>
    call<{ flow?: 'payment' }, { url: string }>('createPortalSession')({ flow }).then((r) => r.data),
};

/**
 * The message a callable's refusal carries, or `fallback` when the SDK has only the
 * bare code: a network failure, a timeout or an uncaught server error leaves
 * `message` as "internal" or "deadline-exceeded", which is nothing to show anyone.
 * A refusal the function threw itself (`HttpsError` with a sentence) comes through
 * whole, colons and all.
 */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof FunctionsError) || !err.message) return fallback;
  const code = err.code.replace(/^functions\//, '');
  const bareCode = err.message.toLowerCase().replace(/_/g, '-') === code;
  return code === 'internal' || bareCode ? fallback : err.message;
}
