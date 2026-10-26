import { BaseMessage, SendResponse } from 'firebase-admin/messaging';

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

/**
 * What `onNewPushCreated` sends the user's devices for a new push.
 *
 * A push carries nothing the server can read (docs/e2ee.md, Notifications), so the message
 * carries only what a device needs to fetch and open it: the push's id, its type, the
 * sending device's id (so the sender can skip its own push) and the key version. Android
 * gets it at high priority, since the service has to read the document before it can post
 * anything. APNs gets a visible "New push" with `mutableContent`, which the SDK sends as
 * `"mutable-content": 1`, so the notification service extension can replace it with the
 * decrypted title; a device that cannot decrypt in time still shows something. Those two
 * blocks reach only their platforms, so Chrome gets data alone and shows nothing until the
 * extension has decrypted. FCM's data values are strings, hence `keyVersion` as one.
 *
 * There is no plaintext message any more. The rules refuse a plaintext push, so none is
 * created, and one that got past them would have its title, URL and device name sent
 * nowhere: the server does not announce content, whatever shape it arrives in. An app
 * from before encryption looks for a `url` in the data, finds none, and shows nothing,
 * which is the spec's Old app versions. The domain fallback for a push with no title went
 * with it; receivers take the domain from the URL they decrypt.
 */
export function pushMessageOf(pushId: string, push: Record<string, unknown>): BaseMessage {
  return {
    data: {
      pushId,
      type: typeof push.type === 'string' ? push.type : 'unknown',
      deviceId: typeof push.deviceId === 'string' ? push.deviceId : '',
      keyVersion: typeof push.keyVersion === 'number' ? String(push.keyVersion) : '',
    },
    android: { priority: 'high' },
    apns: { payload: { aps: { alert: { title: 'New push' }, mutableContent: true, sound: 'default' } } },
  };
}
