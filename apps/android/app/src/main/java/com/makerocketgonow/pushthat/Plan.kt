package com.makerocketgonow.pushthat

import com.google.firebase.Firebase
import com.google.firebase.auth.auth
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.firestore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The account's plan, Free or Pro (docs/billing.md in pushthat-functions).
 *
 * The app never sells the plan: both stores forbid selling a subscription in an app
 * through anything but their own billing, so it shows where the account stands and
 * says that plans are managed on the account on the web, with no button that leads
 * there. The tier is read the same way the Firestore rules read it, off
 * `users/{uid}.subscription.expiresAt`, and the full report (this month's usage against
 * its limits) comes from the `getPlan` function, called over plain HTTPS as a Firebase
 * callable so no further SDK is needed.
 */
object Plan {
    private const val MB = 1024L * 1024L
    const val FREE_FILE_BYTES = 25L * MB
    const val PRO_FILE_BYTES = 100L * MB

    private const val GET_PLAN_URL = "https://us-central1-push-that.cloudfunctions.net/getPlan"

    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /** Pro while the subscription's expiresAt is ahead of the clock: the rules' own test. */
    fun isPro(userDoc: DocumentSnapshot?): Boolean {
        val expiresAt = userDoc?.getTimestamp("subscription.expiresAt") ?: return false
        return expiresAt.toDate().time > System.currentTimeMillis()
    }

    /**
     * The largest file the signed-in account may push, read from its user document, or
     * null when the document cannot be read (offline with no cached copy, say). The
     * Storage rules are what enforce the size; this check only says so before the
     * upload starts, and must not refuse a Pro user at the Free size because a read
     * failed.
     */
    suspend fun maxFileBytes(): Long? {
        val uid = Firebase.auth.currentUser?.uid ?: return null
        val doc = runCatching { Firebase.firestore.collection("users").document(uid).get().await() }.getOrNull() ?: return null
        return if (isPro(doc)) PRO_FILE_BYTES else FREE_FILE_BYTES
    }

    fun megabytes(bytes: Long): Long = bytes / MB

    data class Report(
        val tier: String,
        val urlUsed: Int,
        val urlLimit: Int,
        val fileUsed: Int,
        val fileLimit: Int,
        val fileBytes: Long,
        val keepDays: Int,
        /** `pro` or `comp`, or null on Free. */
        val subscriptionType: String?,
        val subscriptionStatus: String?,
        /** ISO 8601, or null. */
        val expiresAt: String?,
        val cancelsAt: String?,
    ) {
        val isPro get() = tier == "pro"
    }

    /** `getPlan` for the signed-in account, or null when it cannot be read. */
    suspend fun fetchReport(): Report? = withContext(Dispatchers.IO) {
        val user = Firebase.auth.currentUser ?: return@withContext null
        val token = runCatching { user.getIdToken(false).await().token }.getOrNull() ?: return@withContext null
        val request = Request.Builder()
            .url(GET_PLAN_URL)
            .header("Authorization", "Bearer $token")
            .post("{\"data\":{}}".toRequestBody("application/json".toMediaType()))
            .build()
        runCatching {
            http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val result = JSONObject(response.body.string()).getJSONObject("result")
                val limits = result.getJSONObject("limits")
                val usage = result.getJSONObject("usage")
                val subscription = result.optJSONObject("subscription")
                Report(
                    tier = result.getString("tier"),
                    urlUsed = usage.optInt("url"),
                    urlLimit = limits.getInt("url"),
                    fileUsed = usage.optInt("file"),
                    fileLimit = limits.getInt("file"),
                    fileBytes = limits.getLong("fileBytes"),
                    keepDays = limits.getInt("keepDays"),
                    subscriptionType = subscription?.optString("type")?.takeIf { it.isNotEmpty() },
                    subscriptionStatus = subscription?.optString("status")?.takeIf { it.isNotEmpty() },
                    expiresAt = subscription?.optString("expiresAt")?.takeIf { it.isNotEmpty() && it != "null" },
                    cancelsAt = subscription?.optString("cancelsAt")?.takeIf { it.isNotEmpty() && it != "null" },
                )
            }
        }.getOrNull()
    }
}
