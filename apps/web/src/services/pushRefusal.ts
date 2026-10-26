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
 * Only the first is the user's to wait out, so it is told apart by reading the plan again
 * after the refusal: at the limit, that is the reason. Anything else is said as a push this
 * copy of PushThat could not make, with the one step that fixes both other causes: on the
 * site, reload the page, which loads the current version and checks the key again; in the
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

/** The sentence for a refusal that is not the limit: this copy of PushThat may be out of date. */
export const outdatedMessage = () =>
  isExtensionPage()
    ? 'PushThat refused this push. Update the PushThat extension, then try again.'
    : 'PushThat refused this push. Reload the page to update PushThat, then try again.';

/**
 * The sentence for a push the rules refused. The plan is read afresh and handed to
 * `setPlan`, so the page's next check before sending sees the count that refused this one.
 * If it cannot be read, the plan the page already had decides.
 */
export async function refusalMessage(
  known: PlanReport | undefined,
  type: 'url' | 'file',
  setPlan: (plan: PlanReport) => void
): Promise<string> {
  const fresh = await planApi.getPlan().catch(() => undefined);
  if (fresh) setPlan(fresh);
  const plan = fresh ?? known;
  return plan && atLimit(plan, type) ? limitMessage(plan, type) : outdatedMessage();
}
