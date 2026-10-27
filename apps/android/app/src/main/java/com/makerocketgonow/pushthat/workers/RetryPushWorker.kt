package com.makerocketgonow.pushthat.workers

import android.content.Context
import android.util.Log
import androidx.work.*
import com.google.firebase.auth.auth
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.firestore
import com.google.firebase.storage.storage
import com.google.firebase.Firebase
import com.makerocketgonow.pushthat.data.AppDatabase
import com.makerocketgonow.pushthat.data.PendingPush
import com.makerocketgonow.pushthat.e2ee.AccountKeyStore
import com.makerocketgonow.pushthat.e2ee.PreparedPush
import com.makerocketgonow.pushthat.e2ee.PushContent
import com.makerocketgonow.pushthat.e2ee.PushStore
import kotlinx.coroutines.tasks.await
import java.util.concurrent.TimeUnit

class RetryPushWorker(
    context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {

    override suspend fun doWork(): Result {
        val database = AppDatabase.getDatabase(applicationContext)
        val dao = database.pendingPushDao()
        val store = PushStore()

        for (pendingPush in dao.loadAllPendingPushes()) {
            val prepared = when (val ready = prepare(pendingPush)) {
                Ready.Wait -> continue
                Ready.Drop -> {
                    dao.delete(pendingPush)
                    continue
                }
                is Ready.Push -> ready.prepared
            }
            try {
                store.create(prepared).await()
                dao.delete(pendingPush)
            } catch (e: Exception) {
                if (e is FirebaseFirestoreException && e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                    // An earlier attempt may have landed, and then this write is refused as
                    // an update of it: that push is done, and its file is the push's.
                    try {
                        if (store.landed(prepared)) {
                            dao.delete(pendingPush)
                            continue
                        }
                    } catch (checkFailed: Exception) {
                        return Result.retry()
                    }
                    // Refused for real: past the month's limit, or under a key version the
                    // account has moved on from. Either fails the same way every time and
                    // would hold every later pending push behind it, so it is dropped, and a
                    // file's upload is removed, since no push document will name it for the
                    // sweep.
                    Log.w(TAG, "Pending push refused; dropping it")
                    prepared.objectPath?.let { path ->
                        runCatching { Firebase.storage.reference.child(path).delete().await() }
                            .onFailure { Log.w(TAG, "Could not remove the orphaned upload", it) }
                    }
                    dao.delete(pendingPush)
                    continue
                }
                // If any push fails, return retry to try again later
                return Result.retry()
            }
        }

        return Result.success()
    }

    private sealed class Ready {
        class Push(val prepared: PreparedPush) : Ready()
        /** Kept until this install is signed in to its account and holds that account's key. */
        data object Wait : Ready()
        data object Drop : Ready()
    }

    /**
     * The push [row] writes. A row queued before encryption is encrypted here, with a new id
     * since it never had one, and saved back first, so that a retry after this one writes
     * the same id rather than a second push.
     */
    private fun prepare(row: PendingPush): Ready {
        row.prepared?.let { json ->
            val prepared = try {
                PreparedPush.fromJson(json)
            } catch (e: Exception) {
                Log.w(TAG, "A pending push could not be read; dropping it", e)
                return Ready.Drop
            }
            // While this install is signed out, or signed in to another account, the rules
            // refuse the write and `landed` cannot read the push either, so it would be taken
            // for a real refusal and dropped with its upload. It waits for its own account to
            // sign in again, as a row not yet encrypted waits for its account's key.
            if (prepared.userId != Firebase.auth.currentUser?.uid) return Ready.Wait
            return Ready.Push(prepared)
        }
        // Without an owner it was refused by the rules before, and would be now.
        val uid = row.userId ?: return Ready.Drop
        val keys = AccountKeyStore.pushKeys(applicationContext, uid) ?: return Ready.Wait
        val pushId = Firebase.firestore.collection("pushes").document().id
        val prepared = try {
            if (row.type == PushContent.TYPE_FILE) {
                // Its object was uploaded in plaintext under its file name, as the migration
                // finds old file pushes: it is opened as it is, so it goes as legacyPlain.
                val objectPath = Firebase.storage.getReferenceFromUrl(row.url).path.trimStart('/')
                val ext = row.title.substringAfterLast('.', "").lowercase()
                val content = PushContent.File(row.title, "", 0, ext, null, null, legacyPlain = true)
                PreparedPush.prepare(keys, pushId, content, objectPath)
            } else {
                val ext = android.net.Uri.parse(row.url).lastPathSegment?.substringAfterLast('.', "") ?: ""
                PreparedPush.prepare(keys, pushId, PushContent.Url(row.url, row.title, ext))
            }
        } catch (e: Exception) {
            Log.w(TAG, "A pending push could not be encrypted; dropping it", e)
            return Ready.Drop
        }
        AppDatabase.getDatabase(applicationContext).pendingPushDao()
            .update(row.copy(url = "", title = "", prepared = prepared.toJson()))
        return Ready.Push(prepared)
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
