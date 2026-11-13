import { Message, SendResponse } from 'firebase-admin/messaging';
import { dirname, join } from 'node:path';

import { deadTokens, pushMessageOf, removedMessageOf } from './notifications';

// The SDK's own check and rewrite of a message before it sends it, to see the wire form
// APNs gets. It is internal, and the package's exports map hides it from an import, so it
// is loaded by its file.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateMessage } = require(
  join(dirname(require.resolve('firebase-admin')), 'messaging/messaging-internal.js')
) as {
  validateMessage: (message: Message) => void;
};

const ok: SendResponse = { success: true };
const failed = (code: string): SendResponse =>
  ({ success: false, error: { code, message: code } }) as unknown as SendResponse;

describe('the tokens a multicast says are dead', () => {
  test('one FCM no longer knows', () =>
    expect(deadTokens(['a', 'b', 'c'], [ok, failed('messaging/registration-token-not-registered'), ok])).toEqual([
      'b',
    ]));
  test('one that was never a token', () =>
    expect(deadTokens(['a', 'b'], [failed('messaging/invalid-registration-token'), ok])).toEqual(['a']));
  test('not one whose message was refused, which is about the message', () =>
    expect(
      deadTokens(['a', 'b'], [failed('messaging/invalid-argument'), failed('messaging/payload-size-limit-exceeded')])
    ).toEqual([]));
  test('not one FCM could not reach right then', () =>
    expect(deadTokens(['a'], [failed('messaging/unavailable')])).toEqual([]));
  test('none when every send landed', () => expect(deadTokens(['a', 'b'], [ok, ok])).toEqual([]));
  test('a failure with no error is not a dead token', () =>
    expect(deadTokens(['a'], [{ success: false }])).toEqual([]));
});

describe('the message for a new push', () => {
  const encrypted = {
    userId: 'u1',
    type: 'url',
    createdAt: new Date(),
    deviceId: 'device-0000000000000000',
    keyVersion: 2,
    enc: { v: 1, n: 'n', ct: 'ct' },
    searchTokens: [],
  };

  test('an encrypted push carries its id, type, device and key version, and nothing it holds', () =>
    expect(pushMessageOf('p1', encrypted)).toEqual({
      data: { pushId: 'p1', type: 'url', deviceId: 'device-0000000000000000', keyVersion: '2' },
      android: { priority: 'high' },
      apns: { payload: { aps: { alert: { title: 'New push' }, mutableContent: true, sound: 'default' } } },
    }));
  test('which APNs receives as a mutable alert', () => {
    const message = { ...pushMessageOf('p1', encrypted), token: 't' } as Message;
    validateMessage(message);
    expect(message.apns?.payload?.aps).toEqual({
      alert: { title: 'New push' },
      'mutable-content': 1,
      sound: 'default',
    });
  });
  test('a field written past the rules goes out empty, not as the word undefined', () =>
    expect(pushMessageOf('p1', { enc: { v: 1 } }).data).toEqual({
      pushId: 'p1',
      type: 'unknown',
      deviceId: '',
      keyVersion: '',
    }));
  test('an encrypted file push says so', () =>
    expect(pushMessageOf('p1', { ...encrypted, type: 'file', objectPath: 'uploads/u1/x' }).data?.type).toBe('file'));

  // A plaintext push the rules let through (none should be): its content stays off the
  // wire, and the message is the encrypted one with what the push lacks left empty.
  const plaintext = {
    userId: 'u1',
    type: 'url',
    url: 'https://example.com/a',
    title: 'A page',
    deviceName: 'Pixel',
  };
  test('a plaintext push sends none of what it holds', () =>
    expect(pushMessageOf('p1', plaintext)).toEqual({
      data: { pushId: 'p1', type: 'url', deviceId: '', keyVersion: '' },
      android: { priority: 'high' },
      apns: { payload: { aps: { alert: { title: 'New push' }, mutableContent: true, sound: 'default' } } },
    }));
  test('and no notification block, so Chrome shows nothing of its own', () =>
    expect(pushMessageOf('p1', encrypted).notification).toBeUndefined());
});

describe('the notice for a push taken back at the limit', () => {
  test('names the type and the limit, and no push', () =>
    expect(removedMessageOf('url', 50)).toEqual({
      data: { refused: 'url', limit: '50' },
      android: { priority: 'normal' },
      apns: {
        headers: { 'apns-collapse-id': 'refused-url' },
        payload: {
          aps: {
            alert: { title: 'Push removed', body: "You have used this month's 50 link pushes." },
            sound: 'default',
          },
        },
      },
    }));
  test('carries no pushId, which an older app would read as a push', () =>
    expect(removedMessageOf('file', 3).data).not.toHaveProperty('pushId'));
  test('says a file and writes a large limit with its comma', () =>
    expect(removedMessageOf('file', 10_000).apns?.payload?.aps.alert).toEqual({
      title: 'Push removed',
      body: "You have used this month's 10,000 file pushes.",
    }));
  test('which APNs receives as a plain alert, collapsed by type, that the extension never sees', () => {
    const message = { ...removedMessageOf('file', 3), token: 't' } as Message;
    validateMessage(message);
    expect(message.apns?.headers).toEqual({ 'apns-collapse-id': 'refused-file' });
    expect(message.apns?.payload?.aps).toEqual({
      alert: { title: 'Push removed', body: "You have used this month's 3 file pushes." },
      sound: 'default',
    });
  });
});
