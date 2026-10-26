// The Storage rules against the emulators: `npm run test:rules`, which starts Firestore and
// Storage together, since the file size rule reads the uploader's user document across
// services. The tier picks the largest file: 25 MB on Free, 100 MB on Pro.
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { Timestamp, doc, setDoc } from 'firebase/firestore';
import { deleteObject, ref, uploadBytes } from 'firebase/storage';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';

let env;
const MB = 1024 * 1024;
const farFuture = Timestamp.fromDate(new Date(Date.UTC(2099, 0, 1)));
const past = Timestamp.fromDate(new Date(Date.UTC(2025, 0, 1)));

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-pushthat',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
    storage: { rules: readFileSync(new URL('../storage.rules', import.meta.url), 'utf8') },
  });
});
after(() => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
});

const seed = (data) => env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore(), 'users/alice'), data));
const upload = (mb, as = 'alice', name = 'a.bin') =>
  uploadBytes(ref(env.authenticatedContext(as).storage(), `uploads/alice/${name}`), new Uint8Array(mb * MB));

describe('the file size each tier allows', () => {
  test('free, under 25 MB', async () => {
    await seed({ email: 'a@x.com' });
    await assertSucceeds(upload(24));
  });
  test('free, 25 MB and over', async () => {
    await seed({ email: 'a@x.com' });
    await assertFails(upload(25));
  });
  test('pro, up to 100 MB', async () => {
    await seed({ subscription: { expiresAt: farFuture } });
    await assertSucceeds(upload(99));
    await assertFails(upload(100, 'alice', 'b.bin'));
  });
  test('a lapsed subscription is free', async () => {
    await seed({ subscription: { expiresAt: past } });
    await assertFails(upload(25));
  });
  test('no user document is free', () => assertFails(upload(25)));
  test("someone else's folder", async () => {
    await seed({ subscription: { expiresAt: farFuture } });
    await assertFails(upload(1, 'bob'));
  });
});

// A client removes its own upload when the push for it is refused; nobody else's.
describe('deleting an upload', () => {
  test('your own', async () => {
    await seed({ email: 'a@x.com' });
    await upload(1);
    await assertSucceeds(deleteObject(ref(env.authenticatedContext('alice').storage(), 'uploads/alice/a.bin')));
  });
  test("someone else's", async () => {
    await seed({ email: 'a@x.com' });
    await upload(1);
    await assertFails(deleteObject(ref(env.authenticatedContext('bob').storage(), 'uploads/alice/a.bin')));
  });
});
