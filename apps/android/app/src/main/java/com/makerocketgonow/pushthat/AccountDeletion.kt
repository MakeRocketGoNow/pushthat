package com.makerocketgonow.pushthat

import android.content.Context
import android.util.Log
import com.bumptech.glide.Glide
import com.google.firebase.Firebase
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.auth.auth
import com.google.firebase.messaging.FirebaseMessaging
import com.makerocketgonow.pushthat.data.AppDatabase
import com.makerocketgonow.pushthat.e2ee.AccountKeys
import com.makerocketgonow.pushthat.e2ee.signOut
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
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
     * The function said no, in [message]: a sentence it wrote for the person (a
     * subscription that could not be cancelled, say), or null when it gave none.
     */
    class RefusedException(message: String?) : Exception(message)

    // A long read: the function deletes an account's pushes five hundred at a time before
    // it answers, and an answer lost to a timeout would leave this install signed in to an
    // account that is already gone.
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    /**
     * Deletes the signed-in account. Throws what the sign-in throws for a wrong password
     * (`FirebaseAuthInvalidCredentialsException`), [RefusedException] when the function
     * refuses, and `IOException` when it could not be reached; in each case nothing on
     * this install has changed and the session is as it was.
     */
    suspend fun delete(context: Context, password: String) {
        val app = context.applicationContext
        val uid = Firebase.auth.currentUser?.uid ?: throw IllegalStateException("not signed in")
        // The function refuses a sign-in older than five minutes, so the token is one made
        // by this proof of the password, not the one the session has been using.
        val token = AccountKeys(app).freshTokenFor(password)
        callDeleteAccount(token)
        forget(app, uid)
    }

    private suspend fun callDeleteAccount(token: String) = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(DELETE_ACCOUNT_URL)
            .header("Authorization", "Bearer $token")
            .post("{\"data\":{}}".toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(request).execute().use { response ->
            val body = runCatching { JSONObject(response.body.string()) }.getOrNull()
            if (response.isSuccessful && body?.optJSONObject("result")?.optBoolean("deleted") == true) return@use
            // A callable's refusal is `{"error": {"status", "message"}}`. A bare status
            // repeated as the message ("INTERNAL") is not a sentence for anyone.
            val error = body?.optJSONObject("error")
            val message = error?.optString("message")?.takeIf { it.isNotBlank() && it != error.optString("status") }
            if (error == null && !response.isSuccessful) throw IOException("deleteAccount answered ${response.code}")
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
     * - The icons cached for the account's links, which name the sites it pushed.
     *
     * Then the sign-out every button uses, which drops the account key, the last decrypted
     * file and the session. The server has deleted the user, so there is nothing to ask of
     * Firebase but to forget it here.
     */
    private suspend fun forget(app: Context, uid: String) {
        withContext(Dispatchers.IO) {
            attempt("queued pushes") { AppDatabase.getDatabase(app).pendingPushDao().deleteAllFor(uid) }
            attempt("notification token") { FirebaseMessaging.getInstance().deleteToken().await() }
            attempt("icon cache") { Glide.get(app).clearDiskCache() }
        }
        attempt("analytics") { FirebaseAnalytics.getInstance(app).resetAnalyticsData() }
        attempt("icon memory") { Glide.get(app).clearMemory() }
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
