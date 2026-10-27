import { FirebaseError } from 'firebase/app';

import { LIMITS } from '@/config/plan';

import { isExtensionPage } from './extension';
import { PlanReport, planApi } from './plan';

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

const atLimit = (plan: PlanReport, type: 'url' | 'file') => plan.usage[type] >= plan.limits[type];

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
 * The sentence for a push the rules refused. The plan is read afresh and handed to
 * `setPlan`, so the page's next check before sending sees the count that refused this one.
 * If it cannot be read, the plan the page already had decides. `keyIsStale` is the page's
 * check of the account's key version; a check that fails counts as not stale.
 */
export async function refusalMessage(
  known: PlanReport | undefined,
  type: 'url' | 'file',
  setPlan: (plan: PlanReport) => void,
  keyIsStale: () => Promise<boolean>
): Promise<string> {
  const fresh = await planApi.getPlan().catch(() => undefined);
  if (fresh) setPlan(fresh);
  const plan = fresh ?? known;
  if (plan && atLimit(plan, type)) return limitMessage(plan, type);
  if (await keyIsStale().catch(() => false)) return STALE_KEY_MESSAGE;
  return outdatedMessage();
}
