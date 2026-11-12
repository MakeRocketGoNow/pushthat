import { FRESH_SIGN_IN_S, signedInRecently } from './account-deletion';

/**
 * The one rule in account deletion that is arithmetic: how old a sign-in may be. What a
 * deletion removes is tested against the emulators (test/emulator/account-deletion.test.ts).
 */

const NOW = new Date('2026-11-12T12:00:00Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

describe('signedInRecently', () => {
  test('a sign-in a moment ago passes', () => {
    expect(signedInRecently(seconds(NOW) - 5, NOW)).toBe(true);
  });

  test('a sign-in at the edge passes, and one past it does not', () => {
    expect(signedInRecently(seconds(NOW) - FRESH_SIGN_IN_S, NOW)).toBe(true);
    expect(signedInRecently(seconds(NOW) - FRESH_SIGN_IN_S - 1, NOW)).toBe(false);
  });

  test('a session from yesterday does not pass', () => {
    expect(signedInRecently(seconds(NOW) - 24 * 60 * 60, NOW)).toBe(false);
  });

  test('a clock a few seconds ahead passes, and a sign-in far in the future does not', () => {
    expect(signedInRecently(seconds(NOW) + 10, NOW)).toBe(true);
    expect(signedInRecently(seconds(NOW) + 3600, NOW)).toBe(false);
  });

  test('a token with no sign-in time does not pass', () => {
    expect(signedInRecently(undefined, NOW)).toBe(false);
    expect(signedInRecently('1700000000', NOW)).toBe(false);
    expect(signedInRecently(NaN, NOW)).toBe(false);
  });
});
