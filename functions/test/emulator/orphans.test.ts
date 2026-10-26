import { getStorage } from 'firebase-admin/storage';

import { sweepOrphanedUploads } from '../../src/orphans';
import { BUCKET, clearFirestore, closeFirestore, db } from './harness';

/**
 * The orphan sweep against the Firestore and Storage emulators: the listing and its
 * pages, the per-user read of pushes, the cap, and the deletes, which the unit tests of
 * the pure selection in `src/orphans.test.ts` do not reach. The emulator stamps every
 * object with the time it was written, so "old" here is a grace of zero and "young" a
 * grace longer than the test.
 */

const bucket = () => getStorage().bucket();

async function clearBucket(): Promise<void> {
  const [files] = await bucket().getFiles({ prefix: 'uploads/' });
  await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
}

const upload = (path: string) => bucket().file(path).save(Buffer.from('x'));

/** The download URL a client stores in a push for `path`. */
const downloadUrl = (path: string) =>
  `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media&token=t`;

async function push(fields: Record<string, unknown>): Promise<void> {
  await db()
    .collection('pushes')
    .add({ type: 'file', ...fields });
}

async function remaining(): Promise<string[]> {
  const [files] = await bucket().getFiles({ prefix: 'uploads/' });
  return files.map((file) => file.name).sort();
}

beforeEach(async () => {
  await clearFirestore();
  await clearBucket();
});
afterAll(async () => {
  await clearBucket();
  await closeFirestore();
});

test('deletes what no file push names, and keeps what one names by title or by URL', async () => {
  await Promise.all(
    ['uploads/u1/by-title.pdf', 'uploads/u1/by-url.pdf', 'uploads/u1/orphan.pdf', 'uploads/u2/theirs.pdf'].map(upload)
  );
  await push({ userId: 'u1', title: 'by-title.pdf', url: 'https://elsewhere.example/x' });
  // A title that names nothing, and a URL that names the object: the URL keeps it.
  await push({ userId: 'u1', title: 'renamed.pdf', url: downloadUrl('uploads/u1/by-url.pdf') });
  await push({ userId: 'u2', title: 'theirs.pdf', url: downloadUrl('uploads/u2/theirs.pdf') });

  const deleted = await sweepOrphanedUploads(new Date(), { graceMs: 0 });

  expect(deleted).toEqual(['uploads/u1/orphan.pdf']);
  expect(await remaining()).toEqual(['uploads/u1/by-title.pdf', 'uploads/u1/by-url.pdf', 'uploads/u2/theirs.pdf']);
});

test('a URL push does not hold a file, and a push of another user does not either', async () => {
  await upload('uploads/u1/a.pdf');
  await push({ userId: 'u1', type: 'url', title: 'a.pdf', url: 'https://example.com' });
  await push({ userId: 'u2', title: 'a.pdf', url: downloadUrl('uploads/u2/a.pdf') });

  expect(await sweepOrphanedUploads(new Date(), { graceMs: 0 })).toEqual(['uploads/u1/a.pdf']);
});

test('an upload younger than the grace is kept', async () => {
  await upload('uploads/u1/in-flight.pdf');

  expect(await sweepOrphanedUploads(new Date(), { graceMs: 60 * 60 * 1000 })).toEqual([]);
  expect(await remaining()).toEqual(['uploads/u1/in-flight.pdf']);
});

test('reads every page', async () => {
  const paths = ['uploads/u1/a', 'uploads/u1/b', 'uploads/u1/c', 'uploads/u2/a', 'uploads/u2/b'];
  await Promise.all(paths.map(upload));
  await push({ userId: 'u1', title: 'b' });
  await push({ userId: 'u2', title: 'b' });

  const deleted = await sweepOrphanedUploads(new Date(), { graceMs: 0, pageSize: 2 });

  expect(deleted.sort()).toEqual(['uploads/u1/a', 'uploads/u1/c', 'uploads/u2/a']);
  expect(await remaining()).toEqual(['uploads/u1/b', 'uploads/u2/b']);
});

test('stops at the cap, and the next run takes the rest', async () => {
  await Promise.all(['uploads/u1/1', 'uploads/u1/2', 'uploads/u1/3', 'uploads/u1/4', 'uploads/u1/5'].map(upload));

  expect(await sweepOrphanedUploads(new Date(), { graceMs: 0, max: 2, pageSize: 2 })).toHaveLength(2);
  expect(await remaining()).toHaveLength(3);
  expect(await sweepOrphanedUploads(new Date(), { graceMs: 0 })).toHaveLength(3);
  expect(await remaining()).toEqual([]);
});

test('anything not at uploads/{uid}/{name} is left alone', async () => {
  await Promise.all(['uploads/stray', 'uploads/u1/nested/deeper.pdf'].map(upload));

  expect(await sweepOrphanedUploads(new Date(), { graceMs: 0 })).toEqual([]);
  expect(await remaining()).toEqual(['uploads/stray', 'uploads/u1/nested/deeper.pdf']);
});
