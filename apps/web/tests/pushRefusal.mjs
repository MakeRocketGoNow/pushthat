// What the Push page says when the rules refuse a push (src/services/pushRefusal.ts): the
// month's limit, a key a reset replaced, or a copy of PushThat that is out of date, told
// apart in that order. Run by `npm run test:keys`, in plain Node, with no emulator.
import { FirebaseError } from 'firebase/app';
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import {
  STALE_KEY_MESSAGE,
  atLimit,
  isRulesRefusal,
  limitMessage,
  outdatedMessage,
  refusalMessage,
} from '../src/services/pushRefusal.ts';

const plan = (url, file = 0, tier = 'free') => ({
  tier,
  limits: { url: 50, file: 3, fileBytes: 25 * 1024 * 1024, keepDays: 7 },
  usage: { url, file },
});
const read = (report) => async () => report;
const failedRead = async () => {
  throw new Error('offline');
};
const stale = async () => true;
const current = async () => false;

describe('a refused push', () => {
  test('at the limit by the plan read after it', async () =>
    assert.equal(await refusalMessage(plan(49), 'url', read(plan(50)), stale), limitMessage(plan(50), 'url')));
  test('at the limit by the plan the page had, when the read after it fails', async () =>
    assert.equal(await refusalMessage(plan(50), 'url', failedRead, current), limitMessage(plan(50), 'url')));
  test('at the limit by the plan the page had, when the read gives nothing', async () =>
    assert.equal(await refusalMessage(plan(50), 'url', read(undefined), current), limitMessage(plan(50), 'url')));
  test('not at the limit by the fresh plan, though the page thought it was', async () =>
    assert.equal(await refusalMessage(plan(50), 'url', read(plan(10)), current), outdatedMessage()));
  test('a file push at the file limit, with links to spare', async () =>
    assert.equal(await refusalMessage(undefined, 'file', read(plan(0, 3)), current), limitMessage(plan(0, 3), 'file')));
  test('under the limit, under a key a reset replaced', async () =>
    assert.equal(await refusalMessage(plan(1), 'url', read(plan(1)), stale), STALE_KEY_MESSAGE));
  test('under the limit, with no plan at all, under a key a reset replaced', async () =>
    assert.equal(await refusalMessage(undefined, 'url', failedRead, stale), STALE_KEY_MESSAGE));
  test('under the limit, under the current key: this copy is out of date', async () =>
    assert.equal(await refusalMessage(plan(1), 'url', read(plan(1)), current), outdatedMessage()));
  test('a key check that fails counts as not stale', async () =>
    assert.equal(
      await refusalMessage(plan(1), 'url', read(plan(1)), async () => {
        throw new Error('offline');
      }),
      outdatedMessage()
    ));
});

describe('the out-of-date sentence', () => {
  afterEach(() => delete globalThis.chrome);
  test('on the site, reload the page', () => assert.match(outdatedMessage(), /Reload the page/));
  test('in the extension, update it', () => {
    globalThis.chrome = { runtime: { id: 'an-extension-id' } };
    assert.match(outdatedMessage(), /Update the PushThat extension/);
  });
  test('on a site page where Chrome defines the global but no extension runs it', () => {
    globalThis.chrome = { runtime: {} };
    assert.match(outdatedMessage(), /Reload the page/);
  });
});

describe('the limit', () => {
  test('reached at the limit, not before', () => {
    assert.equal(atLimit(plan(49), 'url'), false);
    assert.equal(atLimit(plan(50), 'url'), true);
    assert.equal(atLimit(plan(0, 3), 'url'), false);
    assert.equal(atLimit(plan(0, 3), 'file'), true);
  });
  test('names the number and, on Free, what Pro allows', () =>
    assert.equal(limitMessage(plan(50), 'url'), "You have used this month's 50 link pushes. Pro allows 10,000."));
  test('without a plan, names no number', () =>
    assert.equal(limitMessage(undefined, 'file'), "You have used this month's file pushes."));
});

describe('which errors are the rules', () => {
  test('a permission error from Firestore', () =>
    assert.equal(isRulesRefusal(new FirebaseError('permission-denied', 'Missing or insufficient permissions.')), true));
  test('any other Firebase error', () => assert.equal(isRulesRefusal(new FirebaseError('unavailable', 'x')), false));
  test('an error with the same code that is not Firebase', () =>
    assert.equal(isRulesRefusal({ code: 'permission-denied' }), false));
});
