package com.makerocketgonow.pushthat.e2ee

import android.util.Log
import com.google.firebase.Firebase
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.firestore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await

/**
 * Encrypts the account's plaintext pushes in place (docs/e2ee.md, Migration), in the
 * background, once per process and account, from the newest. In place rather than
 * recreated, because a create would fire `onNewPushCreated` (a notification on every
 * device) and count against the month.
 *
 * Every client runs the same pass, and the first to finish marks the account
 * `e2ee.migratedAt` so the others skip it. A push the rules refuse is logged and the mark
 * is not set, so the next start tries again; nothing is shown to the user either way, since
 * the list reads both shapes.
 */
object PushMigration {
    private const val TAG = "PushMigration"
    private const val PAGE = 50L

    private val started = mutableSetOf<String>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Starts the pass for [keys]'s account unless this process already has one running or
     * finished. A pass that completed with pushes the rules refused stays started: it would
     * meet the same refusals again, and the next launch tries. One that threw (offline at
     * launch, most likely) is forgotten, so the next start in this process runs it, rather
     * than nothing running until the process dies.
     */
    fun startOnce(keys: PushKeys) {
        synchronized(started) { if (!started.add(keys.uid)) return }
        scope.launch {
            try {
                migrate(keys)
            } catch (e: Exception) {
                Log.w(TAG, "The push migration stopped", e)
                synchronized(started) { started.remove(keys.uid) }
            }
        }
    }

    private suspend fun migrate(keys: PushKeys) {
        val db = Firebase.firestore
        val userRef = db.collection("users").document(keys.uid)
        val e2ee = userRef.get(Source.SERVER).await().get("e2ee") as? Map<*, *> ?: return
        if (e2ee.containsKey("migratedAt")) return
        // A key a reset has replaced would write pushes the account can no longer open, and
        // the rules would refuse each one anyway.
        if ((e2ee["keyVersion"] as? Number)?.toLong() != keys.keyVersion) return

        var failed = 0
        var last: DocumentSnapshot? = null
        while (true) {
            var query = db.collection("pushes")
                .whereEqualTo("userId", keys.uid)
                .orderBy("createdAt", Query.Direction.DESCENDING)
                .limit(PAGE)
            // After the last document seen, not the last one changed, so a page of pushes
            // that are already encrypted still moves the pass on.
            last?.let { query = query.startAfter(it) }
            val page = query.get(Source.SERVER).await()
            if (page.isEmpty) break
            for (doc in page.documents) {
                if (!migrateOne(keys, doc)) failed++
            }
            last = page.documents.last()
        }

        if (failed > 0) {
            Log.w(TAG, "$failed pushes could not be encrypted; the account is not marked")
            return
        }
        // The field path, so the rest of the map (the wraps) is left as it is.
        userRef.update("e2ee.migratedAt", FieldValue.serverTimestamp()).await()
        Log.d(TAG, "Every push is encrypted")
    }

    /**
     * One push, by its own update rather than a batch, so one the rules refuse does not stop
     * the others. True when it is done or needs nothing (already encrypted, or a push that
     * cannot be migrated and is left as it is); false when it should be tried again.
     */
    private suspend fun migrateOne(keys: PushKeys, doc: DocumentSnapshot): Boolean {
        val data = doc.data ?: return true
        val migration = try {
            PushDocument.migration(keys, doc.id, data) ?: return true
        } catch (e: PushTooLargeException) {
            // A URL from before the rules bounded it, too long to seal within `enc.ct`'s
            // bound. The rules would refuse it on every pass, so it stays plaintext and counts
            // as done, as on the web and iOS; counted as a failure, it kept the account from
            // ever being marked and every start paged through the whole history again. Nothing
            // of the push goes into the log.
            Log.w(TAG, "A push is too long to encrypt; it is left as it is")
            return true
        } catch (e: Exception) {
            Log.w(TAG, "A push could not be encrypted", e)
            return false
        }
        // Field paths rather than a map of names: a name an old client wrote could hold a
        // dot, which a map key would read as a path into a field that is not there.
        val updates = migration.set.map { (name, value) -> FieldPath.of(name) to value } +
            migration.delete.map { name -> FieldPath.of(name) to FieldValue.delete() }
        val (first, rest) = updates.first() to updates.drop(1)
        return try {
            doc.reference.update(first.first, first.second, *rest.flatMap { listOf(it.first, it.second) }.toTypedArray()).await()
            true
        } catch (e: Exception) {
            Log.w(TAG, "A push could not be migrated", e)
            false
        }
    }
}
