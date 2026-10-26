import { SendResponse } from 'firebase-admin/messaging';

import { deadTokens } from './notifications';

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
