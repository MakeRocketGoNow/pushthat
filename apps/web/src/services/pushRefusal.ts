import { FirebaseError } from 'firebase/app';

// By file name and without the `@/` alias, so that `npm run test:keys` can load this in plain
// Node (tests/pushRefusal.mjs), as it does keyDecisions.ts. services/plan.ts is read for its
// type alone, which Node strips, so its Firebase Functions import is never loaded there.
import { LIMITS } from '../config/plan.ts';
import { isExtensionPage } from './extension.ts';
import type { PlanReport } from './plan.ts';

/**
 * What the Push page says when the Firestore rules refuse a push. The rules say no as a
 * permission error and give no reason, and a create can be refused for three: the month's
 * limit, a key a password reset has replaced (the account's `keyVersion` moved on), or a
 * shape the rules no longer accept, which is how a copy of PushThat from before a change
 * to the push format is turned away (docs/e2ee.md, Old app versions).
 *
 * Each is told apart after the refusal, in that order. The plan is read again: at the
 * limit, that is the reason, and the user waits or upgrades. The account's key version is
 * read (`keyIsStale` in pushes.ts): moved past this device's, the user signs in again,
 * which unwraps the new key. Anything else is said as a push this copy of PushThat could
 * not make: on the site, reload the page, which loads the current version; in the
 * extension, update it. This page used to read every permission error as the limit, which
 * once the plaintext shape was refused would have told an outdated tab to wait for next
 * month.
 */

export const isRulesRefusal = (error: unknown) => error instanceof FirebaseError && error.code === 'permission-denied';

/** The sentence for a push past the month's limit, naming the number and, on Free, what Pro allows. */
export const limitMessage = (plan: PlanReport | undefined, type: 'url' | 'file') => {
  const what = type === 'url' ? 'link' : 'file';
  if (!plan) return `You have used this month's ${what} pushes.`;
  const more = plan.tier === 'free' ? ` Pro allows ${LIMITS.pro[type].toLocaleString()}.` : '';
  return `You have used this month's ${plan.limits[type].toLocaleString()} ${what} pushes.${more}`;
};

/**
 * Whether the plan says this month's pushes of `type` are used. The one test for it, before
 * a push is sent and after one is refused, so the two cannot disagree about the limit.
 */
export const atLimit = (plan: PlanReport, type: 'url' | 'file') => plan.usage[type] >= plan.limits[type];

/**
 * The sentence for a push made under a key a password reset elsewhere has replaced. Word for
 * word what Android says (keys_changed_here).
 */
export const STALE_KEY_MESSAGE =
  'Your encryption keys were changed on another device. Sign out and sign in again to use them here.';

/** The sentence for a refusal that is neither: this copy of PushThat may be out of date. */
export const outdatedMessage = () =>
  isExtensionPage()
    ? 'PushThat refused this push. Update the PushThat extension, then try again.'
    : 'PushThat refused this push. Reload the page to update PushThat, then try again.';

/**
 * The sentence for a push the rules refused. `reread` is the page's read of the plan
 * (`usePlan`'s `refresh`), which also keeps what it read, so the page's next check before
 * sending sees the count that refused this one. If it cannot read, the plan the page
 * already had decides. `keyIsStale` is the page's check of the account's key version; a
 * check that fails counts as not stale.
 */
export async function refusalMessage(
  known: PlanReport | undefined,
  type: 'url' | 'file',
  reread: () => Promise<PlanReport | undefined>,
  keyIsStale: () => Promise<boolean>
): Promise<string> {
  const plan = (await reread().catch(() => undefined)) ?? known;
  if (plan && atLimit(plan, type)) return limitMessage(plan, type);
  if (await keyIsStale().catch(() => false)) return STALE_KEY_MESSAGE;
  return outdatedMessage();
}
