import { SendResponse } from 'firebase-admin/messaging';

/**
 * Which of a user's device tokens a multicast's failures say are dead, for
 * `onNewPushCreated` to remove from the user document.
 *
 * Only a token FCM reports as not registered or not a registration token at all is
 * dead: the device uninstalled the app or the token was rotated, and nothing will ever
 * reach it again. Any other failure is about the message or the moment, not the token:
 * a payload over FCM's 4 KB, a quota, an outage. The trigger once removed every token a
 * send to failed, whatever the reason, so one oversized push took every device off the
 * account until each signed in again.
 */
export const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export function deadTokens(tokens: readonly string[], responses: readonly SendResponse[]): string[] {
  return tokens.filter((_, i) => {
    const code = responses[i]?.error?.code;
    return !responses[i]?.success && typeof code === 'string' && DEAD_TOKEN_CODES.has(code);
  });
}
