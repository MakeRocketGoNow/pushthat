package com.makerocketgonow.pushthat

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.firestore
import com.google.firebase.Firebase
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import androidx.core.app.TaskStackBuilder
import com.makerocketgonow.pushthat.e2ee.AccountKeyStore
import com.makerocketgonow.pushthat.e2ee.PushContent
import com.makerocketgonow.pushthat.e2ee.PushDocument
import com.makerocketgonow.pushthat.e2ee.forgetSession
import java.util.concurrent.TimeUnit

class PushThatMessagingService : FirebaseMessagingService() {
    private val TAG = "PushThatMessaging"
    private val db = Firebase.firestore

    companion object {
        const val ACTION_PUSH_RECEIVED = "com.makerocketgonow.pushthat.PUSH_RECEIVED"

        // The read of the push before its notification shows. FCM gives onMessageReceived
        // about ten seconds on some versions before the process may go; past this the
        // notification says "New push" rather than nothing.
        private const val READ_TIMEOUT_SECONDS = 8L
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "Refreshed token: $token")
        updateUserFcmToken(token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.d(TAG, "From: ${remoteMessage.from}")

        // An encrypted push carries only its id (docs/e2ee.md, Notifications): the content
        // is read and decrypted here. A plaintext push, from a client that has not updated,
        // still carries its URL and title and is shown as before.
        val pushId = remoteMessage.data["pushId"]
        if (remoteMessage.data["url"] == null && pushId != null) {
            receiveEncrypted(pushId, remoteMessage.data["deviceId"])
            return
        }

        // Check if message contains a data payload
        remoteMessage.data.isNotEmpty().let {
            val url = remoteMessage.data["url"]
            val title = remoteMessage.data["title"] ?: getString(R.string.new_push)
            val deviceName = remoteMessage.data["deviceName"]

            // Only show notification if it's from a different device
            if (url != null && deviceName != android.os.Build.MODEL) {
                sendNotification(title, url)
                broadcastPushReceived()
            }
        }

        // Check if message contains a notification payload
        remoteMessage.notification?.let {
            Log.d(TAG, "Message Notification Body: ${it.body}")
            it.body?.let { body -> sendNotification(it.title ?: getString(R.string.new_push), body) }
        }
    }

    /**
     * An encrypted push: skipped when this install sent it, else read from the server,
     * decrypted, and shown as a plaintext one was. Anything that stops that (offline, no key,
     * a key a reset replaced, a push that does not open) still says a push arrived, as "New
     * push", and a tap opens the list, which decrypts when it can. Runs on FCM's worker
     * thread, which may block.
     */
    private fun receiveEncrypted(pushId: String, senderDeviceId: String?) {
        if (senderDeviceId != null && senderDeviceId == AccountKeyStore.deviceId(this)) return
        val content = try {
            readPush(pushId)
        } catch (e: Exception) {
            Log.w(TAG, "The push could not be read", e)
            null
        }
        when (content) {
            is PushContent.Url -> {
                val title = content.title.ifBlank { Uri.parse(content.url).host ?: content.url }
                sendNotification(title, content.url)
                // A web push goes out without a title, since no server may fetch the page; the
                // first phone to receive it fills it in.
                if (content.title.isBlank()) TitleScrapingWorker.enqueue(applicationContext, pushId)
            }
            is PushContent.File -> sendAppNotification(content.name, getString(R.string.file_push_body), pushId.hashCode())
            null -> sendAppNotification(getString(R.string.new_push), null, pushId.hashCode())
        }
        broadcastPushReceived()
    }

    /** The push's content, or null when this install cannot open it. */
    private fun readPush(pushId: String): PushContent? {
        val uid = FirebaseAuth.getInstance().currentUser?.uid ?: return null
        val keys = AccountKeyStore.pushKeys(this, uid) ?: return null
        val read = db.collection("pushes").document(pushId).get(Source.SERVER)
        val data = Tasks.await(read, READ_TIMEOUT_SECONDS, TimeUnit.SECONDS).data ?: return null
        return when (val push = PushDocument.read(keys, pushId, data)) {
            is PushDocument.Read.Opened -> push.content
            // Not what the function sends for a plaintext push, but shown the same way if so.
            is PushDocument.Read.Plain -> if (push.type == PushContent.TYPE_FILE) null else PushContent.Url(push.url, push.title, push.ext ?: "")
            PushDocument.Read.Locked, null -> null
        }
    }

    private fun broadcastPushReceived() {
        try {
            LocalBroadcastManager.getInstance(this)
                .sendBroadcast(Intent(ACTION_PUSH_RECEIVED))
            Log.d(TAG, "Sent push received broadcast")
        } catch (e: Exception) {
            Log.e(TAG, "Error sending push received broadcast", e)
        }
    }

    /** A notification whose tap opens the app's list: a file push, or one not yet read. */
    private fun sendAppNotification(title: String, body: String?, notificationId: Int) {
        val appIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, notificationId, appIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = NotificationCompat.Builder(this, ensureChannel())
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setAutoCancel(true)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION))
            .setContentIntent(pendingIntent)
        body?.let { builder.setContentText(it) }
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(notificationId, builder.build())
    }

    /** The one channel every push notification goes to, made on first use (Android 8 on). */
    private fun ensureChannel(): String {
        val channelId = getString(R.string.default_notification_channel_id)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                getString(R.string.default_notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT
            )
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
        }
        return channelId
    }

    private fun sendNotification(title: String, messageBody: String) {
        // Create an Intent for opening the URL
        // val openIntent = Intent(Intent.ACTION_VIEW).apply {
        //     data = Uri.parse(messageBody)
        //     flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        // }

        // val openPendingIntent = PendingIntent.getActivity(
        //     this, 1, openIntent,
        //     PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
        // )

        // Create an Intent for opening the app
        val appIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("url", messageBody)  // Pass the URL to MainActivity
        }

        // Create the browser intent
        val browserIntent = Intent(Intent.ACTION_VIEW, Uri.parse(messageBody))

        // Create the TaskStackBuilder
        val stackBuilder = TaskStackBuilder.create(this).apply {
            addNextIntentWithParentStack(appIntent)
            addNextIntent(browserIntent)
        }

        val pendingIntent = stackBuilder.getPendingIntent(
            0,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val notificationBuilder = NotificationCompat.Builder(this, ensureChannel())
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(messageBody)
            .setAutoCancel(true)
            .setSound(defaultSoundUri)
            .setContentIntent(pendingIntent)
            // Add the Open action
            // .addAction(
            //     R.drawable.ic_notification,
            //     getString(R.string.open_push),
            //     openPendingIntent
            // )

        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        // Use URL's hashCode as the notification ID to ensure uniqueness per URL
        val notificationId = messageBody.hashCode()
        notificationManager.notify(notificationId, notificationBuilder.build())
    }

    private fun updateUserFcmToken(token: String) {
        val currentUser = FirebaseAuth.getInstance().currentUser
        if (currentUser == null) {
            // A session that ended other than by Logout leaves the key behind; it goes now
            // (see LoginActivity.onCreate).
            forgetSession(this)
            Log.w(TAG, "No user logged in, cannot update FCM token")
            return
        }

        val userRef = db.collection("users").document(currentUser.uid)

        userRef.get()
            .addOnSuccessListener { document ->
                if (document.exists()) {
                    @Suppress("UNCHECKED_CAST")
                    val existingTokens = document.get("fcmTokens") as? List<String> ?: emptyList()
                    if (!existingTokens.contains(token)) {
                        userRef.update("fcmTokens", FieldValue.arrayUnion(token))
                            .addOnSuccessListener {
                                Log.d(TAG, "FCM Token added successfully")
                            }
                            .addOnFailureListener { e ->
                                Log.w(TAG, "Error adding FCM token", e)
                            }
                    }
                } else {
                    userRef.set(mapOf(
                        "fcmTokens" to listOf(token),
                        "createdAt" to FieldValue.serverTimestamp()
                    ))
                        .addOnSuccessListener {
                            Log.d(TAG, "New user document created with FCM token")
                        }
                        .addOnFailureListener { e ->
                            Log.w(TAG, "Error creating user document", e)
                        }
                }
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "Error checking user document", e)
            }
    }
}