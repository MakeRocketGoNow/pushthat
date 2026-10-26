import { Timestamp } from 'firebase-admin/firestore';

import { LIMITS, usageOf } from '../../src/plan';
import { NewPush, recordPush } from '../../src/usage';
import { clearFirestore, closeFirestore, db, millisOf, userDoc } from './harness';

/**
 * `recordPush`, the count `onNewPushCreated` keeps, against the Firestore emulator: the
 * user document it makes or adds to, the file push's expiry, and the limit it applies a
 * second time, deleting what the rules let through before the count caught up.
 */

const NOW = new Date(Date.UTC(2026, 9, 25, 12));
const DAY_MS = 24 * 60 * 60 * 1000;
const UID = 'user_1';
// Anchored on the 1st, so the period is the calendar month of NOW.
const CREATED = Timestamp.fromDate(new Date(Date.UTC(2026, 0, 1)));
const { periodKey } = usageOf({ createdAt: CREATED }, NOW);
const PRO = { type: 'pro', startedAt: CREATED, expiresAt: Timestamp.fromDate(new Date(Date.UTC(2027, 0, 1))) };

const emailOf = async (uid: string) => `${uid}@example.com`;

const seedUser = (fields: Record<string, unknown>) => db().collection('users').doc(UID).set(fields);

/** A push as a client made it, past the rules; returns its reference and what the event carries. */
async function makePush(type: NewPush['type'] = 'url') {
  const ref = await db()
    .collection('pushes')
    .add({ userId: UID, type, url: 'https://example.com/a', title: 'a', createdAt: Timestamp.fromDate(NOW) });
  return { ref, push: { userId: UID, type } as NewPush };
}

const record = (made: Awaited<ReturnType<typeof makePush>>) =>
  recordPush(db(), made.ref, made.push, NOW, { emailOf });

afterAll(() => closeFirestore());
beforeEach(() => clearFirestore());

test('counts a URL push, making the user document when there is none', async () => {
  const made = await makePush();

  expect(await record(made)).toBe('counted');

  const user = await userDoc(UID);
  expect(user.email).toBe('user_1@example.com');
  expect(millisOf(user.createdAt)).toBe(NOW.getTime());
  expect(user.usageRecords).toEqual({ [periodKey]: { url: 1 } });
  expect((await made.ref.get()).data()?.expiresAt).toBeUndefined();
});

test("adds to the period's count and leaves the rest of the document alone", async () => {
  await seedUser({ createdAt: CREATED, fcmTokens: ['t1'], usageRecords: { [periodKey]: { url: 5, file: 1 } } });

  await record(await makePush());
  await record(await makePush('file'));

  const user = await userDoc(UID);
  expect(user.usageRecords).toEqual({ [periodKey]: { url: 6, file: 2 } });
  expect(user.fcmTokens).toEqual(['t1']);
  expect(millisOf(user.createdAt)).toBe(CREATED.toMillis());
});

test('gives a document without createdAt the day it is counted from', async () => {
  await seedUser({ fcmTokens: ['t1'] });

  await record(await makePush());

  const user = await userDoc(UID);
  expect(millisOf(user.createdAt)).toBe(NOW.getTime());
  expect(user.usageRecords).toEqual({ [usageOf({ createdAt: Timestamp.fromDate(NOW) }, NOW).periodKey]: { url: 1 } });
});

test("stamps a file push with the tier's expiry: 7 days on Free, 30 on Pro", async () => {
  const free = await makePush('file');
  await record(free);
  expect(millisOf((await free.ref.get()).data()?.expiresAt)).toBe(NOW.getTime() + LIMITS.free.keepDays * DAY_MS);

  await clearFirestore();
  await seedUser({ createdAt: CREATED, subscription: PRO });
  const pro = await makePush('file');
  await record(pro);
  expect(millisOf((await pro.ref.get()).data()?.expiresAt)).toBe(NOW.getTime() + LIMITS.pro.keepDays * DAY_MS);
});

test('a push deleted before it was counted still counts, and is not brought back', async () => {
  const made = await makePush('file');
  await made.ref.delete();

  expect(await record(made)).toBe('counted');

  expect((await made.ref.get()).exists).toBe(false);
  expect((await userDoc(UID)).usageRecords).toEqual({ [periodKey]: { file: 1 } });
});

describe('the limit, applied again where the count is exact', () => {
  test('a push that lands over it is deleted and not counted', async () => {
    await seedUser({ createdAt: CREATED, usageRecords: { [periodKey]: { url: LIMITS.free.url } } });
    const made = await makePush();

    expect(await record(made)).toBe('refused');

    expect((await made.ref.get()).exists).toBe(false);
    expect((await userDoc(UID)).usageRecords).toEqual({ [periodKey]: { url: LIMITS.free.url } });
  });

  test('a file push over it is deleted before it is given an expiry', async () => {
    await seedUser({ createdAt: CREATED, usageRecords: { [periodKey]: { file: LIMITS.free.file } } });
    const made = await makePush('file');

    expect(await record(made)).toBe('refused');
    expect((await made.ref.get()).exists).toBe(false);
  });

  test('a burst past it keeps only as many as the month had left', async () => {
    await seedUser({ createdAt: CREATED, usageRecords: { [periodKey]: { url: LIMITS.free.url - 2 } } });
    const burst = await Promise.all([makePush(), makePush(), makePush(), makePush(), makePush()]);

    const outcomes = await Promise.all(burst.map(record));

    expect(outcomes.filter((o) => o === 'counted')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(3);
    expect((await userDoc(UID)).usageRecords).toEqual({ [periodKey]: { url: LIMITS.free.url } });
    const left = await Promise.all(burst.map(async (made) => (await made.ref.get()).exists));
    expect(left.filter(Boolean)).toHaveLength(2);
  });

  test('Pro is counted past the Free limit', async () => {
    await seedUser({ createdAt: CREATED, subscription: PRO, usageRecords: { [periodKey]: { url: LIMITS.free.url } } });
    const made = await makePush();

    expect(await record(made)).toBe('counted');
    expect((await userDoc(UID)).usageRecords).toEqual({ [periodKey]: { url: LIMITS.free.url + 1 } });
  });

  test('a lapsed subscription is held to Free', async () => {
    await seedUser({
      createdAt: CREATED,
      subscription: { ...PRO, expiresAt: Timestamp.fromDate(new Date(NOW.getTime() - 1000)) },
      usageRecords: { [periodKey]: { url: LIMITS.free.url } },
    });

    expect(await record(await makePush())).toBe('refused');
  });
});
