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

// The domain a plaintext push's notification falls back to when it has no title.
const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Unknown';
  }
};

/**
 * What `onNewPushCreated` sends the user's devices for a new push.
 *
 * An encrypted push (one with `enc`, docs/e2ee.md) carries nothing the server can read,
 * so the message carries only what a device needs to fetch and open it: the push's id, its
 * type, the sending device's id (so the sender can skip its own push) and the key version.
 * Android gets it at high priority, since the service has to read the document before it
 * can post anything. APNs gets a visible "New push" with `mutableContent`, which the SDK
 * sends as `"mutable-content": 1`, so the notification service extension can replace it
 * with the decrypted title; a device that cannot decrypt in time still shows something.
 * Those two blocks reach only their platforms, so Chrome still gets data alone and shows
 * nothing until the extension has decrypted. FCM's data values are strings, hence
 * `keyVersion` as one.
 *
 * A plaintext push keeps the message today's clients read (title, URL, device name, data
 * only, so Chrome does not show a notification of its own), until phase 5 of the plan
 * refuses plaintext pushes and this branch goes.
 */
export function pushMessageOf(pushId: string, push: Record<string, unknown>): BaseMessage {
  if (push.enc !== undefined) {
    return {
      data: {
        pushId,
        type: String(push.type),
        deviceId: typeof push.deviceId === 'string' ? push.deviceId : '',
        keyVersion: String(push.keyVersion),
      },
      android: { priority: 'high' },
      apns: { payload: { aps: { alert: { title: 'New push' }, mutableContent: true, sound: 'default' } } },
    };
  }
  const url = typeof push.url === 'string' ? push.url : undefined;
  return {
    data: {
      title: (typeof push.title === 'string' && push.title) || (url ? domainOf(url) : 'Unknown'),
      pushId,
      id: pushId,
      type: typeof push.type === 'string' ? push.type : 'unknown',
      url: url as string,
      deviceName: push.deviceName as string,
    },
  };
}
