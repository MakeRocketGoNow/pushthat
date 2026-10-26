package com.makerocketgonow.pushthat.e2ee

import android.content.Context
import android.util.Log
import com.google.firebase.Firebase
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.auth
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.security.GeneralSecurityException

/**
 * docs/e2ee.md: a new password (at sign-up and when it is changed) has at least 10
 * characters, and the screen says why. Sign-in takes what it is given, since accounts from
 * before the rule have shorter passwords. Here rather than on a screen, because the sign-in
 * screen and the change password dialog both check it and both say it.
 */
const val MIN_NEW_PASSWORD_LENGTH = 10

/**
 * Signing in, registering and recovering with the end-to-end keys: docs/e2ee.md, "Keys"
 * and "Migration", for what the keys are and how an account moves to them, and the web's
 * apps/web/src/services/signIn.ts for the same flow in the app the others follow.
 * Firebase Auth is given `base64url(authKey)`, never the password; `masterKey` opens the
 * account key on the user document; the account key is all this install keeps.
 *
 * Every step that can take a second (the derivation, the network) is a suspend function
 * off the main thread, and the screens show progress meanwhile.
 */
class AccountKeys(
    context: Context,
    private val auth: FirebaseAuth = Firebase.auth,
    private val document: KeyDocument = KeyDocument(),
) {
    private val appContext = context.applicationContext

    sealed interface Outcome {
        /** The key is stored and the user can go in, once they have saved [recoveryKey] if one was made. */
        class Ready(val recoveryKey: String?) : Outcome

        /** The password opens no wrap but a recovery key could: ask for it. */
        class NeedsRecovery(val pending: Pending) : Outcome
    }

    /**
     * A signed-in account waiting for its recovery key, with what the steps after need.
     * Held in memory only: if the process goes, the session without a key brings the user
     * back to the password prompt, which derives these again.
     */
    class Pending internal constructor(
        internal val uid: String,
        internal val email: String,
        internal val masterKey: ByteArray,
        internal val firebasePassword: String,
        internal val legacy: Boolean,
        internal val stored: StoredKeys,
    )

    /** The recovery key opens none of the account's recovery wraps, or is not one at all. */
    class WrongRecoveryKeyException : Exception("that recovery key does not open this account's keys")

    // -------------------------------------------------------------------------------------
    // Registration

    /**
     * A new account: Firebase gets `authKey`, then the account key and a recovery key are
     * made and both wraps written together, before the key is shown. A recovery wrap the
     * user never saves costs nothing; one written later could leave an app closed on the
     * key screen with no recovery wrap at all.
     */
    suspend fun register(email: String, password: String): Outcome.Ready {
        val keys = derive(email, password)
        auth.createUserWithEmailAndPassword(email, keys.firebasePassword).await()
        val uid = currentUid()
        return startNewKeys(uid, email, keys.masterKey, keys.firebasePassword, legacy = false, decidedFrom = null)
    }

    // -------------------------------------------------------------------------------------
    // Signing in, which is also the unlock for a session with no key

    suspend fun signIn(email: String, password: String): Outcome {
        val keys = derive(email, password)
        val legacy = signInToFirebase(email, password, keys.firebasePassword)
        return resolve(currentUid(), email, keys.masterKey, keys.firebasePassword, legacy)
    }

    /**
     * Signs in with `authKey`, and on a wrong-password error only (not the network, not too
     * many requests) with the password itself, which is what an account from before the
     * encryption has. Returns whether that is what worked. A sign-in that fails both ways
     * reports the first error, which is the one about the credentials the user will use
     * from now on.
     *
     * The password trimmed is tried last because this app trimmed it before sending it, at
     * registration and at sign-in, so an account made here with a space at either end has
     * the trimmed password in Firebase. The keys are derived from it untrimmed, as the
     * spec says and the other apps do, so it signs in the same everywhere afterwards.
     */
    private suspend fun signInToFirebase(email: String, password: String, firebasePassword: String): Boolean {
        try {
            auth.signInWithEmailAndPassword(email, firebasePassword).await()
            return false
        } catch (first: FirebaseAuthInvalidCredentialsException) {
            for (legacyPassword in listOf(password, password.trim()).distinct()) {
                if (legacyPassword.isEmpty()) continue
                try {
                    auth.signInWithEmailAndPassword(email, legacyPassword).await()
                    return true
                } catch (_: FirebaseAuthInvalidCredentialsException) {
                    // Not this one either.
                }
            }
            throw first
        }
    }

    /**
     * What the stored keys say to do with this password's `masterKey`: open the account key,
     * ask for the recovery key, or start new keys. Read once more, and only once, if a
     * write finds the keys changed since the read.
     */
    private suspend fun resolve(
        uid: String,
        email: String,
        masterKey: ByteArray,
        firebasePassword: String,
        legacy: Boolean,
        retried: Boolean = false,
    ): Outcome {
        val stored = document.read(uid)
        try {
            val opened = stored?.let { E2ee.openAny(masterKey, it.wraps, uid, E2ee.BY_PASSWORD) }
            return when {
                stored != null && opened != null -> {
                    val (openedId, accountKey) = opened
                    // A legacy sign-in that finds its wrap is a migration that stopped after
                    // writing the keys and before the password change, so the user may never
                    // have seen the recovery key: make a new one, then finish the change.
                    val recoveryKey = if (legacy) {
                        replaceRecoveryWraps(uid, email, accountKey, stored, keepPassword = openedId)
                    } else {
                        null
                    }
                    if (legacy) updatePassword(firebasePassword)
                    keep(uid, accountKey, stored.keyVersion, recoveryKey)
                    Outcome.Ready(recoveryKey)
                }
                stored != null && stored.hasRecoveryWrap() ->
                    Outcome.NeedsRecovery(Pending(uid, email, masterKey, firebasePassword, legacy, stored))
                else -> startNewKeys(uid, email, masterKey, firebasePassword, legacy, decidedFrom = stored)
            }
        } catch (e: KeysChangedException) {
            if (retried) throw e
            return resolve(uid, email, masterKey, firebasePassword, legacy, retried = true)
        }
    }

    // -------------------------------------------------------------------------------------
    // The recovery key prompt

    /**
     * With the recovery key: opens the account key, and writes a password wrap for it beside
     * the recovery wraps (the one that opened first, at most three, so the new wrap fits in
     * the rules' four). The password wraps nothing opens go. No new recovery key is shown:
     * the user has just shown they have this one.
     */
    suspend fun recover(pending: Pending, recoveryText: String): Outcome {
        val opened = withContext(Dispatchers.Default) {
            val recoveryBytes = try {
                E2ee.decodeRecoveryKey(recoveryText)
            } catch (_: IllegalArgumentException) {
                throw WrongRecoveryKeyException()
            }
            E2ee.openAny(E2ee.recoveryWrappingKey(recoveryBytes), pending.stored.wraps, pending.uid, E2ee.BY_RECOVERY)
                ?: throw WrongRecoveryKeyException()
        }
        val (openedId, accountKey) = opened
        val passwordWrap = E2ee.wrapAccountKey(pending.masterKey, accountKey, pending.uid, E2ee.BY_PASSWORD)
        try {
            document.write(pending.uid, pending.email) { stored ->
                if (stored == null || !sameKeys(stored, pending.stored)) {
                    throw KeysChangedException("the stored keys changed while the recovery key was asked for")
                }
                val recovery = stored.wrapsBy(E2ee.BY_RECOVERY)
                val kept = (recovery.filterKeys { it == openedId } + recovery).entries
                    .take(StoredKeys.MAX_WRAPS - 1).associate { it.toPair() }
                stored.with(mapOf(E2ee.newWrapId() to passwordWrap) + kept)
            }
        } catch (_: KeysChangedException) {
            // Another device changed the keys meanwhile; the password may open them now.
            return resolve(pending.uid, pending.email, pending.masterKey, pending.firebasePassword, pending.legacy)
        }
        if (pending.legacy) updatePassword(pending.firebasePassword)
        keep(pending.uid, accountKey, pending.stored.keyVersion)
        return Outcome.Ready(null)
    }

    /**
     * "I don't have it", once the user has confirmed that the pushes encrypted before now
     * will not be readable: a new account key under the next `keyVersion`.
     */
    suspend fun startOver(pending: Pending): Outcome = try {
        startNewKeys(pending.uid, pending.email, pending.masterKey, pending.firebasePassword, pending.legacy, pending.stored)
    } catch (_: KeysChangedException) {
        resolve(pending.uid, pending.email, pending.masterKey, pending.firebasePassword, pending.legacy)
    }

    // -------------------------------------------------------------------------------------
    // Settings, on a signed-in install that holds the key

    /** This install holds no account key, so it has nothing to rewrap. */
    class NoAccountKeyException : Exception("this install holds no account key")

    /**
     * The spec's order: a new password wrap first, then the Firebase password, then the old
     * wrap goes. A crash between any two leaves an account that opens with either password,
     * never one that opens with neither.
     */
    suspend fun changePassword(currentPassword: String, newPassword: String) {
        val user = auth.currentUser ?: throw IllegalStateException("not signed in")
        val email = user.email ?: throw IllegalStateException("the account has no email")
        val uid = user.uid
        val device = withContext(Dispatchers.IO) { AccountKeyStore.load(appContext, uid) } ?: throw NoAccountKeyException()

        val current = derive(email, currentPassword)
        user.reauthenticate(EmailAuthProvider.getCredential(email, current.firebasePassword)).await()
        val next = derive(email, newPassword)
        val newWrap = withContext(Dispatchers.Default) {
            E2ee.wrapAccountKey(next.masterKey, device.accountKey, uid, E2ee.BY_PASSWORD)
        }
        val newWrapId = E2ee.newWrapId()

        var oldWrapIds: Set<String> = emptySet()
        document.write(uid, email) { stored ->
            // The wraps the current password opens to this install's key. None means the
            // key here is not the account's any more (replaced by a reset elsewhere), and a
            // wrap of it under the new password would open a key nothing uses.
            val opened = stored?.wrapsBy(E2ee.BY_PASSWORD)?.filterValues { wrap ->
                try {
                    E2ee.unwrapAccountKey(current.masterKey, wrap, uid).contentEquals(device.accountKey)
                } catch (_: GeneralSecurityException) {
                    false
                }
            }.orEmpty()
            if (stored == null || opened.isEmpty()) {
                throw KeysChangedException("the current password opens none of the stored keys")
            }
            oldWrapIds = opened.keys
            // One wrap the current password opens stays until the Firebase password has
            // changed; password wraps nothing opens are from a password that is gone. The
            // recovery wraps stay, as many as fit beside the two password wraps.
            val keep = opened.entries.first()
            val recovery = stored.wrapsBy(E2ee.BY_RECOVERY).entries.take(StoredKeys.MAX_WRAPS - 2)
            stored.with(
                mapOf(keep.toPair()) + recovery.associate { it.toPair() } + (newWrapId to newWrap)
            )
        }

        user.updatePassword(next.firebasePassword).await()

        // The password has changed by now, so a failure here is not the user's to see: an
        // old wrap left behind opens with a password Firebase no longer accepts, and the
        // next change removes it as one nothing opens.
        try {
            document.write(uid, email) { stored ->
                val remaining = stored?.wraps?.filterKeys { it !in oldWrapIds } ?: return@write null
                if (remaining.size == stored.wraps.size) null else stored.with(remaining)
            }
        } catch (e: Exception) {
            Log.w(TAG, "The old password's wrap could not be removed", e)
        }
    }

    /**
     * A new recovery key in place of every recovery wrap, under this install's key, returned
     * in its display form for the same screen as sign-up.
     */
    suspend fun replaceRecoveryKey(): String {
        val user = auth.currentUser ?: throw IllegalStateException("not signed in")
        val email = user.email ?: throw IllegalStateException("the account has no email")
        val device = withContext(Dispatchers.IO) { AccountKeyStore.load(appContext, user.uid) } ?: throw NoAccountKeyException()
        val recoveryBytes = E2ee.newRecoveryKey()
        val recoveryWrap = withContext(Dispatchers.Default) {
            E2ee.wrapAccountKey(E2ee.recoveryWrappingKey(recoveryBytes), device.accountKey, user.uid, E2ee.BY_RECOVERY)
        }
        document.write(user.uid, email) { stored ->
            // keyVersion goes up with every new account key, so an equal one means this
            // install's key is the account's.
            if (stored == null || stored.keyVersion != device.keyVersion) {
                throw KeysChangedException("this install's key is not the account's current one")
            }
            val password = stored.wrapsBy(E2ee.BY_PASSWORD).entries.take(StoredKeys.MAX_WRAPS - 1)
            stored.with(password.associate { it.toPair() } + (E2ee.newWrapId() to recoveryWrap))
        }
        val recoveryKey = E2ee.encodeRecoveryKey(recoveryBytes)
        // Kept until "I saved it", as at sign-up (AccountKeyStore). A failure here is only
        // logged: the old recovery key has stopped working already, so the new one is shown
        // either way, and only a process that dies before it is saved would lose it.
        withContext(Dispatchers.IO) {
            try {
                AccountKeyStore.saveUnconfirmedRecoveryKey(appContext, user.uid, recoveryKey)
            } catch (e: Exception) {
                Log.w(TAG, "The new recovery key could not be kept until it is confirmed", e)
            }
        }
        return recoveryKey
    }

    // -------------------------------------------------------------------------------------
    // Steps

    /**
     * A new account key, wrapped under the password and a new recovery key, replacing every
     * stored wrap, one `keyVersion` past the stored one (or 1 for an account with none).
     * [decidedFrom] is what the caller read when it chose this: if the stored keys are not
     * that any more (another device migrated the same account a moment ago, say), writing
     * here would replace a key that device is already using, so the caller reads again.
     */
    private suspend fun startNewKeys(
        uid: String,
        email: String,
        masterKey: ByteArray,
        firebasePassword: String,
        legacy: Boolean,
        decidedFrom: StoredKeys?,
    ): Outcome.Ready {
        val (accountKey, recoveryBytes, wraps) = withContext(Dispatchers.Default) {
            val accountKey = E2ee.newAccountKey()
            val recoveryBytes = E2ee.newRecoveryKey()
            val wraps = mapOf(
                E2ee.newWrapId() to E2ee.wrapAccountKey(masterKey, accountKey, uid, E2ee.BY_PASSWORD),
                E2ee.newWrapId() to E2ee.wrapAccountKey(E2ee.recoveryWrappingKey(recoveryBytes), accountKey, uid, E2ee.BY_RECOVERY),
            )
            Triple(accountKey, recoveryBytes, wraps)
        }
        val written = document.write(uid, email) { stored ->
            if (!sameKeys(stored, decidedFrom)) throw KeysChangedException("the stored keys changed before new ones were written")
            if (stored == null) StoredKeys.fresh(wraps) else stored.with(wraps, stored.keyVersion + 1)
        }
        // Only after the keys are written: a crash between the two leaves an account that
        // still signs in with the old password and finds its wrap (the legacy + opened case).
        if (legacy) updatePassword(firebasePassword)
        val keyVersion = (written?.get("keyVersion") as? Number)?.toLong() ?: 1L
        val recoveryKey = E2ee.encodeRecoveryKey(recoveryBytes)
        keep(uid, accountKey, keyVersion, recoveryKey)
        return Outcome.Ready(recoveryKey)
    }

    /** A new recovery key in place of every recovery wrap, returned in its display form. */
    private suspend fun replaceRecoveryWraps(
        uid: String,
        email: String,
        accountKey: ByteArray,
        decidedFrom: StoredKeys,
        keepPassword: String?,
    ): String {
        val recoveryBytes = E2ee.newRecoveryKey()
        val recoveryWrap = withContext(Dispatchers.Default) {
            E2ee.wrapAccountKey(E2ee.recoveryWrappingKey(recoveryBytes), accountKey, uid, E2ee.BY_RECOVERY)
        }
        document.write(uid, email) { stored ->
            // The account key opened is the one at the version read; under a newer one, a
            // recovery wrap of it would open a key nothing is encrypted with any more.
            if (stored == null || stored.keyVersion != decidedFrom.keyVersion) {
                throw KeysChangedException("the account key changed before the recovery key was replaced")
            }
            val password = stored.wrapsBy(E2ee.BY_PASSWORD)
            val kept = (password.filterKeys { it == keepPassword } + password).entries
                .take(StoredKeys.MAX_WRAPS - 1).associate { it.toPair() }
            stored.with(kept + (E2ee.newWrapId() to recoveryWrap))
        }
        return E2ee.encodeRecoveryKey(recoveryBytes)
    }

    // The same keys as decided from: the same version and the same wraps. Comparing the
    // wraps too catches a rewrap on another device, which leaves the version as it was.
    private fun sameKeys(stored: StoredKeys?, decidedFrom: StoredKeys?): Boolean =
        stored?.keyVersion == decidedFrom?.keyVersion && stored?.wraps == decidedFrom?.wraps

    /** Allowed without reauthenticating straight after a sign-in, which is the only place it is called. */
    private suspend fun updatePassword(firebasePassword: String) {
        val user = auth.currentUser ?: throw IllegalStateException("not signed in")
        user.updatePassword(firebasePassword).await()
    }

    /**
     * Stores the account key, with the [recoveryKey] about to be shown if one was made, which
     * stays until "I saved it" (AccountKeyStore says why).
     *
     * With a recovery key, a failed save is logged and the step goes on: the account's
     * recovery wrap is written by now, and this is the only time the key exists in a form
     * the user can save, so it is shown from memory anyway. After "I saved it" the sign-in
     * screen finds no key here and asks for the password, which opens the wraps just
     * written. Without one, the failure is the step's, and the user tries again.
     */
    private suspend fun keep(uid: String, accountKey: ByteArray, keyVersion: Long, recoveryKey: String? = null) =
        withContext(Dispatchers.IO) {
            try {
                AccountKeyStore.save(appContext, uid, accountKey, keyVersion, recoveryKey)
            } catch (e: Exception) {
                if (recoveryKey == null) throw e
                Log.w(TAG, "The account key could not be stored; its recovery key is shown anyway", e)
            }
            AccountKeyStore.deviceId(appContext)
        }

    private suspend fun derive(email: String, password: String): E2ee.Keys =
        withContext(Dispatchers.Default) { E2ee.deriveKeys(email, password) }

    private fun currentUid(): String = auth.currentUser?.uid ?: throw IllegalStateException("not signed in")

    private companion object {
        const val TAG = "AccountKeys"
    }
}
