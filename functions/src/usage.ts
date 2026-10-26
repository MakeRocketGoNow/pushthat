import { getAuth } from 'firebase-admin/auth';
import { DocumentReference, Firestore, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';

import { PlanUser, fileExpiryOf, limitsOf, subscriptionActive, usageOf } from './plan';

/**
 * Counting a push into the month's usage (docs/billing.md), which `onNewPushCreated`
 * does once the push document exists.
 *
 * The Firestore rules refuse a push once the month's count has reached the tier's
 * limit, but the count they read is this one, written seconds after each push, so a
 * burst of pushes all pass the rules before any of them is counted. A client's write
 * that carried its own count, checked by the rules in the same batch, would close that
 * window, but every client would have to change at once and a release behind would be
 * refused outright. Instead the limit is applied a second time here, where the count
 * is exact: a push that lands over it is deleted in the same transaction that would
 * have counted it, and `onPushRecordDeleted` removes a file push's stored object as it
 * does for any delete. The window is then the seconds between the push and this
 * trigger, and what gets through it is taken back.
 *
 * The push is read inside the transaction as well as counted: this runs seconds after
 * the push was made, or longer after a cold start, and a stamp or a delete must not act
 * on a push the user has removed in that window. A push gone by then still counts.
 */

export type PushType = 'url' | 'file';

/** The push as the trigger's event carries it: what the rules checked at the write. */
export interface NewPush {
  userId: string;
  type: PushType;
}

export type RecordOutcome = 'counted' | 'refused';

/** The email a user document made here is given: the Auth record's. A test supplies its own. */
async function authEmailOf(uid: string): Promise<string | undefined> {
  return (await getAuth().getUser(uid)).email;
}

/**
 * Counts `push` into its user's current period, stamping a file push with its expiry,
 * or deletes it when the period's count has already reached the tier's limit.
 */
export async function recordPush(
  db: Firestore,
  pushRef: DocumentReference,
  push: NewPush,
  now: Date,
  { emailOf = authEmailOf }: { emailOf?: (uid: string) => Promise<string | undefined> } = {}
): Promise<RecordOutcome> {
  if (push.type !== 'url' && push.type !== 'file') {
    throw new Error(`push ${pushRef.id} has a type the rules do not allow: ${String(push.type)}`);
  }
  const userRef = db.collection('users').doc(push.userId);
  const nowTimestamp = Timestamp.fromDate(now);

  return db.runTransaction(async (transaction) => {
    // Every read first, then the writes.
    const [userDoc, pushDoc] = await Promise.all([transaction.get(userRef), transaction.get(pushRef)]);
    const stored = userDoc.exists ? (userDoc.data() as PlanUser) : undefined;
    // A document without createdAt (the Chrome extension's first token write used to make
    // one) counts from today, and is given the field below, as the rules assume.
    const createdAt = stored?.createdAt instanceof Timestamp ? stored.createdAt : nowTimestamp;
    const user: PlanUser = { ...stored, createdAt };

    // The period the push is counted into: the same arithmetic the Plan page reports and
    // the rules check, so the three cannot drift.
    const usage = usageOf(user, now);
    const current = usage[push.type];
    const limit = limitsOf(user, now)[push.type];
    if (current >= limit) {
      if (pushDoc.exists) transaction.delete(pushRef);
      logger.warn(`recordPush: ${push.type} push ${pushRef.id} landed over the limit of ${limit}; deleted`);
      return 'refused';
    }

    // A file push is kept for the tier's retention and then deleted by the sweep
    // (expiry.ts). Decided here, from the tier at the moment of the push, since the rules
    // keep clients from writing expiresAt at all.
    if (push.type === 'file' && pushDoc.exists) {
      transaction.update(pushRef, { expiresAt: fileExpiryOf(user, now) });
    }

    if (!stored) {
      transaction.set(userRef, { email: await emailOf(push.userId), createdAt: nowTimestamp });
    } else if (!stored.createdAt) {
      transaction.set(userRef, { createdAt }, { merge: true });
    }

    const subscription = stored?.subscription;
    transaction.set(
      userRef,
      {
        usageRecords: {
          ...stored?.usageRecords,
          [usage.periodKey]: {
            ...stored?.usageRecords?.[usage.periodKey],
            [push.type]: current + 1,
          },
        },
        lastPushWasActiveSubscription: subscriptionActive(subscription, now),
        periodStart: subscription?.startedAt || createdAt,
        updatedAt: now,
      },
      { merge: true }
    );
    return 'counted';
  });
}
