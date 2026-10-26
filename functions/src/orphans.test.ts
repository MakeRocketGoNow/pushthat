import {
  ORPHAN_GRACE_MS,
  ORPHAN_PENDING_PER_USER,
  orphanedUploads,
  storagePathOf,
  uploadPathsOf,
  uploaderOf,
} from './orphans';

const NOW = new Date('2026-10-25T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const OLD = ago(ORPHAN_GRACE_MS + HOUR);

describe('the paths a push refers to', () => {
  test('its title under the uploader, as onPushRecordDeleted deletes it', () =>
    expect(uploadPathsOf({ userId: 'u1', title: 'photo.jpg' })).toEqual(['uploads/u1/photo.jpg']));
  test('and the path in its download URL, decoded', () =>
    expect(
      uploadPathsOf({
        userId: 'u1',
        title: 'photo.jpg',
        url: 'https://firebasestorage.googleapis.com/v0/b/push-that.appspot.com/o/uploads%2Fu1%2Fmy%20photo%20(1).jpg?alt=media&token=abc',
      })
    ).toEqual(['uploads/u1/photo.jpg', 'uploads/u1/my photo (1).jpg']));
  test('a URL that is not a Storage download URL adds nothing', () =>
    expect(uploadPathsOf({ userId: 'u1', title: 'a.txt', url: 'https://example.com/a.txt' })).toEqual([
      'uploads/u1/a.txt',
    ]));
  test('a malformed escape in the URL adds nothing', () =>
    expect(uploadPathsOf({ url: 'https://firebasestorage.googleapis.com/v0/b/x/o/uploads%2Fu1%2F%E0' })).toEqual([]));
  test('no title or user adds nothing from them', () => expect(uploadPathsOf({ userId: 'u1' })).toEqual([]));
  test("an encrypted push's objectPath", () =>
    expect(uploadPathsOf({ userId: 'u1', objectPath: 'uploads/u1/AAAA', enc: { v: 1 } })).toEqual(['uploads/u1/AAAA']));
  test('an encrypted push holds nothing by a title or URL it should not have', () =>
    expect(
      uploadPathsOf({
        userId: 'u1',
        title: 'a.pdf',
        url: 'https://firebasestorage.googleapis.com/v0/b/x/o/uploads%2Fu1%2Fa.pdf',
        enc: { v: 1 },
      })
    ).toEqual([]));
  test("a migrated push's objectPath, which is its old title's path", () =>
    expect(uploadPathsOf({ userId: 'u1', objectPath: 'uploads/u1/a.pdf', enc: { v: 1 } })).toEqual([
      'uploads/u1/a.pdf',
    ]));
  test("an objectPath under another account's folder is not the push's", () =>
    expect(uploadPathsOf({ userId: 'u1', objectPath: 'uploads/u2/AAAA', enc: { v: 1 } })).toEqual([]));
});

describe('the object a deleted file push takes with it', () => {
  test("an encrypted push's objectPath", () =>
    expect(storagePathOf({ userId: 'u1', objectPath: 'uploads/u1/AAAA', enc: { v: 1 } })).toBe('uploads/u1/AAAA'));
  test("a plaintext push's title under its uploader", () =>
    expect(storagePathOf({ userId: 'u1', title: 'photo.jpg' })).toBe('uploads/u1/photo.jpg'));
  test('an encrypted push with no objectPath names nothing, title or not', () =>
    expect(storagePathOf({ userId: 'u1', title: 'photo.jpg', enc: { v: 1 } })).toBeUndefined());
  test("an objectPath outside the push's own folder names nothing", () => {
    expect(storagePathOf({ userId: 'u1', objectPath: 'uploads/u2/AAAA', enc: { v: 1 } })).toBeUndefined();
    expect(storagePathOf({ userId: 'u1', objectPath: 'uploads/u1/a/b', enc: { v: 1 } })).toBeUndefined();
    expect(storagePathOf({ userId: 'u1', objectPath: 'other/u1/AAAA', enc: { v: 1 } })).toBeUndefined();
  });
  test('a push with no user names nothing', () => expect(storagePathOf({ title: 'photo.jpg' })).toBeUndefined());
});

describe('the uploader', () => {
  test('is the folder under uploads/', () => expect(uploaderOf('uploads/u1/a.txt')).toBe('u1'));
  test('is none for the folder itself, deeper paths or other prefixes', () => {
    expect(uploaderOf('uploads/u1/')).toBeUndefined();
    expect(uploaderOf('uploads/u1')).toBeUndefined();
    expect(uploaderOf('uploads/u1/a/b.txt')).toBeUndefined();
    expect(uploaderOf('other/u1/a.txt')).toBeUndefined();
  });
});

describe('the orphans', () => {
  const referenced = new Set(['uploads/u1/kept.jpg']);

  test('an old upload no push names is one', () =>
    expect(orphanedUploads([{ name: 'uploads/u1/lost.jpg', timeCreated: OLD }], referenced, NOW)).toEqual([
      'uploads/u1/lost.jpg',
    ]));
  test('an upload a push names is not', () =>
    expect(orphanedUploads([{ name: 'uploads/u1/kept.jpg', timeCreated: OLD }], referenced, NOW)).toEqual([]));
  test('an upload inside the grace period is not, since its push may yet come', () =>
    expect(orphanedUploads([{ name: 'uploads/u1/new.jpg', timeCreated: ago(HOUR) }], referenced, NOW)).toEqual([]));
  test('an upload exactly at the grace period is one', () =>
    expect(
      orphanedUploads([{ name: 'uploads/u1/edge.jpg', timeCreated: ago(ORPHAN_GRACE_MS) }], referenced, NOW)
    ).toEqual(['uploads/u1/edge.jpg']));
  test('the grace can be given', () =>
    expect(
      orphanedUploads([{ name: 'uploads/u1/new.jpg', timeCreated: ago(2 * HOUR) }], referenced, NOW, { graceMs: HOUR })
    ).toEqual(['uploads/u1/new.jpg']));
  test('an upload with no readable creation time is kept', () => {
    expect(orphanedUploads([{ name: 'uploads/u1/a.jpg' }], referenced, NOW)).toEqual([]);
    expect(orphanedUploads([{ name: 'uploads/u1/a.jpg', timeCreated: 'soon' }], referenced, NOW)).toEqual([]);
  });
  test('a name pushed by another user does not keep this one', () =>
    expect(orphanedUploads([{ name: 'uploads/u2/kept.jpg', timeCreated: OLD }], referenced, NOW)).toEqual([
      'uploads/u2/kept.jpg',
    ]));
  test('an account may hold only so many uploads with no push inside the grace', () => {
    const young = (uid: string, i: number) => ({ name: `uploads/${uid}/${i}.bin`, timeCreated: ago(HOUR) });
    const objects = Array.from({ length: ORPHAN_PENDING_PER_USER + 2 }, (_, i) => young('u1', i));
    expect(orphanedUploads(objects, referenced, NOW)).toEqual([
      `uploads/u1/${ORPHAN_PENDING_PER_USER}.bin`,
      `uploads/u1/${ORPHAN_PENDING_PER_USER + 1}.bin`,
    ]);
  });
  test("the cap is per account, and a push's upload does not count against it", () => {
    const young = (uid: string, name: string) => ({ name: `uploads/${uid}/${name}`, timeCreated: ago(HOUR) });
    const objects = [young('u1', 'kept.jpg'), young('u1', 'a'), young('u1', 'b'), young('u2', 'a'), young('u2', 'b')];
    expect(orphanedUploads(objects, referenced, NOW, { pendingMax: 2 })).toEqual([]);
    expect(orphanedUploads([...objects, young('u1', 'c')], referenced, NOW, { pendingMax: 2 })).toEqual([
      'uploads/u1/c',
    ]);
  });
  test('the count carries across calls, as it does across the pages of a listing', () => {
    const pending = new Map<string, number>();
    const young = (name: string) => ({ name: `uploads/u1/${name}`, timeCreated: ago(HOUR) });
    expect(orphanedUploads([young('a'), young('b')], referenced, NOW, { pendingMax: 3, pending })).toEqual([]);
    expect(orphanedUploads([young('c'), young('d')], referenced, NOW, { pendingMax: 3, pending })).toEqual([
      'uploads/u1/d',
    ]);
  });
  test('anything not at uploads/{uid}/{name} is left alone', () =>
    expect(
      orphanedUploads(
        [
          { name: 'uploads/u1/', timeCreated: OLD },
          { name: 'uploads/u1/a/b.jpg', timeCreated: OLD },
        ],
        referenced,
        NOW
      )
    ).toEqual([]));
});
