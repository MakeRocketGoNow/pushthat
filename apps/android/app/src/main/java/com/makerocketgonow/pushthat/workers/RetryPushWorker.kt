package com.makerocketgonow.pushthat.workers

import android.content.Context
import android.util.Log
import androidx.work.*
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.firestore
import com.google.firebase.storage.storage
import com.google.firebase.Firebase
import com.makerocketgonow.pushthat.data.AppDatabase
import kotlinx.coroutines.tasks.await
import java.util.concurrent.TimeUnit

class RetryPushWorker(
    context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {

    override suspend fun doWork(): Result {
        val database = AppDatabase.getDatabase(applicationContext)
        val pendingPushes = database.pendingPushDao().loadAllPendingPushes()
        val db = Firebase.firestore

        pendingPushes.forEach { pendingPush ->
            try {
                val push = hashMapOf(
                    "url" to pendingPush.url,
                    "userId" to pendingPush.userId,
                    "createdAt" to FieldValue.serverTimestamp(),
                    "title" to pendingPush.title,
                    "type" to pendingPush.type,
                    "deviceName" to pendingPush.deviceName
                )

                db.collection("pushes")
                    .add(push)
                    .await()

                // If successful, remove from local database
                database.pendingPushDao().delete(pendingPush)
            } catch (e: Exception) {
                // A push refused by the rules is past the month's limit: retrying it would fail
                // every time and hold every later pending push behind it. It is dropped, and a
                // file's upload, which went to Storage before the push was queued, is removed,
                // since no push document will ever name it for the sweep.
                if (e is FirebaseFirestoreException && e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                    Log.w(TAG, "Pending push refused at the limit; dropping it")
                    if (pendingPush.type == "file") {
                        runCatching { Firebase.storage.getReferenceFromUrl(pendingPush.url).delete().await() }
                            .onFailure { Log.w(TAG, "Could not remove the orphaned upload", it) }
                    }
                    database.pendingPushDao().delete(pendingPush)
                    return@forEach
                }
                // If any push fails, return retry to try again later
                return Result.retry()
            }
        }

        return Result.success()
    }

    companion object {
        private const val TAG = "RetryPushWorker"

        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val request = PeriodicWorkRequestBuilder<RetryPushWorker>(
                15, TimeUnit.MINUTES,
                5, TimeUnit.MINUTES
            )
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(
                    "retry_pushes",
                    ExistingPeriodicWorkPolicy.KEEP,
                    request
                )
        }
    }
}
