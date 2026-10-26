/* eslint-disable @typescript-eslint/no-explicit-any */
/// <reference types="chrome"/>
/// <reference lib="webworker" />
/// <reference types="vite/client" />
import { Axiom } from '@axiomhq/js';
import { User } from 'firebase/auth';
import { arrayUnion, doc, getDoc, getFirestore, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { getToken } from 'firebase/messaging';
import { getMessaging } from 'firebase/messaging/sw';

// import { onBackgroundMessage } from 'firebase/messaging/sw';

import { app } from '../src/config/firebase';

declare const self: ServiceWorkerGlobalScope & typeof globalThis;

// Initialize Firebase Cloud Messaging
const messaging = getMessaging(app);

// The ingest token comes from the build environment (apps/web/.env, see .env.example) so
// that it is never committed. It still ships inside the built extension, so it has to be an
// ingest-only token. A build without one logs to the console only.
const axiomToken = import.meta.env.VITE_AXIOM_TOKEN;
const axiom = axiomToken ? new Axiom({ token: axiomToken }) : undefined;

interface SignInMessage {
  type: 'ON_AUTH_STATE_CHANGED';
  user: User;
}

// Type guard to check if a message is a SignInMessage
function isAuthStateChangedInMessage(message: any): message is SignInMessage {
  return message.type === 'ON_AUTH_STATE_CHANGED' && message.user !== undefined;
}

async function updateUserFcmToken(userId: string, token: string) {
  await debug('Updating user FCM token', { userId });
  const db = getFirestore(app);

  const userRef = doc(db, 'users', userId);

  try {
    const userDoc = await getDoc(userRef);

    if (userDoc.exists()) {
      const userData = userDoc.data();
      const existingTokens = userData.fcmTokens || [];

      // Only add the token if it doesn't already exist
      if (!existingTokens.includes(token)) {
        await debug('Adding token to user', { userId });
        await updateDoc(userRef, {
          fcmTokens: arrayUnion(token),
        });
      }
    } else {
      await debug('Creating new user document', { userId });
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
    await logError('Error updating user FCM token:', { error });
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
    await logError('Error getting FCM token:', { error });
  }

  return undefined;
};

async function start() {
  const { userId } = await chrome.storage.local.get('userId');
  await debug('START', { userId });
  if (userId) {
    await debug('Requesting FCM token');
    const token = await requestFcmToken(userId);
    await debug(`FCM token result: ${!!token}`);
  } else {
    await debug('No user id found, PushThat will not open new pushes.');
  }
}

// Handle push notifications.
// `waitUntil` must be called synchronously. If it's called after an `await`, Chrome treats the event as finished and
// can tear the worker down before the tab opens, which happens whenever no extension page is keeping it alive.
self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event: PushEvent) {
  const data = event.data?.json()?.data;
  debug('Received push notification ', { data });

  try {
    // Open the push URL in a new tab.
    if (data?.url && data?.deviceName !== navigator.userAgent) {
      try {
        await chrome.tabs.create({ url: data.url });
      } catch (error) {
        logError('Error opening push URL:', { error: String(error) });
      }

      // You can customize the notification here if needed
      const notificationTitle = data?.title || 'New Push';
      const notificationOptions: NotificationOptions = {
        body: data?.url || '',
        icon: '/icons/icon128.png',
        silent: true,
        // Add data to the notification so we can access it in the click handler
        data: {
          url: data?.url,
        },
      };

      await self.registration.showNotification(notificationTitle, notificationOptions);
    } else {
      await self.registration.showNotification('Push sent successfully', {
        body: data?.url || '',
        icon: '/icons/icon128.png',
        silent: true,
        data: {
          url: data?.url,
        },
      });
    }
  } finally {
    // Axiom batches in the background; make sure the logs land before the worker is allowed to sleep.
    await axiom?.flush();
  }
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
    await debug('ON_AUTH_STATE_CHANGED', { userId: message.user?.uid });

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
    await debug('Service worker activating');

    start();
  } catch (error) {
    await logError('Activation error:', { error });
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
//   await debug('System state changed:', { state });
// });

chrome.runtime.onStartup.addListener(async () => {
  await debug('Extension starting up');
  await start();
});

async function debug(message: string, optionalParams?: any) {
  console.debug(message, optionalParams);
  return axiom?.ingest('push-that-chrome', [
    {
      type: 'debug',
      message,
      source: 'chrome-extension',
      timestamp: Date.now(),
      ...(optionalParams ? { ...optionalParams } : {}),
    },
  ]);
}

async function logError(message: string, optionalParams?: any) {
  console.error(message, optionalParams);
  return axiom?.ingest('push-that-chrome', [
    {
      type: 'error',
      message,
      source: 'chrome-extension',
      timestamp: Date.now(),
      ...(optionalParams ? { ...optionalParams } : {}),
    },
  ]);
}
