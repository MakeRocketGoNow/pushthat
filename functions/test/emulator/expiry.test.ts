import { Timestamp } from 'firebase-admin/firestore';

import { EXPIRY_BATCH, stampLegacyFilePushes, sweepExpiredPushes } from '../../src/expiry';
import { LIMITS } from '../../src/plan';
import { clearFirestore, closeFirestore, db } from './harness';

/**
 * The file-expiry sweep and the one-off backfill, against the Firestore emulator: the
 * query, the paging and the marker are what the pure tests cannot reach.
 */

const NOW = new Date(Date.UTC(2026, 9, 25, 12));
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (ms: number) => Timestamp.fromMillis(NOW.getTime() + ms);

afterAll(() => closeFirestore());

beforeEach(() => clearFirestore());

/** Writes `count` pushes made by `make(i)`, in batches the commit limit allows. */
async function seedPushes(count: number, make: (i: number) => Record<string, unknown>, prefix: string) {
  for (let from = 0; from < count; from += 500) {
    const batch = db().batch();
    for (let i = from; i < Math.min(count, from + 500); i++) {
      batch.set(db().collection('pushes').doc(`${prefix}_${i}`), make(i));
    }
    await batch.commit();
  }
}

const pushIds = async () => (await db().collection('pushes').get()).docs.map((d) => d.id).sort();

describe('sweepExpiredPushes', () => {
  test('deletes only the file pushes whose time has come, paging past its batch', async () => {
    const expired = EXPIRY_BATCH + 20;
    await seedPushes(expired, (i) => ({ type: 'file', userId: 'u', expiresAt: at(-(i + 1) * 1000) }), 'old');
    // Due at the very moment: `<=`.
    await seedPushes(1, () => ({ type: 'file', userId: 'u', expiresAt: at(0) }), 'due');
    await seedPushes(3, (i) => ({ type: 'file', userId: 'u', expiresAt: at((i + 1) * DAY_MS) }), 'later');
    // A URL push has no `expiresAt` and is kept for good.
    await seedPushes(2, () => ({ type: 'url', userId: 'u', url: 'https://example.com' }), 'url');

    expect(await sweepExpiredPushes(NOW)).toBe(expired + 1);

    expect(await pushIds()).toEqual(['later_0', 'later_1', 'later_2', 'url_0', 'url_1']);
  });

  test('stops at `max`, oldest first, and the next run takes the rest', async () => {
    await seedPushes(30, (i) => ({ type: 'file', userId: 'u', expiresAt: at(-(30 - i) * 1000) }), 'old');

    expect(await sweepExpiredPushes(NOW, 10)).toBe(10);
    const left = await pushIds();
    expect(left).toHaveLength(20);
    // `old_0` expired first, so the first ten are the ones gone.
    expect(left).not.toContain('old_0');
    expect(left).not.toContain('old_9');
    expect(left).toContain('old_10');

    expect(await sweepExpiredPushes(NOW, 100)).toBe(20);
    expect(await pushIds()).toEqual([]);
  });

  test('nothing due is nothing deleted', async () => {
    await seedPushes(2, () => ({ type: 'file', userId: 'u', expiresAt: at(DAY_MS) }), 'later');
    expect(await sweepExpiredPushes(NOW)).toBe(0);
    expect(await pushIds()).toHaveLength(2);
  });
});

describe('stampLegacyFilePushes', () => {
  const PRO_USER = {
    subscription: { type: 'pro', expiresAt: at(100 * DAY_MS), status: 'active' },
  };

  async function seedLegacy() {
    await db()
      .collection('users')
      .doc('u_free')
      .set({ createdAt: at(-400 * DAY_MS) });
    await db().collection('users').doc('u_pro').set(PRO_USER);
    const pushes = db().collection('pushes');
    await pushes.doc('free_recent').set({ type: 'file', userId: 'u_free', createdAt: at(-2 * DAY_MS) });
    await pushes.doc('pro_old').set({ type: 'file', userId: 'u_pro', createdAt: at(-40 * DAY_MS) });
    await pushes.doc('no_created').set({ type: 'file', userId: 'u_free' });
    await pushes
      .doc('stamped')
      .set({ type: 'file', userId: 'u_free', createdAt: at(-1 * DAY_MS), expiresAt: at(DAY_MS) });
    await pushes.doc('url').set({ type: 'url', userId: 'u_free', createdAt: at(-DAY_MS) });
    await pushes.doc('no_user').set({ type: 'file', createdAt: at(-DAY_MS) });
  }

  const expiresAt = async (id: string) =>
    ((await db().collection('pushes').doc(id).get()).get('expiresAt') as Timestamp | undefined)?.toMillis();

  test("stamps each older file push with its tier's retention from the push, and records that it ran", async () => {
    await seedLegacy();

    expect(await stampLegacyFilePushes(NOW)).toBe(3);

    expect(await expiresAt('free_recent')).toBe(NOW.getTime() + (-2 + LIMITS.free.keepDays) * DAY_MS);
    expect(await expiresAt('pro_old')).toBe(NOW.getTime() + (-40 + LIMITS.pro.keepDays) * DAY_MS);
    // No `createdAt`: counted from the run.
    expect(await expiresAt('no_created')).toBe(NOW.getTime() + LIMITS.free.keepDays * DAY_MS);
    // Already stamped, a URL push, and a push with no owner are left as they were.
    expect(await expiresAt('stamped')).toBe(NOW.getTime() + DAY_MS);
    expect(await expiresAt('url')).toBeUndefined();
    expect(await expiresAt('no_user')).toBeUndefined();

    const marker = (await db().doc('system/expiryBackfill').get()).data();
    expect(marker).toMatchObject({ done: true, stamped: 3 });

    // The Pro push from forty days ago is past its thirty: the sweep takes it at once.
    expect(await sweepExpiredPushes(NOW)).toBe(1);
    expect((await db().collection('pushes').doc('pro_old').get()).exists).toBe(false);
  });

  test('runs once: a second run stamps nothing, even a push it would have', async () => {
    await seedLegacy();
    await stampLegacyFilePushes(NOW);
    await db()
      .collection('pushes')
      .doc('later_legacy')
      .set({ type: 'file', userId: 'u_free', createdAt: at(0) });

    expect(await stampLegacyFilePushes(new Date(NOW.getTime() + DAY_MS))).toBe(0);
    expect(await expiresAt('later_legacy')).toBeUndefined();
    expect((await db().doc('system/expiryBackfill').get()).data()).toMatchObject({ stamped: 3 });
  });

  test('a database with no older pushes still records the run', async () => {
    expect(await stampLegacyFilePushes(NOW)).toBe(0);
    expect((await db().doc('system/expiryBackfill').get()).exists).toBe(true);
  });
});
