import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { onSchedule } from 'firebase-functions/v2/scheduler';

/**
 * Orphaned uploads (docs/billing.md): a client uploads a file to `uploads/{uid}/{name}`
 * before it makes the push that names it, so an upload whose push never comes (a crash,
 * a killed app, or anyone signed in calling the Storage SDK directly) is held by nothing.
 * The expiry sweep and `onPushRecordDeleted` act only on push documents, so without this
 * those bytes would be kept, and could be downloaded, for good.
 *
 * Once a day this lists the objects under `uploads/` and deletes those no file push
 * refers to. An object younger than the grace period is left alone: an upload in flight
 * has no push yet, and Android's `RetryPushWorker` makes the push for a file uploaded
 * just before the network dropped only once it is back, which can be days later.
 *
 * A push refers to an object by its path, `uploads/${userId}/${title}`, the path
 * `onPushRecordDeleted` deletes, and also by the path in its download URL; either keeps
 * the object, so a push whose title and URL disagree never loses its file. The pushes
 * are read once per user with objects, by `userId` and `type`, two equality filters
 * that need no composite index. A file push with no `userId` (none is made now) holds no
 * object, since neither `onPushRecordDeleted` nor this can say whose it is, and its file
 * goes after the grace like any other orphan. Deletions are capped per run, so a backlog drains over a
 * few days; the listing and the per-user reads cover the whole bucket every run, a page
 * of users' reads at a time, inside a nine-minute timeout. A run cut off partway starts
 * again at the first page the next day; at a size where that matters, it would keep the
 * listing's page token between runs.
 */

/**
 * How old an unreferenced upload must be before it is deleted: the shortest retention, so
 * an orphan is kept no longer than a Free file would be, and long enough for Android's
 * `RetryPushWorker`, which runs only with a network, to make the push for a file it
 * uploaded before the device went offline for a weekend or a flight.
 */
export const ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const ORPHAN_PAGE = 1000;
/**
 * The most uploads one run deletes. Well above what a client's crash or failed cleanup
 * leaves, and above what one account uploading straight to Storage can add in a day, so a
 * backlog shrinks rather than grows; ten thousand deletes take a minute or two of the
 * nine the run has. Daily rather than hourly, since every run lists the whole bucket.
 */
export const ORPHAN_MAX_PER_RUN = 10_000;
/** How many users' pushes are read at once. */
export const ORPHAN_READ_CHUNK = 20;
/** How many deletes are in flight at once. */
export const ORPHAN_DELETE_CHUNK = 50;

/** An object as the listing gives it: its path and when it was created. */
export interface StoredObject {
  name: string;
  timeCreated?: string;
}

/** The upload paths a push refers to: from its title, and from its download URL. */
export function uploadPathsOf(push: { userId?: unknown; title?: unknown; url?: unknown }): string[] {
  const paths: string[] = [];
  if (typeof push.userId === 'string' && typeof push.title === 'string') {
    paths.push(`uploads/${push.userId}/${push.title}`);
  }
  if (typeof push.url === 'string') {
    // A Firebase download URL: https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=...
    const match = push.url.match(/\/o\/([^?#]+)/);
    if (match) {
      try {
        paths.push(decodeURIComponent(match[1]));
      } catch {
        // Not a well-formed escape; the title's path still stands.
      }
    }
  }
  return paths;
}

/** The uid an upload belongs to, or undefined for an object not at `uploads/{uid}/{name}`. */
export function uploaderOf(name: string): string | undefined {
  const parts = name.split('/');
  return parts.length === 3 && parts[0] === 'uploads' && parts[1] && parts[2] ? parts[1] : undefined;
}

/**
 * The objects to delete: those at `uploads/{uid}/{name}`, older than the grace period,
 * whose path no push refers to. An object with no readable creation time is kept, as is
 * anything else under `uploads/` (a folder placeholder, say), since none was put there
 * by a push.
 */
export function orphanedUploads(
  objects: StoredObject[],
  referenced: ReadonlySet<string>,
  now: Date,
  graceMs = ORPHAN_GRACE_MS
): string[] {
  return objects
    .filter((object) => {
      if (!uploaderOf(object.name) || referenced.has(object.name)) return false;
      const createdAt = object.timeCreated ? Date.parse(object.timeCreated) : NaN;
      return Number.isFinite(createdAt) && createdAt <= now.getTime() - graceMs;
    })
    .map((object) => object.name);
}

/**
 * Deletes every upload no file push refers to and older than the grace, up to `max`;
 * returns the paths. The grace and the page size are the constants' unless a test gives
 * its own: the Storage emulator cannot backdate an object, and paging needs a small page.
 */
export async function sweepOrphanedUploads(
  now: Date,
  { max = ORPHAN_MAX_PER_RUN, graceMs = ORPHAN_GRACE_MS, pageSize = ORPHAN_PAGE } = {}
): Promise<string[]> {
  const db = getFirestore();
  const bucket = getStorage().bucket();
  // The paths each user's file pushes refer to, read once per run per user.
  const referencedBy = new Map<string, Set<string>>();
  const deleted: string[] = [];
  let pageToken: string | undefined;
  do {
    const [files, next] = await bucket.getFiles({
      prefix: 'uploads/',
      autoPaginate: false,
      maxResults: pageSize,
      pageToken,
    });
    pageToken = (next as { pageToken?: string } | null)?.pageToken;

    // The page's new uploaders' pushes, read a group at a time rather than one after
    // another: a sequential query per user is what would run a large bucket past the
    // function's timeout.
    const unread = [...new Set(files.map((file) => uploaderOf(file.name)))].filter(
      (uid): uid is string => !!uid && !referencedBy.has(uid)
    );
    for (let i = 0; i < unread.length; i += ORPHAN_READ_CHUNK) {
      await Promise.all(
        unread.slice(i, i + ORPHAN_READ_CHUNK).map(async (uid) => {
          const pushes = await db
            .collection('pushes')
            .where('userId', '==', uid)
            .where('type', '==', 'file')
            .select('userId', 'title', 'url')
            .get();
          referencedBy.set(uid, new Set(pushes.docs.flatMap((doc) => uploadPathsOf(doc.data()))));
        })
      );
    }
    const referenced = new Set<string>();
    for (const file of files) {
      const uid = uploaderOf(file.name);
      if (uid) for (const path of referencedBy.get(uid)!) referenced.add(path);
    }

    const objects = files.map((file) => ({ name: file.name, timeCreated: file.metadata.timeCreated }));
    const orphans = orphanedUploads(objects, referenced, now, graceMs).slice(0, max - deleted.length);
    // A handful at a time, so a page of orphans is not a thousand requests at once. Each
    // delete is logged as it lands and one that fails is logged and passed over, so a run
    // that is cut off or meets a GCS error still says which files it has removed.
    for (let i = 0; i < orphans.length; i += ORPHAN_DELETE_CHUNK) {
      const chunk = orphans.slice(i, i + ORPHAN_DELETE_CHUNK);
      const results = await Promise.allSettled(chunk.map((name) => bucket.file(name).delete({ ignoreNotFound: true })));
      results.forEach((result, j) => {
        if (result.status === 'fulfilled') {
          logger.info(`deleteOrphanedUploads: deleted ${chunk[j]}`);
          deleted.push(chunk[j]);
        } else {
          logger.error(`deleteOrphanedUploads: could not delete ${chunk[j]}`, result.reason);
        }
      });
    }
  } while (pageToken && deleted.length < max);
  return deleted;
}

export const deleteOrphanedUploads = onSchedule(
  { schedule: 'every day 04:00', timeZone: 'Etc/UTC', timeoutSeconds: 540 },
  async () => {
    const deleted = await sweepOrphanedUploads(new Date());
    logger.info(`deleteOrphanedUploads: deleted ${deleted.length} orphaned upload${deleted.length === 1 ? '' : 's'}`);
    if (deleted.length >= ORPHAN_MAX_PER_RUN)
      logger.warn(`deleteOrphanedUploads: hit the per-run cap of ${ORPHAN_MAX_PER_RUN}; a backlog remains`);
  }
);
