import { getAuth } from 'firebase-admin/auth';
import { Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { deletionMarkers, deletionRef } from './deletion-marker';
import {
  ENDED_SUBSCRIPTION,
  StripeConfig,
  StripeError,
  deleteCustomer,
  ensureSubscriptionCanceled,
  expireOpenCheckouts,
  isMissingAtStripe,
  subscriptionsOf,
} from './stripe';
import { secrets, stripeConfig, uidOf } from './stripe-functions';

/**
 * Deleting an account (docs/account-deletion.md): the `deleteAccount` callable every
 * client and the public page at /delete-account call, and the sweep that finishes the
 * job an hour later.
 *
 * Everything the project holds about an account is keyed by its uid, in these places,
 * and all of them are emptied:
 *
 * - `users/{uid}` and anything under it: the email, the device tokens, the wrapped
 *   account key and recovery wrap (`e2ee`), the month's usage, the plan and Stripe ids.
 * - `pushes` where `userId` is the uid: the encrypted links and file records.
 * - Storage under `uploads/{uid}/`: the encrypted files, whether or not a push names them.
 * - `stripeCustomers` and `billingEvents` rows that name the uid.
 * - The Firebase Authentication user: the email, the password hash and every session.
 * - At Stripe, the customer, after its subscription is ended, so a deleted account is
 *   never charged again.
 *
 * It is a delete, not a flag: nothing is kept to restore from, and the account key going
 * is what makes the pushes unrecoverable even from a backup of their ciphertext.
 *
 * Deleting the Auth user signs a device out only when its ID token next refreshes, which
 * is up to an hour away, and until then that token still passes the rules: a phone left
 * signed in could write its notification token back to `users/{uid}`, or a push made in
 * the same second could be counted by `onNewPushCreated` after the purge. Refusing those
 * in the rules would cost every push a second document read for the life of the project.
 * Instead a marker, `accountDeletions/{uid}`, is left holding only the time, and
 * `finishAccountDeletions` purges the same places again once every token the account
 * ever had has expired, then removes the marker. So the first purge is immediate and the
 * second is what makes "nothing is left" true without depending on the clients.
 */

/**
 * How recent the sign-in must be, in seconds. The clients ask for the password and sign
 * in again right before the call, so five minutes is time for the round trip and no
 * more: a session left open on a shared computer cannot delete the account, which is
 * what asking for the password is for. Checked here, from the token's `auth_time`,
 * because a check made only in a client is one a modified client skips.
 */
export const FRESH_SIGN_IN_S = 5 * 60;

/**
 * How long after a deletion the second purge waits: an ID token lives an hour, and ten
 * minutes on top covers a clock that is off and a trigger that started late.
 */
export const DELETION_SETTLE_MS = 70 * 60 * 1000;

/** How many documents one batch deletes: Firestore's limit on a commit. */
const DELETE_BATCH = 500;

/** The two calls made to Firebase Authentication, so the suites can watch them. */
export interface AuthAdmin {
  revokeRefreshTokens(uid: string): Promise<void>;
  deleteUser(uid: string): Promise<void>;
}

export interface DeletionDeps {
  db?: Firestore;
  auth?: AuthAdmin;
  /** Billing, when it is on. */
  stripe?: StripeConfig;
  /** Refuse, rather than skip Stripe, when billing is off and the account has a customer. */
  billingRequired?: boolean;
  now?: Date;
}

/** Whether the token's sign-in (`auth_time`, Unix seconds) is recent enough at `now`. */
export function signedInRecently(authTime: unknown, now: Date, maxAgeS = FRESH_SIGN_IN_S): boolean {
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) return false;
  const age = now.getTime() / 1000 - authTime;
  // A minute of clock skew the other way is let through; a sign-in from the future is not.
  return age <= maxAgeS && age >= -60;
}

/** Deletes every document `query` matches, a commit's worth at a time; returns how many. */
async function deleteMatching(db: Firestore, query: FirebaseFirestore.Query): Promise<number> {
  let deleted = 0;
  for (;;) {
    const page = await query.limit(DELETE_BATCH).get();
    if (page.empty) return deleted;
    const batch = db.batch();
    for (const doc of page.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += page.size;
  }
}

/** How many stored objects are listed, and how many deleted at once, as the orphan sweep does. */
const UPLOAD_PAGE = 1000;
const UPLOAD_DELETE_CHUNK = 50;

/**
 * Deletes every object under `uploads/{uid}/`. Listed and deleted here rather than with
 * the SDK's `deleteFiles`, which stops at the first object that is already gone.
 */
async function deleteUploads(uid: string): Promise<void> {
  const bucket = getStorage().bucket();
  let pageToken: string | undefined;
  do {
    const [files, next] = await bucket.getFiles({
      prefix: `uploads/${uid}/`,
      autoPaginate: false,
      maxResults: UPLOAD_PAGE,
      pageToken,
    });
    pageToken = (next as { pageToken?: string } | null)?.pageToken;
    for (let i = 0; i < files.length; i += UPLOAD_DELETE_CHUNK) {
      await Promise.all(files.slice(i, i + UPLOAD_DELETE_CHUNK).map((file) => file.delete({ ignoreNotFound: true })));
    }
  } while (pageToken);
}

export interface PurgeReport {
  pushes: number;
  billingRows: number;
}

/**
 * Empties every place the project keeps something under `uid`, except the Auth user and
 * Stripe. Safe to run again: each step deletes what is there and is content with nothing.
 *
 * The stored files are deleted by prefix rather than left to `onPushRecordDeleted`, which
 * removes a file push's object as its document goes: that trigger only sees an object a
 * push names, and an upload whose push never came would wait for the orphan sweep's
 * seven days.
 *
 * And they go first, before the push documents. Each document deleted starts that
 * trigger, which looks for its object and deletes it. With the documents first, the
 * trigger and this were deleting the same objects at the same moment, and whichever lost
 * got "no such object": here that failed the whole deletion before the Auth user went,
 * and the more files an account had the likelier it was. With the files first, every
 * trigger finds its object already gone and stops. An object that vanishes anyway (the
 * expiry sweep, a push deleted on another device) is what this wants, not an error.
 *
 * A push made in the moment before this ran may still be on its way through
 * `onNewPushCreated`, whose count makes the user document it does not find. No order of
 * the steps here closes that, which is one of the things the second purge is for.
 */
export async function purgeAccountData(db: Firestore, uid: string): Promise<PurgeReport> {
  await deleteUploads(uid);
  const pushes = await deleteMatching(db, db.collection('pushes').where('userId', '==', uid));
  const billingRows =
    (await deleteMatching(db, db.collection('billingEvents').where('userId', '==', uid))) +
    (await deleteMatching(db, db.collection('stripeCustomers').where('userId', '==', uid)));
  // Recursive, for whatever is under the document: `usage` was a subcollection once.
  await db.recursiveDelete(db.collection('users').doc(uid));
  return { pushes, billingRows };
}

/** The Stripe customers the account has: the one its document names, and any row that names the account. */
async function customersOf(db: Firestore, uid: string): Promise<string[]> {
  const [user, rows] = await Promise.all([
    db.collection('users').doc(uid).get(),
    db.collection('stripeCustomers').where('userId', '==', uid).get(),
  ]);
  const fromDoc = (user.data() as { billing?: { customerId?: unknown } } | undefined)?.billing?.customerId;
  return [...new Set([...(typeof fromDoc === 'string' && fromDoc ? [fromDoc] : []), ...rows.docs.map((d) => d.id)])];
}

/**
 * Ends what the account has at Stripe. The subscription is what must not survive: an
 * account that no longer exists would be charged again at its renewal, with no page left
 * to cancel from. So a subscription Stripe will not cancel stops the deletion before
 * anything has been deleted, and the person can try again. Open checkouts are ended
 * first, so one left in another tab cannot be paid afterwards.
 *
 * Deleting the customer itself is not allowed to stop it. By then nothing can charge the
 * account, and refusing to delete someone's data because a record at the payment
 * processor would not go is the worse failure. It is logged with the customer's id, to
 * be removed by hand in the dashboard.
 *
 * A customer Stripe no longer has is one an earlier call already deleted, before it
 * failed at a later step: the rows that name it are only removed by the purge, so a
 * retry meets it again. Stripe may answer a list filtered by a deleted customer with
 * "no such customer" rather than an empty list, and that must read as nothing left to
 * end, not as a subscription that could not be cancelled.
 */
async function endBilling(stripe: StripeConfig, customerIds: string[], uid: string): Promise<void> {
  for (const customerId of customerIds) {
    try {
      await expireOpenCheckouts(stripe, customerId);
      for (const sub of await subscriptionsOf(stripe, customerId)) {
        if (!ENDED_SUBSCRIPTION.has(sub.status)) await ensureSubscriptionCanceled(stripe, sub.id);
      }
    } catch (err) {
      if (!isMissingAtStripe(err)) throw err;
    }
    try {
      await deleteCustomer(stripe, customerId);
    } catch (err) {
      logger.error(
        `[account] user=${uid}: Stripe would not delete customer ${customerId}; delete it by hand: ${(err as Error).message}`
      );
    }
  }
}

/**
 * The account has a Stripe customer and there is no Stripe configuration to end its
 * subscription with. Thrown before anything is deleted.
 */
export class BillingOffError extends Error {
  constructor() {
    super('billing is off, and the account has a Stripe customer');
    this.name = 'BillingOffError';
  }
}

const isUserNotFound = (err: unknown) => (err as { code?: string } | null)?.code === 'auth/user-not-found';

/** Runs `step`, taking "there is no such user" as done: a second call finds the user already gone. */
async function unlessGone(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (err) {
    if (!isUserNotFound(err)) throw err;
  }
}

/**
 * Deletes the account `uid`, for good. In order: Stripe (the one step that can refuse,
 * so it goes while nothing is deleted yet), the marker for the second purge, the refresh
 * tokens (so no device can renew its session from here on), the data, and last the Auth
 * user. The user goes last because it is what lets the person ask again: if a step in
 * between fails, they can still sign in and the next call picks up where this one
 * stopped. Every step is content to find its work already done, so a call for an account
 * already deleted succeeds and changes nothing.
 */
export async function deleteAccountOf(
  uid: string,
  { db = getFirestore(), auth = getAuth(), stripe, billingRequired = false, now = new Date() }: DeletionDeps = {}
): Promise<void> {
  const customerIds = await customersOf(db, uid);
  if (customerIds.length > 0) {
    if (stripe) {
      await endBilling(stripe, customerIds, uid);
    } else if (billingRequired) {
      // The purge deletes `billing.customerId` and the `stripeCustomers` row, the only
      // things that say which Stripe customer was this account's. Going on without
      // Stripe would leave a subscription renewing with nothing left that points at it.
      throw new BillingOffError();
    } else {
      // The emulator's case (stripe-functions.ts), where no customer is a real one.
      logger.warn(`[account] user=${uid}: billing is off, so nothing was asked of Stripe`);
    }
  }

  await deletionRef(db, uid).set({
    deletedAt: Timestamp.fromDate(now),
    settleAt: Timestamp.fromMillis(now.getTime() + DELETION_SETTLE_MS),
  });
  await unlessGone(() => auth.revokeRefreshTokens(uid));
  const report = await purgeAccountData(db, uid);
  await unlessGone(() => auth.deleteUser(uid));
  logger.info(
    `[account] deleted user=${uid}: ${report.pushes} push${report.pushes === 1 ? '' : 'es'}, ${report.billingRows} billing row${report.billingRows === 1 ? '' : 's'}`
  );
}

/**
 * The second purge (see the top of this file): for every deletion whose tokens have all
 * expired by `now`, empties the same places again and removes the marker. Returns the
 * accounts finished. One that fails keeps its marker and is tried again the next hour.
 *
 * Stripe is asked again too, before the purge removes the rows that say which customer
 * to ask about. `createCheckoutSession` refuses an account with a marker, but a checkout
 * opened in the second before the marker was written could still have been paid since,
 * and that subscription would renew for an account that does not exist.
 */
export async function finishDeletions(
  now: Date,
  { db = getFirestore(), auth = getAuth(), stripe }: Pick<DeletionDeps, 'db' | 'auth' | 'stripe'> = {}
): Promise<string[]> {
  const due = await deletionMarkers(db).where('settleAt', '<=', Timestamp.fromDate(now)).get();
  const finished: string[] = [];
  for (const marker of due.docs) {
    const uid = marker.id;
    try {
      const customerIds = await customersOf(db, uid);
      if (stripe && customerIds.length > 0) await endBilling(stripe, customerIds, uid);
      const report = await purgeAccountData(db, uid);
      // Already gone unless the first call stopped before it got there.
      await unlessGone(() => auth.deleteUser(uid));
      await marker.ref.delete();
      finished.push(uid);
      if (report.pushes > 0) {
        logger.info(`[account] user=${uid}: ${report.pushes} push(es) written after the deletion, removed`);
      }
    } catch (err) {
      logger.error(`[account] user=${uid}: the second purge failed and will be tried again`, err);
    }
  }
  return finished;
}

/**
 * Deletes the caller's account. The caller must have signed in within the last five
 * minutes (`FRESH_SIGN_IN_S`): every client asks for the password and signs in again
 * before calling, and this is where that is enforced. Answers `{ deleted: true }`, also
 * for an account already deleted, whose last ID token can still reach here for an hour.
 *
 * Five minutes of timeout rather than the default one: an account with thousands of
 * pushes is deleted five hundred at a time, and a deletion cut off halfway is finished by
 * the next call or by the sweep, but the person would have seen an error.
 */
export const deleteAccount = onCall({ cors: true, secrets, timeoutSeconds: 300 }, async (request) => {
  const uid = uidOf(request);
  const now = new Date();
  if (!signedInRecently(request.auth?.token.auth_time, now)) {
    throw new HttpsError('failed-precondition', 'Enter your password again to delete the account.');
  }
  try {
    // A deployed instance always has billing on (a deploy refuses a function whose
    // secret does not exist), but a secret set to an empty value reads as off. Only the
    // emulator may skip Stripe.
    await deleteAccountOf(uid, {
      stripe: stripeConfig(),
      billingRequired: process.env.FUNCTIONS_EMULATOR !== 'true',
      now,
    });
  } catch (err) {
    if (!(err instanceof StripeError) && !(err instanceof BillingOffError)) throw err;
    logger.error(`[account] user=${uid}: ending the subscription was refused, nothing deleted: ${err.message}`);
    throw new HttpsError(
      'unavailable',
      'Your subscription could not be cancelled right now, so nothing was deleted. Try again shortly.'
    );
  }
  return { deleted: true };
});

/**
 * Nine minutes, the most a scheduled function may have, not the default one: this is
 * also what finishes a deletion the callable was cut off in the middle of, which is by
 * definition an account too large for five minutes. On the default, each hourly run
 * would spend its minute on that one marker and be killed, and every deletion queued
 * behind it would wait an hour per run, past the two hours the public page promises.
 */
export const finishAccountDeletions = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'Etc/UTC', timeoutSeconds: 540, secrets },
  async () => {
    const finished = await finishDeletions(new Date(), { stripe: stripeConfig() });
    if (finished.length > 0) {
      logger.info(`finishAccountDeletions: finished ${finished.length} deletion${finished.length === 1 ? '' : 's'}`);
    }
  }
);
