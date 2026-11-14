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
 * from before encryption finds no `url` in the data and opens nothing (docs/e2ee.md, Old
 * app versions), though what it shows differs: Android shows nothing, iOS shows the
 * system's "New push" from the APNs block, and the old Chrome extension shows its own
 * "Push sent successfully". The domain fallback for a push with no title went with it;
 * receivers take the domain from the URL they decrypt.
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

/** The title of the notice for a push taken back at the limit. Android words its own (push_removed_title). */
export const REMOVED_TITLE = 'Push removed';

/**
 * The notice's sentence: the limit alone. The apps never sell the plan (store rules), so it
 * names no upgrade. The web's `usedMessage` (apps/web/src/services/pushRefusal.ts) and
 * Android's push_removed_url and push_removed_file say the same; the web's `limitMessage`
 * adds what Pro allows, which this must not.
 */
export function removedBodyOf(type: 'url' | 'file', limit: number): string {
  return `You have used this month's ${limit.toLocaleString('en-US')} ${type === 'url' ? 'link' : 'file'} pushes.`;
}

/**
 * What `onNewPushCreated` sends the user's devices when it takes back a push that landed
 * past the month's limit (usage.ts). The rules let a burst through before any of it is
 * counted, so the device that made the push was told it was saved; without this the push
 * only left its list. The likely burst is a queue of pushes made offline and sent together
 * once the device is back, which happens in the background, where nobody watches the list.
 *
 * It goes to every device on the account: the server cannot tell which token made the push,
 * and the limit is the account's. It carries no `pushId`, which is what every app takes
 * for a push: an app from before this message finds none and shows nothing on Android or in
 * Chrome, where it would otherwise read a deleted push and say "New push". iOS shows the
 * APNs alert as written, old app or new, and with no `mutable-content` the notification
 * service extension never sees it. Android and the Chrome extension word it themselves
 * from `refused` and `limit`, so Android's text stays in its strings.xml.
 *
 * A burst can be taken back several pushes at once, so each type's notice replaces the
 * last: the collapse id on APNs, a fixed notification id on Android, a tag in Chrome. Each
 * replacement would sound again, so it is quiet: Android alerts once while the notice is in
 * the tray, and Chrome's tag replaces without renotifying. A collapse id cannot stop a
 * sound for each delivery, so the APNs alert has one only when `sound`, which `recordPush`
 * gives the first notice of a burst (usage.ts, `QUIET_NOTICE_MS`). A queue of twenty
 * offline pushes taken back would otherwise sound twenty times.
 * Normal priority on Android: a high-priority message that an older app answers with no
 * notification counts against the app's later high-priority pushes, and this can wait for
 * the phone to wake.
 */
export function removedMessageOf(type: 'url' | 'file', limit: number, sound = false): BaseMessage {
  return {
    data: { refused: type, limit: String(limit) },
    android: { priority: 'normal' },
    apns: {
      headers: { 'apns-collapse-id': `refused-${type}` },
      payload: {
        aps: { alert: { title: REMOVED_TITLE, body: removedBodyOf(type, limit) }, ...(sound && { sound: 'default' }) },
      },
    },
  };
}
