import { Message, SendResponse } from 'firebase-admin/messaging';
import { dirname, join } from 'node:path';

import { deadTokens, pushMessageOf } from './notifications';

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
  test('an encrypted file push says so', () =>
    expect(pushMessageOf('p1', { ...encrypted, type: 'file', objectPath: 'uploads/u1/x' }).data?.type).toBe('file'));

  const plaintext = {
    userId: 'u1',
    type: 'url',
    url: 'https://example.com/a',
    title: 'A page',
    deviceName: 'Pixel',
  };
  test("a plaintext push keeps the message today's clients read", () =>
    expect(pushMessageOf('p1', plaintext)).toEqual({
      data: {
        title: 'A page',
        pushId: 'p1',
        id: 'p1',
        type: 'url',
        url: 'https://example.com/a',
        deviceName: 'Pixel',
      },
    }));
  test('with the domain for a title when it has none', () =>
    expect(pushMessageOf('p1', { ...plaintext, title: '' }).data?.title).toBe('example.com'));
  test('and data alone, so Chrome shows no notification of its own', () => {
    const message = pushMessageOf('p1', plaintext);
    expect(message.notification).toBeUndefined();
    expect(message.apns).toBeUndefined();
  });
});
