/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference types="chrome"/>
/// <reference lib="webworker" />
/// <reference types="vite/client" />
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
import { type Push, loadPushKeys, readPush } from '../src/services/pushes';

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
 * tab, as it always has. A file has no URL to open, so its push opens the extension's own
 * page, where the list decrypts and saves it on a click.
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

  if (push?.url && push.type === 'url') {
    try {
      await chrome.tabs.create({ url: push.url });
    } catch (error) {
      logError('Error opening push URL:', { error: String(error) });
    }
  }
  const page = chrome.runtime.getURL('index.html');
  await self.registration.showNotification(push?.title || 'New push', {
    body: push?.type === 'url' ? push.url : push ? 'File' : '',
    icon: '/icons/icon128.png',
    silent: true,
    data: { url: push?.type === 'url' ? push.url : page },
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

chrome.action.onClicked.addListener(async () => {
  debug('Extension clicked');
  await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

// Add installation handler
chrome.runtime.onInstalled.addListener(async (details) => {
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
