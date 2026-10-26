var path = require("path");
var admin = require("firebase-admin");

// Both come from the environment so that neither a device's token nor the service account
// key is ever written into the repository. See README.md beside this file.
const FCM_TOKEN = process.env.FCM_TOKEN;
const KEY_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, "serviceAccountKey.json");

if (!FCM_TOKEN) {
  console.error("Set FCM_TOKEN to the registration token of the device to send to.");
  process.exit(1);
}

var serviceAccount = require(path.resolve(KEY_PATH));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


async function sendTestNotification() {
  try {
    const fcmToken = FCM_TOKEN;

    const message = {
      notification: {
        title: 'Test Notification',
        body: 'This is a test notification using the v1 API!',
      },
      webpush: {
        fcmOptions: {
          link: 'https://example.com/some-page'  // Optional: URL to open when clicked
        },
        notification: {
          icon: '/icons/icon-192x192.png'  // Optional: notification icon
        }
      },
      token: fcmToken
    };

    const response = await admin.messaging().send(message);
    console.log('Successfully sent message:', response);
  } catch (error) {
    console.error('Error sending message:', error);
  }
}

// Run the function
sendTestNotification();
