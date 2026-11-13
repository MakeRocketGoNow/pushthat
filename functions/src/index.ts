/**
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */
import { initializeApp } from 'firebase-admin/app';
import { DocumentReference } from 'firebase-admin/firestore';
import { BaseMessage, SendResponse, getMessaging } from 'firebase-admin/messaging';
import { getStorage } from 'firebase-admin/storage';
import * as logger from 'firebase-functions/logger';
import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';
// import { beforeUserCreated } from 'firebase-functions/v2/identity';
import 'whatwg-fetch';

import { deadTokens, pushMessageOf, removedMessageOf } from './notifications';
import { storagePathOf } from './orphans';
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
export { deleteAccount, finishAccountDeletions } from './account-deletion';
export { expireFilePushes } from './expiry';
export { deleteOrphanedUploads } from './orphans';

// Start writing functions
// https://firebase.google.com/docs/functions/typescript

// No `getPageTitle`: the web app once asked it for a page's title, which a browser cannot
// read cross-origin, but a server that fetches the URL knows the URL, and that is what an
// encrypted push keeps from it (docs/e2ee.md, Titles). A web push goes out with an empty
// title and the first phone or Mac to receive it writes the title back. Removing it from
// the source does not remove it from the project; docs/deploying.md says how.

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

    // `objectPath` on an encrypted push, the title on a plaintext one (orphans.ts).
    const path = storagePathOf(deletedPush);
    if (!path) {
      logger.warn(`Deleted file push ${event.params.pushId} names no stored object`);
      return;
    }
    storagePath = path;

    // `ignoreNotFound`, and no look first to see whether it is there: the account purge
    // (account-deletion.ts) and the orphan sweep delete these objects too, and one that
    // went between a look and the delete made this throw and log an error for a file that
    // was exactly where it should be, gone.
    await getStorage().bucket().file(storagePath).delete({ ignoreNotFound: true });
    logger.info(`Deleted stored file, or found it already gone: ${storagePath}`);
  } catch (error) {
    logger.error(`Error deleting ${storagePath} from storage:`, error);
    throw error;
  }
});

/**
 * Sends `message` to every device on the user's account, by the FCM tokens on the user
 * document, and takes off it the tokens FCM says are dead (notifications.ts).
 */
async function sendToDevices(userRef: DocumentReference, message: BaseMessage): Promise<void> {
  const recipientTokensSnapshot = await userRef.get();

  if (!recipientTokensSnapshot.exists) {
    logger.info('No recipients found for this notification');
    return;
  }

  // Get all valid FCM tokens from the user's devices
  const userData = recipientTokensSnapshot.data() ?? {};
  const tokens = (
    Array.isArray(userData.fcmTokens) ? userData.fcmTokens : userData.fcmToken ? [userData.fcmToken] : []
  ).filter((token): token is string => typeof token === 'string');

  if (!tokens.length) {
    logger.info('No valid FCM tokens found');
    return;
  }

  // Send messages in batches (FCM allows up to 500 tokens per request)
  const batchResponse = await getMessaging().sendEachForMulticast({
    ...message,
    tokens: tokens,
  });

  logger.info(
    `Successfully sent notifications: ${batchResponse.successCount} successful, ${batchResponse.failureCount} failed`
  );

  // Handle any failed messages
  if (batchResponse.failureCount > 0) {
    batchResponse.responses.forEach((resp: SendResponse) => {
      if (!resp.success) logger.error('Notification failed:', resp.error);
    });

    // Only the tokens FCM says are dead leave the document (notifications.ts); a
    // failure about the message or the moment keeps them.
    const dead = deadTokens(tokens, batchResponse.responses);
    if (dead.length > 0) {
      logger.info(`Removing ${dead.length} dead token${dead.length === 1 ? '' : 's'}`);

      const validTokens = Array.isArray(userData.fcmTokens)
        ? userData.fcmTokens.filter((token: string) => !dead.includes(token))
        : [];

      await recipientTokensSnapshot.ref.update({
        fcmTokens: validTokens,
        fcmToken: null,
      });
    }
  }
}

export const onNewPushCreated = onDocumentCreated('pushes/{pushId}', async (event) => {
  try {
    const snapshot = event.data;
    if (!snapshot) {
      logger.info('No data associated with the new push event');
      return;
    }

    const pushData = snapshot.data();
    const userRef = snapshot.ref.firestore.collection('users').doc(pushData.userId);

    // Count the push, or take it back: the rules let a burst through before any of it
    // is counted, and the count here is the exact one (usage.ts). A push taken back is
    // announced as removed, naming the limit, since the device that made it was told it
    // was saved (notifications.ts, `removedMessageOf`).
    const result = await recordPush(
      snapshot.ref.firestore,
      snapshot.ref,
      { userId: pushData.userId, type: pushData.type },
      new Date()
    );
    if (result.outcome === 'refused') {
      // recordPush refuses only a URL or file push; anything else it throws on. One its user
      // deleted before this ran was not taken back by anyone but them, so nothing is said.
      if (result.removed) await sendToDevices(userRef, removedMessageOf(pushData.type as 'url' | 'file', result.limit));
      return;
    }

    // The push's id and what a device needs to fetch it, nothing it holds (notifications.ts).
    await sendToDevices(userRef, pushMessageOf(event.params.pushId, pushData));
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
