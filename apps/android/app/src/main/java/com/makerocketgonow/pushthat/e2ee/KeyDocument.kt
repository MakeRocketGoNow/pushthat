package com.makerocketgonow.pushthat.e2ee

import com.google.firebase.Firebase
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.firestore
import kotlinx.coroutines.tasks.await

/**
 * Reads and writes `users/{uid}.e2ee`. The rules (`isE2ee`, `isE2eeUpdate` in
 * apps/web/firestore.rules) take the map whole and refuse a `keyVersion` that goes down.
 */
class KeyDocument(private val db: FirebaseFirestore = Firebase.firestore) {

    /**
     * The stored keys, from the server. Not the cache: a sign-in decides from this whether
     * the password opens the keys or the account needs its recovery key, and a cached copy
     * from before another device changed them would send it the wrong way. Sign-in needs
     * the network anyway.
     */
    suspend fun read(uid: String): StoredKeys? {
        val snapshot = db.collection("users").document(uid).get(Source.SERVER).await()
        return StoredKeys.parse(snapshot.get("e2ee"))
    }

    /**
     * Writes the `e2ee` map [build] makes from the stored one, read again inside the
     * transaction, and returns it; [build] returning null writes nothing. A map built from
     * an earlier read would undo whatever changed `e2ee` since (a wrap another device
     * wrote, `migratedAt`), which the rules cannot see at an equal `keyVersion`. [build]
     * may run more than once and must not have side effects beyond its result; it throws
     * [KeysChangedException] when what it finds is not what the caller decided from.
     *
     * A user document that does not exist yet is created with `email` and `createdAt`, as
     * the sign-up wrote it before, in the same transaction rather than by a blind set:
     * another client (the FCM token write, the extension) can create it first.
     */
    suspend fun write(uid: String, email: String, build: (StoredKeys?) -> Map<String, Any?>?): Map<String, Any?>? {
        val ref = db.collection("users").document(uid)
        try {
            return db.runTransaction { transaction ->
                val snapshot = transaction.get(ref)
                val e2ee = build(StoredKeys.parse(snapshot.get("e2ee"))) ?: return@runTransaction null
                if (snapshot.exists()) {
                    transaction.update(ref, "e2ee", e2ee)
                } else {
                    transaction.set(
                        ref,
                        mapOf("email" to email, "createdAt" to FieldValue.serverTimestamp(), "e2ee" to e2ee)
                    )
                }
                e2ee
            }.await()
        } catch (e: Exception) {
            // The SDK may hand back what the function threw wrapped in its own exception;
            // the callers decide on this one, so it comes out as itself.
            var cause: Throwable? = e
            while (cause != null) {
                if (cause is KeysChangedException) throw cause
                cause = cause.cause
            }
            throw e
        }
    }
}

/**
 * The stored keys are not the ones a step decided from: another device rewrapped them or
 * replaced the account key meanwhile. The caller reads them again rather than writing over
 * what changed.
 */
class KeysChangedException(message: String) : Exception(message)
