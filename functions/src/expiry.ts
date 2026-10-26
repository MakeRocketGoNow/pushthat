import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import { PlanUser, limitsOf } from './plan';

/**
 * File expiry (docs/billing.md): a file push is kept for 7 days on Free and 30 on Pro,
 * then deleted. A push is a hand-off to another device, not storage, and the stored
 * bytes and their downloads are the one cost an account can run up; the retention is
 * what bounds it.
 *
 * `onNewPushCreated` stamps every file push with `expiresAt` from the tier it was pushed
 * on, and this sweep deletes the push documents whose time has come. Deleting the
 * document is enough: `onPushRecordDeleted` removes the stored file, as it does for a
 * push deleted by hand. A URL push has no `expiresAt` and is kept for good.
 *
 * A single-field query, so it needs no composite index. Bounded per run: a backlog
 * (the sweep off for a while, or the first run after the backfill) drains over a few
 * hours rather than in one long invocation. Deleting in batches of the commit limit.
 */

export const EXPIRY_BATCH = 500;
export const EXPIRY_MAX_PER_RUN = 2000;

/** Deletes every file push whose `expiresAt` is at or before `now`, up to `max`; returns how many. */
export async function sweepExpiredPushes(now: Date, max = EXPIRY_MAX_PER_RUN): Promise<number> {
  const db = getFirestore();
  let deleted = 0;
  while (deleted < max) {
    const page = await db
      .collection('pushes')
      .where('expiresAt', '<=', Timestamp.fromDate(now))
      .orderBy('expiresAt')
      .limit(Math.min(EXPIRY_BATCH, max - deleted))
      .get();
    if (page.empty) break;
    const batch = db.batch();
    for (const doc of page.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += page.size;
    if (page.size < EXPIRY_BATCH) break;
  }
  return deleted;
}

/** Where the one-off backfill below records that it has run, so it never runs twice. */
const BACKFILL_MARKER = 'system/expiryBackfill';

/**
 * Stamps the file pushes made before expiry existed with `expiresAt`, once: the tier's
 * retention counted from the push, which for a file older than that is at once, so the
 * sweep then deletes them like any other. On the server rather than as a script, since
 * the function already has the credentials and a script from a laptop needs its own.
 * Reads every file push, since Firestore cannot query for a missing field; there are
 * few enough that one pass is fine, and the marker keeps it to one. An update, not a
 * merge-set, so a push deleted meanwhile stays deleted (the update fails, and is
 * skipped).
 */
export async function stampLegacyFilePushes(now: Date): Promise<number> {
  const db = getFirestore();
  const marker = db.doc(BACKFILL_MARKER);
  if ((await marker.get()).exists) return 0;
  const pushes = await db.collection('pushes').where('type', '==', 'file').get();
  const users = new Map<string, PlanUser | undefined>();
  let stamped = 0;
  for (const doc of pushes.docs) {
    const data = doc.data();
    if (data.expiresAt || typeof data.userId !== 'string') continue;
    if (!users.has(data.userId)) {
      users.set(data.userId, (await db.collection('users').doc(data.userId).get()).data() as PlanUser | undefined);
    }
    const createdAt = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : now.getTime();
    const keepDays = limitsOf(users.get(data.userId), now).keepDays;
    try {
      await doc.ref.update({ expiresAt: Timestamp.fromMillis(createdAt + keepDays * 24 * 60 * 60 * 1000) });
      stamped++;
    } catch (err) {
      if ((err as { code?: number }).code !== 5) throw err; // NOT_FOUND: deleted meanwhile
    }
  }
  await marker.set({ done: true, stamped, at: now });
  return stamped;
}

export const expireFilePushes = onSchedule({ schedule: 'every 60 minutes', timeZone: 'Etc/UTC' }, async () => {
  const stamped = await stampLegacyFilePushes(new Date());
  if (stamped)
    logger.info(`expireFilePushes: stamped ${stamped} older file push${stamped === 1 ? '' : 'es'} with an expiry`);
  const deleted = await sweepExpiredPushes(new Date());
  logger.info(`expireFilePushes: deleted ${deleted} expired file push${deleted === 1 ? '' : 'es'}`);
  // A run that hits the cap leaves a backlog for the next, and the 7 and 30 days are
  // slipping by however much it is; said at a severity that stands out.
  if (deleted >= EXPIRY_MAX_PER_RUN)
    logger.warn(`expireFilePushes: hit the per-run cap of ${EXPIRY_MAX_PER_RUN}; a backlog remains`);
});
