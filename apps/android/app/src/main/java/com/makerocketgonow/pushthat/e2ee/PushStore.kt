package com.makerocketgonow.pushthat.e2ee

import com.google.firebase.Firebase
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.firestore
import com.google.android.gms.tasks.Task
import kotlinx.coroutines.tasks.await

/**
 * The Firestore side of writing an encrypted push: the create, and the two questions a
 * refused create raises.
 */
class PushStore(private val db: FirebaseFirestore = Firebase.firestore) {

    /** Creates [prepared] at its own id, `createdAt` the server's time. */
    fun create(prepared: PreparedPush): Task<Void> =
        db.collection("pushes").document(prepared.id)
            .set(prepared.fields() + ("createdAt" to FieldValue.serverTimestamp()))

    /**
     * Whether [prepared] is already in Firestore. A retry writes the same id, and if an
     * earlier attempt did land (the SDK's own offline queue, or a reply lost on the way
     * back) the rules refuse the second write as an update; without this check the retry
     * would take that refusal for the limit and delete the file the push names. A missing
     * document reads as refused too (the read rule looks at its `userId`), so that is
     * "no" here; any other failure is left to the caller to retry.
     */
    suspend fun landed(prepared: PreparedPush): Boolean = try {
        val snapshot = db.collection("pushes").document(prepared.id).get(Source.SERVER).await()
        snapshot.exists() && snapshot.getString("userId") == prepared.userId
    } catch (e: FirebaseFirestoreException) {
        if (e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) false else throw e
    }

    /**
     * Whether the account's keys moved on from the ones [keys] holds (a reset without the
     * recovery key). The rules refuse a push under a version that is not the account's
     * current one, the same refusal as the month's limit, and this tells the two apart so
     * the user is not told they hit a limit they did not. Null when it cannot be read.
     */
    suspend fun keyIsStale(keys: PushKeys): Boolean? = try {
        val stored = KeyDocument(db).read(keys.uid)
        stored != null && stored.keyVersion != keys.keyVersion
    } catch (e: Exception) {
        null
    }
}
