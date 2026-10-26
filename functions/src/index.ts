/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */
import { initializeApp } from 'firebase-admin/app';
import { BaseMessage, SendResponse, getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
// import { beforeUserCreated } from 'firebase-functions/v2/identity';
import 'whatwg-fetch';

import { recordPush } from './usage';

// The user document's plan fields are described in plan.ts (`PlanUser`); the count a
// push adds to them is in usage.ts, and the Stripe side in stripe-functions.ts.

// Initialize Firebase Admin
initializeApp();

export {
  createCheckoutSession,
  createPortalSession,
  getPlan,
  refreshSubscription,
  stripeWebhook,
} from './stripe-functions';
export { expireFilePushes } from './expiry';
export { deleteOrphanedUploads } from './orphans';

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

export const getPageTitle = onCall({ cors: true }, async ({ data }) => {
  try {
    const { url } = data;

    logger.info('URL:', url);

    if (!url) {
      throw new HttpsError('invalid-argument', 'URL is required');
    }

    const resp = await fetch(url);

    logger.info('Status:', resp.status);

    if (resp.status !== 200) {
      throw new HttpsError('internal', `Failed to fetch page with status code: ${resp.status}`);
    }

    if (!resp.headers.get('content-type')?.includes('text/html')) {
      throw new HttpsError('internal', `Failed to fetch page with content type: ${resp.headers.get('content-type')}`);
    }

    const html = await resp.text();

    // Extract title using regex
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : '';

    logger.info('Title:', title);

    return { title };
  } catch (error) {
    logger.error('Error in getPageTitle:', error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError('internal', 'Failed to fetch page title.');
  }
});

export const onPushRecordDeleted = onDocumentDeleted('pushes/{pushId}', async (event) => {
  let storagePath = '';

  try {
    // Get the deleted document data
    const deletedPush = event.data?.data();

    if (deletedPush?.type !== 'file') {
      // TODO: remove logger.info
      logger.info('Deleted document is not a file');
      return;
    }

    // Get storage reference
    const storage = getStorage();
    const bucket = storage.bucket();
    storagePath = `uploads/${deletedPush.userId}/${deletedPush.title}`;
    const file = bucket.file(storagePath);

    // Check if file exists before attempting to delete
    const [exists] = await file.exists();
    if (!exists) {
      logger.info(`File ${storagePath} does not exist in storage`);
      return;
    }

    // Delete the file
    await file.delete();
    logger.info(`Successfully deleted file: ${storagePath}`);
  } catch (error) {
    logger.error(`Error deleting ${storagePath} from storage:`, error);
    throw error;
  }
});

// Helper function to extract domain from URL
const extractDomain = (url: string): string => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return 'Unknown';
  }
};

export const onNewPushCreated = onDocumentCreated('pushes/{pushId}', async (event) => {
  try {
    const snapshot = event.data;
    if (!snapshot) {
      logger.info('No data associated with the new push event');
      return;
    }

    const pushData = snapshot.data();

    // Count the push, or take it back: the rules let a burst through before any of it
    // is counted, and the count here is the exact one (usage.ts). A push taken back is
    // not announced; the device that made it sees it go from its list.
    const outcome = await recordPush(
      snapshot.ref.firestore,
      snapshot.ref,
      { userId: pushData.userId, type: pushData.type },
      new Date()
    );
    if (outcome === 'refused') return;

    // Get the messaging instance
    const messaging = getMessaging();

    // Fetch the user document that contains an array of FCM tokens
    const recipientTokensSnapshot = await event.data?.ref.firestore.collection('users').doc(pushData.userId).get();

    if (!recipientTokensSnapshot?.exists) {
      logger.info('No recipients found for this notification');
      return;
    }

    // Get all valid FCM tokens from the user's devices
    // Assuming fcmTokens is an array of tokens in the user document
    const userData = recipientTokensSnapshot.data();
    const tokens = (
      Array.isArray(userData?.fcmTokens) ? userData.fcmTokens : userData?.fcmToken ? [userData.fcmToken] : []
    ).filter((token): token is string => typeof token === 'string');

    if (!tokens.length) {
      logger.info('No valid FCM tokens found');
      return;
    }

    // Create notification message
    const message: BaseMessage = {
      // Only send data otherwise Chrome will show a notification automatically.
      // notification: {
      //   title: pushData.title || (pushData.url ? extractDomain(pushData.url) : 'Unknown'),
      //   body: pushData.url,
      // },
      data: {
        title: pushData.title || (pushData.url ? extractDomain(pushData.url) : 'Unknown'),
        pushId: event.params.pushId,
        id: snapshot.id,
        type: pushData.type || 'unknown',
        url: pushData.url,
        deviceName: pushData.deviceName,
      },
    };

    // Send messages in batches (FCM allows up to 500 tokens per request)
    const batchResponse = await messaging.sendEachForMulticast({
      ...message,
      tokens: tokens,
    });

    logger.info(
      `Successfully sent notifications: ${batchResponse.successCount} successful, ${batchResponse.failureCount} failed`
    );

    // Handle any failed messages
    if (batchResponse.failureCount > 0) {
      const failedTokens: string[] = [];
      batchResponse.responses.forEach((resp: SendResponse, idx: number) => {
        if (!resp.success) {
          failedTokens.push(tokens[idx]);
          logger.error('Notification failed:', resp.error);
        }
      });

      // Clean up failed tokens from the user's document
      if (failedTokens.length > 0) {
        logger.info('Tokens to remove:', failedTokens);

        // Update the user document to remove failed tokens
        const validTokens = Array.isArray(userData?.fcmTokens)
          ? userData.fcmTokens.filter((token: string) => !failedTokens.includes(token))
          : [];

        await recipientTokensSnapshot.ref.update({
          fcmTokens: validTokens,
          fcmToken: null,
        });
      }
    }
  } catch (error) {
    logger.error('Error sending push notification:', error);
    throw error;
  }
});

// CD: Doesn't work without upgrading to Firebase Authentication with Identity Platform
// which has higher pricing and not worth it just for this one thing.
// export const onNewUserCreated = beforeUserCreated(async (event) => {
//   try {
//     const user = event.data;
//     if (!user) {
//       logger.error('No user data available in the event');
//       return;
//     }

//     const firestore = getFirestore();

//     // Create a new document in the users collection with the same ID as the Auth user
//     await firestore.collection('users').doc(user.uid).set(
//       {
//         email: user.email,
//         createdAt: Timestamp.now(),
//         // displayName: user.displayName,
//         // photoURL: user.photoURL,
//       },
//       { merge: true }
//     );

//     logger.info(`Created new user document for ${user.uid}`);
//   } catch (error) {
//     logger.error('Error creating user document:', error);
//     throw error;
//   }
// });
