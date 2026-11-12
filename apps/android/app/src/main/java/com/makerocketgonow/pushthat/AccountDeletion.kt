package com.makerocketgonow.pushthat

import android.content.Context
import android.util.Log
import com.google.firebase.Firebase
import com.google.firebase.FirebaseException
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.auth
import com.google.firebase.messaging.FirebaseMessaging
import com.makerocketgonow.pushthat.data.AppDatabase
import com.makerocketgonow.pushthat.e2ee.AccountKeys
import com.makerocketgonow.pushthat.e2ee.signOut
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * "Delete account" from the list's menu (docs/account-deletion.md at the repository root):
 * the password is proved with a fresh sign-in, the `deleteAccount` function deletes the
 * account and everything stored under it, and then this install forgets what it held.
 *
 * The function is called over plain HTTPS as a Firebase callable, as `Plan` calls
 * `getPlan`, so no further SDK is needed.
 */
object AccountDeletion {
    private const val DELETE_ACCOUNT_URL = "https://us-central1-push-that.cloudfunctions.net/deleteAccount"

    /**
     * The function said no before deleting anything, in [message]: a sentence it wrote for
     * the person (a subscription that could not be cancelled, say).
     */
    class RefusedException(message: String) : Exception(message)

    /**
     * The call ended with no answer from the function (a timeout, a dropped connection, a
     * crash on the server) and the account still exists. Nothing can be said about how far
     * the deletion got: once the function is past Stripe it has left a marker, and the
     * server finishes what it started within about two hours whether or not anyone asks
     * again. So the message for this never says that nothing was deleted.
     */
    class OutcomeUnknownException(cause: Exception) : Exception(cause)

    // A little more than the five minutes the function allows itself (`timeoutSeconds` in
    // functions/src/account-deletion.ts), so the function always answers first. It deletes
    // an account's pushes five hundred at a time before it answers and sends nothing
    // meanwhile; at two minutes this gave up on a large account that the server then went
    // on to delete, and told its owner nothing had been removed.
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(310, TimeUnit.SECONDS)
        .build()

    /** The statuses the function refuses with before it has deleted anything. */
    private val REFUSALS = setOf("FAILED_PRECONDITION", "UNAVAILABLE", "UNAUTHENTICATED")

    /**
     * Deletes the signed-in account. Throws what the sign-in throws for a wrong password
     * (`FirebaseAuthInvalidCredentialsException`) or no network, [RefusedException] when
     * the function refuses, and [OutcomeUnknownException] when the call ended with no
     * answer; in each case nothing on this install has changed and the session is as it
     * was.
     *
     * An account found to be gone already counts as deleted, whichever step finds it: an
     * earlier try whose answer was lost has finished on the server, and what is left to do
     * is here.
     */
    suspend fun delete(context: Context, password: String) {
        val app = context.applicationContext
        val user = Firebase.auth.currentUser ?: throw IllegalStateException("not signed in")
        val uid = user.uid
        // The function refuses a sign-in older than five minutes, so the token is one made
        // by this proof of the password, not the one the session has been using.
        val token = try {
            AccountKeys(app).freshTokenFor(password)
        } catch (e: FirebaseAuthInvalidUserException) {
            // Only "no such user" is an account already deleted. The same exception is
            // thrown for a session revoked by a password change and for a disabled
            // account, and neither of those has deleted anything.
            if (e.errorCode != USER_NOT_FOUND) throw e
            forget(app, uid)
            return
        } catch (e: FirebaseAuthInvalidCredentialsException) {
            // With email enumeration protection on, which this project's sign-in assumes
            // (AccountKeys), Firebase says "wrong password" for an account that no longer
            // exists, never "no such user". So a refused password is checked against the
            // account itself, which `reload` answers truthfully whatever that setting is.
            if (!isGone(user, revokedMeansGone = false)) throw e
            forget(app, uid)
            return
        }
        // From here on, not cancelled with the screen. The call can take five minutes, and
        // someone who swipes the app away meanwhile ends the view model's scope: the
        // request still finished on its thread and the server still deleted the account,
        // but the cancellation was rethrown on the way back and `forget` never ran, leaving
        // an install signed in to nothing with the deleted account's queue and token.
        withContext(NonCancellable) { deleteAndForget(app, user, token) }
    }

    private suspend fun deleteAndForget(app: Context, user: FirebaseUser, token: String) {
        val uid = user.uid
        try {
            callDeleteAccount(token)
        } catch (e: IOException) {
            // The Auth user is the last thing the function deletes, so gone means done. The
            // session was re-authenticated a moment ago, so only the function can have
            // revoked it since, and it does that after leaving the marker that gets the
            // deletion finished.
            if (!isGone(user, revokedMeansGone = true)) throw OutcomeUnknownException(e)
        }
        forget(app, uid)
    }

    /**
     * Whether the account no longer exists, asked of Firebase. [revokedMeansGone] says
     * whether a revoked session counts: it does straight after this deletion's own sign-in,
     * and it must not for a session of unknown age, which a password change or reset on
     * another device also revokes. Read as "gone" there, a mistyped password signed the
     * app out and said the account was deleted when the server had not been asked.
     */
    private suspend fun isGone(user: FirebaseUser, revokedMeansGone: Boolean): Boolean = try {
        user.reload().await()
        false
    } catch (e: FirebaseAuthInvalidUserException) {
        e.errorCode == USER_NOT_FOUND || (revokedMeansGone && e.errorCode == USER_TOKEN_EXPIRED)
    } catch (e: FirebaseException) {
        // Could not ask (no network): not known to be gone.
        false
    }

    // Firebase Auth's own codes for `FirebaseAuthInvalidUserException`.
    private const val USER_NOT_FOUND = "ERROR_USER_NOT_FOUND"
    private const val USER_TOKEN_EXPIRED = "ERROR_USER_TOKEN_EXPIRED"

    private suspend fun callDeleteAccount(token: String) = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(DELETE_ACCOUNT_URL)
            .header("Authorization", "Bearer $token")
            .post("{\"data\":{}}".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            val body = runCatching { JSONObject(response.body.string()) }.getOrNull()
            if (response.isSuccessful && body?.optJSONObject("result")?.optBoolean("deleted") == true) return@use
            // A callable's refusal is `{"error": {"status", "message"}}`, and the function
            // makes its own before it deletes anything, each with a sentence for the
            // person. Any other failure (INTERNAL, a gateway's error page) says nothing
            // about how far the deletion got, and is treated like an answer that never came.
            val error = body?.optJSONObject("error")
            val message = error?.optString("message")?.takeIf { it.isNotBlank() }
            if (error == null || message == null || error.optString("status") !in REFUSALS) {
                throw IOException("deleteAccount answered ${response.code}")
            }
            throw RefusedException(message)
        }
    }

    /**
     * What this install held for the account, beyond what any sign-out drops. Each step is
     * tried on its own: the account is already gone, so one that fails must not keep the
     * rest, or the sign-out, from happening.
     *
     * - The pushes queued for a retry. Sign-out keeps them, for an account that will sign
     *   in again; this one never will.
     * - The notification token, so Firebase stops addressing this install as that account's
     *   device. The copy in the user document went with the document.
     * - The Analytics data and the installation's Analytics id, so what this install
     *   reports from here on is not joined to what it reported for the deleted account.
     *
     * Then the sign-out every button uses, which drops the account key, the last decrypted
     * file and the session. The server has deleted the user, so there is nothing to ask of
     * Firebase but to forget it here.
     */
    private suspend fun forget(app: Context, uid: String) {
        withContext(Dispatchers.IO) {
            attempt("queued pushes") { AppDatabase.getDatabase(app).pendingPushDao().deleteAllFor(uid) }
            // Bounded: this asks Firebase over the network, behind a dialog that cannot be
            // dismissed, for an account that is already gone. The token is a courtesy to
            // clear; the copy that addressed this device went with the user document.
            attempt("notification token") {
                withTimeoutOrNull(5_000) { FirebaseMessaging.getInstance().deleteToken().await() }
            }
        }
        attempt("analytics") { FirebaseAnalytics.getInstance(app).resetAnalyticsData() }
        signOut(app)
    }

    private inline fun attempt(what: String, step: () -> Unit) {
        try {
            step()
        } catch (e: Exception) {
            Log.w(TAG, "Could not clear the $what after deleting the account", e)
        }
    }

    private const val TAG = "AccountDeletion"
}
