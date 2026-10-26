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
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.firestore
import com.google.firebase.Firebase
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import androidx.core.app.TaskStackBuilder

class PushThatMessagingService : FirebaseMessagingService() {
    private val TAG = "PushThatMessaging"
    private val db = Firebase.firestore

    companion object {
        const val ACTION_PUSH_RECEIVED = "com.makerocketgonow.pushthat.PUSH_RECEIVED"
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "Refreshed token: $token")
        updateUserFcmToken(token)
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        Log.d(TAG, "From: ${remoteMessage.from}")

        // Check if message contains a data payload
        remoteMessage.data.isNotEmpty().let {
            Log.d(TAG, "Message data payload: ${remoteMessage.data}")
            val url = remoteMessage.data["url"]
            val title = remoteMessage.data["title"] ?: getString(R.string.new_push)
            val deviceName = remoteMessage.data["deviceName"]

            // Only show notification if it's from a different device
            if (url != null && deviceName != android.os.Build.MODEL) {
                sendNotification(title, url)
                // Send broadcast using LocalBroadcastManager
                try {
                    LocalBroadcastManager.getInstance(this)
                        .sendBroadcast(Intent(ACTION_PUSH_RECEIVED))
                    Log.d(TAG, "Sent push received broadcast")
                } catch (e: Exception) {
                    Log.e(TAG, "Error sending push received broadcast", e)
                }
            }
        }

        // Check if message contains a notification payload
        remoteMessage.notification?.let {
            Log.d(TAG, "Message Notification Body: ${it.body}")
            it.body?.let { body -> sendNotification(it.title ?: getString(R.string.new_push), body) }
        }
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

        val channelId = getString(R.string.default_notification_channel_id)
        val defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val notificationBuilder = NotificationCompat.Builder(this, channelId)
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

        // Create the notification channel for Android Oreo and above
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId,
                getString(R.string.default_notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT
            )
            notificationManager.createNotificationChannel(channel)
        }

        // Use URL's hashCode as the notification ID to ensure uniqueness per URL
        val notificationId = messageBody.hashCode()
        notificationManager.notify(notificationId, notificationBuilder.build())
    }

    private fun updateUserFcmToken(token: String) {
        val currentUser = FirebaseAuth.getInstance().currentUser
        if (currentUser == null) {
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