/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference types="chrome"/>
/// <reference lib="webworker" />
import { User } from 'firebase/auth';
import {
  arrayUnion,
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { getToken } from 'firebase/messaging';
import { getMessaging } from 'firebase/messaging/sw';

// import { onBackgroundMessage } from 'firebase/messaging/sw';

import { app, auth } from '../src/config/firebase';
import { deviceId } from '../src/services/keyStore';
import {
  NOT_A_WEB_PAGE_MESSAGE,
  PUSH_PORT,
  type Page,
  PagePushError,
  type PushReply,
  type PushRequest,
  pageOfTab,
  pushPage,
} from '../src/services/pagePush';
import { type Push, loadPushKeys, readPush, viewableType, viewerPath } from '../src/services/pushes';
import { isWebPage } from '../src/services/tabPage';

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

// Initialize Firebase Cloud Messaging
const messaging = getMessaging(app);

interface SignInMessage {
  type: 'ON_AUTH_STATE_CHANGED';
  user: User;
}

// Type guard to check if a message is a SignInMessage
function isAuthStateChangedInMessage(message: any): message is SignInMessage {
  return message.type === 'ON_AUTH_STATE_CHANGED' && message.user !== undefined;
}

async function updateUserFcmToken(userId: string, token: string) {
  debug('Updating user FCM token', { userId });
  const db = getFirestore(app);

  const userRef = doc(db, 'users', userId);

  try {
    const userDoc = await getDoc(userRef);

    if (userDoc.exists()) {
      const userData = userDoc.data();
      const existingTokens = userData.fcmTokens || [];

      // Only add the token if it doesn't already exist
      if (!existingTokens.includes(token)) {
        debug('Adding token to user', { userId });
        await updateDoc(userRef, {
          fcmTokens: arrayUnion(token),
        });
      }
    } else {
      debug('Creating new user document', { userId });
      // Create new user document if it doesn't exist
      try {
        await setDoc(userRef, {
          fcmTokens: [token],
          createdAt: serverTimestamp(),
        });
      } catch {
        // Another client (usually the web sign-up) created the document between the read and
        // this write, and the rules refuse a replace; add the token to theirs instead.
        await updateDoc(userRef, { fcmTokens: arrayUnion(token) });
      }
    }
  } catch (error) {
    logError('Error updating user FCM token:', { error });
    throw error;
  }
}

const requestFcmToken = async (userId: string): Promise<string | undefined> => {
  try {
    // Get a new token. `getToken` has been seen to hang forever without throwing, so log if it stalls.
    const stallTimer = setTimeout(() => logError('getToken has not resolved after 15s'), 15_000);
    const token = await getToken(messaging, {
      serviceWorkerRegistration: self.registration,
    }).finally(() => clearTimeout(stallTimer));

    if (token) {
      console.debug('FCM Token:', token);
      await updateUserFcmToken(userId, token);

      // Save token to local storage
      await chrome.storage.local.set({ fcmToken: token });
    }

    return token;
  } catch (error) {
    logError('Error getting FCM token:', { error });
  }

  return undefined;
};

async function start() {
  const { userId } = await chrome.storage.local.get('userId');
  debug('START', { userId });
  if (userId) {
    debug('Requesting FCM token');
    const token = await requestFcmToken(userId);
    debug(`FCM token result: ${!!token}`);
  } else {
    debug('No user id found, PushThat will not open new pushes.');
  }
}

// Handle push notifications.
// `waitUntil` must be called synchronously. If it's called after an `await`, Chrome treats the event as finished and
// can tear the worker down before the tab opens, which happens whenever no extension page is keeping it alive.
self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

/**
 * An encrypted push's message carries its id and nothing readable (docs/e2ee.md,
 * Notifications), so the worker reads the document and decrypts it with the key the
 * extension's page stored at sign-in, which is the worker's too: they share the extension's
 * origin, and with it IndexedDB and the Firebase session. Undefined when it cannot (no key
 * on this device, signed out, offline, a key a reset replaced): the push is in the list,
 * which decrypts when opened.
 */
async function readReceivedPush(pushId: string): Promise<Push | undefined> {
  await auth.authStateReady();
  const uid = auth.currentUser?.uid;
  if (!uid) return undefined;
  const db = getFirestore(app);
  const keys = await loadPushKeys(db, uid);
  if (!keys) return undefined;
  // From the server: the push was made a moment ago, on another device.
  const push = await readPush(await getDocFromServer(doc(db, 'pushes', pushId)), keys);
  return push.locked ? undefined : push;
}

/**
 * An encrypted push: skipped when this browser sent it, which compares the install's
 * device id now that the push no longer says which browser it came from. A URL opens in a
 * tab, as it always has. A file has no URL to open: an image opens in the extension's own
 * page, which decrypts and shows it (`ViewPush`), as a pushed image's Storage URL opened
 * before encryption. Any other file is saved from the list, on a click, so its notification
 * opens the list. The worker only names the push; it cannot make an object URL to show the
 * image itself, and a page that holds the decrypted image is one that can let it go.
 */
async function handleEncryptedPush(data: { pushId?: string; deviceId?: string }) {
  if (data.deviceId && data.deviceId === (await deviceId())) {
    debug('Skipping a push this browser sent');
    return;
  }
  let push: Push | undefined;
  try {
    push = data.pushId ? await readReceivedPush(data.pushId) : undefined;
  } catch (error) {
    logError('Could not read a received push:', { error: String(error) });
  }

  const page = chrome.runtime.getURL('index.html');
  // The push's id is all the address carries: the image is read and decrypted by the page.
  const image = push?.file && viewableType(push.file) ? chrome.runtime.getURL(viewerPath(push.id)) : undefined;
  const open = push?.type === 'url' ? push.url : image;
  // Whether a file push opens a tab, and nothing from the push: an image that does not open
  // is otherwise silent, and this says whether it was read at all.
  if (push?.type === 'file') debug('Received a file push', { read: !!push.file, opensInTab: !!image });
  else if (!push) debug('Received a push this browser could not read');
  if (open) {
    try {
      await chrome.tabs.create({ url: open });
    } catch (error) {
      logError('Error opening a push:', { error: String(error) });
    }
  }
  await self.registration.showNotification(push?.title || 'New push', {
    body: push?.type === 'url' ? push.url : push ? 'File' : '',
    icon: '/icons/icon128.png',
    silent: true,
    data: { url: open || page },
  });
}

async function handlePush(event: PushEvent) {
  const data = event.data?.json()?.data;
  // The data says which push, never what is in it; the URL is not logged once decrypted.
  debug('Received push notification ', { pushId: data?.pushId, type: data?.type });

  // Every push is announced by its id alone (functions/src/notifications.ts): the rules
  // refuse a plaintext push, so the message that carried a URL and a device name to open
  // from is never sent, and a URL is only ever opened once it has been decrypted here.
  if (data?.pushId) await handleEncryptedPush(data);
}

// Handle notification clicks
self.addEventListener('notificationclick', async (event) => {
  event.notification.close(); // Close the notification

  // Get the URL from the notification data
  const url = (event.notification.data as { url?: string })?.url;

  if (url) {
    console.debug('Opening URL from notification click', { url });
    // Open the URL in a new tab
    chrome.tabs.create({ url });
  }
});

chrome.runtime.onMessage.addListener(async (message: any, sender, sendResponse) => {
  if (isAuthStateChangedInMessage(message)) {
    debug('ON_AUTH_STATE_CHANGED', { userId: message.user?.uid });

    if (message.user && message.user.uid) {
      // Save userId to storage
      await chrome.storage.local.set({ userId: message.user.uid });

      // Add a delay. Something with Firebase is weird and we're getting permission errors.
      setTimeout(async () => {
        await start();
      }, 1000);
    } else {
      // Clear userId from storage when user signs out
      await chrome.storage.local.remove('userId');
    }
  }
});

self.addEventListener('activate', async (event) => {
  try {
    // Run code when service worker becomes active
    debug('Service worker activating');

    start();
  } catch (error) {
    logError('Activation error:', { error });
  }
});

// The toolbar button opens the popup (manifest.json, `action.default_popup`), which pushes
// the tab or opens the app; with a popup set, Chrome no longer sends `action.onClicked`.

// Pushing from the extension (docs/web.md): the popup, the keyboard shortcut and the
// right-click menu, all made here. A notification's click opens the app.
const PUSH_PAGE = 'push-page';
const PUSH_LINK = 'push-link';
const WEB_PAGES = ['http://*/*', 'https://*/*'];
const PUSHED_BADGE_MS = 2000;

// The check on the toolbar button after a push, cleared by a timer (`clearPushed`). Badge text is the
// browser's and outlives the worker, which Chrome may stop before the timer fires, so a
// check left that way is cleared when the worker next starts. The timer is kept so that a
// second push within the two seconds gets its full two.
let badgeTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Takes the check off the toolbar button, and the button's name back to the extension's.
 * The name says "Pushed" while the check shows, so that a push is said in words too, where
 * a screen reader reads the button, and not only by a mark someone has to see.
 */
const clearPushed = () =>
  Promise.all([
    chrome.action.setBadgeText({ text: '' }),
    chrome.action.setTitle({ title: chrome.runtime.getManifest().name }),
  ]);
void clearPushed();

/**
 * The right-click items, made again on every install and update: Chrome keeps them across
 * restarts of the worker but not across an update that changes them, and creating one that
 * exists is an error, so the old ones go first.
 */
async function createMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: PUSH_PAGE,
    title: 'Push this page',
    contexts: ['page'],
    documentUrlPatterns: WEB_PAGES,
  });
  chrome.contextMenus.create({
    id: PUSH_LINK,
    title: 'Push this link',
    contexts: ['link'],
    targetUrlPatterns: WEB_PAGES,
  });
}

/**
 * Pushes `page` and says how it went. `popup` is the popup that asked, while it is open:
 * it is told, and shows the result itself. Otherwise, after a shortcut, a menu item or a
 * popup closed mid-push, the worker says it: a check on the toolbar button for a push, a
 * notification for a failure.
 */
async function pushFromWorker(page: Page | undefined, popup?: { reply: (reply: PushReply) => boolean }) {
  let reply: PushReply;
  try {
    if (!page) throw new PagePushError(NOT_A_WEB_PAGE_MESSAGE);
    await pushPage(page);
    reply = { ok: true };
  } catch (error) {
    // `pushPage` throws nothing but a `PagePushError`, and logs what it could not word.
    const failure = error as PagePushError;
    reply = { ok: false, message: failure.message, reason: failure.reason };
  }
  if (popup?.reply(reply)) return;
  if (reply.ok) {
    clearTimeout(badgeTimer);
    await chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
    await chrome.action.setBadgeText({ text: '✓' });
    await chrome.action.setTitle({ title: 'Pushed' });
    badgeTimer = setTimeout(() => void clearPushed(), PUSHED_BADGE_MS);
  } else {
    // An unconfirmed push may have landed, so it is not called "not pushed".
    await self.registration.showNotification(reply.reason === 'unconfirmed' ? 'Push not confirmed' : 'Not pushed', {
      body: reply.message,
      icon: '/icons/icon128.png',
      data: { url: chrome.runtime.getURL('index.html') },
    });
  }
}

// The popup's push (`PUSH_PORT`): made here so that it survives the popup closing.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PUSH_PORT) return;
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
  });
  port.onMessage.addListener((request: PushRequest) => {
    debug('Push from the popup');
    const page = isWebPage(request.page?.url) ? request.page : undefined;
    void pushFromWorker(page, {
      // `open` can trail the popup's closing by one message between processes: a reply in
      // that window goes to a port nobody reads, and the worker shows nothing. Accepted, not
      // closed with an acknowledgement and a timeout, since the window is milliseconds against
      // the seconds of a push, and the push itself is made either way.
      reply: (reply) => {
        if (!open) return false;
        port.postMessage(reply);
        return true;
      },
    });
  });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== PUSH_PAGE) return;
  // Chrome passes the active tab; older versions passed nothing, so it is asked for then.
  const active = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  debug('Push shortcut');
  await pushFromWorker(active ? await pageOfTab(active) : undefined);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === PUSH_PAGE) {
    debug('Push this page, from the menu');
    await pushFromWorker(tab ? await pageOfTab(tab) : undefined);
  } else if (info.menuItemId === PUSH_LINK) {
    debug('Push this link, from the menu');
    // A link is a page this browser has usually not loaded, so there is no title and no
    // icon to give: it goes as a push from the site's Push page does, and the first phone
    // or Mac to receive it fills in both (docs/e2ee.md, Titles).
    await pushFromWorker(isWebPage(info.linkUrl) ? { url: info.linkUrl, title: '' } : undefined);
  }
});

chrome.runtime.onInstalled.addListener(async (details) => {
  await createMenus();
  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  }
});

// Add wake-up listeners
// chrome.idle.onStateChanged.addListener(async (state) => {
//   debug('System state changed:', { state });
// });

chrome.runtime.onStartup.addListener(async () => {
  debug('Extension starting up');
  await start();
});

// Logs stay in the extension's own console. They went to Axiom as well until it was removed:
// that sent user and push ids to a third party the privacy policy did not name.
function debug(message: string, optionalParams?: any) {
  console.debug(message, optionalParams);
}

function logError(message: string, optionalParams?: any) {
  console.error(message, optionalParams);
}
