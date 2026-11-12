package com.makerocketgonow.pushthat

import android.net.Uri
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import okhttp3.OkHttpClient
import okhttp3.Request
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import java.io.ByteArrayInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Where a pushed link's icon is: found by asking the linked site itself, from this phone.
 *
 * The list used to load `google.com/s2/favicons?domain=<host>` for every row, which told
 * Google the domain of every link pushed, for pushes that are end-to-end encrypted so that
 * nobody but their owner knows what they are. Asking through a server of our own would
 * only move that list into our logs. The one party that may learn a link was pushed is the
 * site the link already points at, so that is who is asked: the site's front page is read
 * for `<link rel="icon">` (and `apple-touch-icon`, which is usually the sharper one), and
 * when it names none the icon is `/favicon.ico`, where browsers look. A site with neither
 * gets the app's placeholder (`SwivelCheckView`).
 *
 * Per site, not per link, and kept in memory only. Written to disk, the answers would be a
 * plaintext list of the sites an account pushes, on a phone whose pushes are otherwise held
 * as ciphertext; in memory they go with the process, and [clear] drops them at sign-out.
 * The cost is one small request per site per start of the app.
 *
 * That is true of this map and not of the images: Glide keeps what it downloads in its
 * disk cache, as it did the icons from Google, under names hashed from their addresses.
 * No site can be read off those names, but an image can be recognised. Deleting the
 * account clears that cache (`AccountDeletion`); an ordinary sign-out leaves it, as it
 * always has.
 */
object Favicons {
    /** As much of a front page as is read: the `<head>` is at the top (the title scraper reads the same). */
    private const val MAX_PAGE_BYTES = 256L * 1024

    /** What an `apple-touch-icon` with no `sizes` is taken to be: the size Apple asks for. */
    private const val APPLE_TOUCH_DEFAULT = 180

    private const val TAG = "Favicons"

    // No cookie jar and no cache: the site is told nothing but that its front page was read.
    // Short timeouts, since a row's icon is not worth waiting on a slow site for.
    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .callTimeout(8, TimeUnit.SECONDS)
        .build()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * What a lookup found: the addresses to try, and whether the site answered. A lookup
     * the site did not answer (no network, a timeout) is not kept, see [candidates].
     */
    private class Found(val candidates: List<String>, val answered: Boolean)

    /** One lookup per site, shared by every row that links to it, running or done. */
    private val lookups = ConcurrentHashMap<String, Deferred<Found>>()

    /** `scheme://host[:port]` for a web address, or null for anything else (a `mailto:`, a typo). */
    fun originOf(url: String?): String? {
        val uri = url?.let { runCatching { Uri.parse(it) }.getOrNull() } ?: return null
        val scheme = uri.scheme?.lowercase()
        val host = uri.host
        if ((scheme != "https" && scheme != "http") || host.isNullOrEmpty()) return null
        return if (uri.port == -1) "$scheme://$host" else "$scheme://$host:${uri.port}"
    }

    /** The icons already found for [origin], if its lookup has finished: lets a row draw without a flash. */
    @OptIn(ExperimentalCoroutinesApi::class) // getCompleted, on a lookup already checked to be complete
    fun known(origin: String): List<String>? =
        lookups[origin]?.takeIf { it.isCompleted && !it.isCancelled }
            ?.let { runCatching { it.getCompleted() }.getOrNull() }?.candidates

    /**
     * The addresses to try for [origin]'s icon, best first: what its front page names, then
     * `/favicon.ico`. Never empty and never throws: a site that cannot be read still has
     * `/favicon.ico` to try.
     *
     * A lookup that failed to reach the site is answered with `/favicon.ico` this once and
     * then forgotten, so the next row to show the site asks again. Kept, it would have
     * pinned a site whose icon is only named in its page to the fallback, or the
     * placeholder, until the process died, for no more reason than the list having been
     * opened in a lift.
     */
    suspend fun candidates(origin: String): List<String> {
        val lookup = lookups.getOrPut(origin) { scope.async { lookUp(origin) } }
        val found = lookup.await()
        if (!found.answered) lookups.remove(origin, lookup)
        return found.candidates
    }

    /** Forgets every site looked up. At sign-out (`forgetSession`): the next account's list is its own. */
    fun clear() = lookups.clear()

    private fun lookUp(origin: String): Found {
        val fallback = "$origin/favicon.ico"
        var answered = true
        val named = try {
            val request = Request.Builder().url("$origin/").header("User-Agent", "Mozilla/5.0").build()
            http.newCall(request).execute().use { response ->
                val body = response.body
                val type = body.contentType()
                if (!response.isSuccessful || type == null || !type.subtype.lowercase().contains("html")) {
                    emptyList()
                } else {
                    val source = body.source()
                    source.request(MAX_PAGE_BYTES)
                    val bytes = source.buffer.readByteArray(minOf(source.buffer.size, MAX_PAGE_BYTES))
                    // Resolved against where the request ended up, after any redirect.
                    iconsIn(Jsoup.parse(ByteArrayInputStream(bytes), type.charset()?.name(), response.request.url.toString()))
                }
            }
        } catch (e: Exception) {
            // The exception's type only: its message can name the site, which is what a
            // pushed link's host is and what the log must not hold.
            Log.d(TAG, "No front page to read an icon from: ${e.javaClass.simpleName}")
            answered = false
            emptyList()
        }
        return Found((named + fallback).distinct(), answered)
    }

    /**
     * The icons a page names, largest first, at most three. Visible for the unit test.
     *
     * SVG and Safari's `mask-icon` are left out, since Glide draws neither, and so is an
     * icon inlined as a `data:` address. A size comes from `sizes` ("32x32", or the largest
     * of several); an `apple-touch-icon` without one is 180, and anything else without one
     * is the smallest, since it is usually the 16 or 32 pixel `.ico`.
     */
    internal fun iconsIn(page: Document): List<String> =
        page.select("link[rel][href]")
            .mapNotNull { link ->
                val rel = link.attr("rel").lowercase().split(Regex("\\s+"))
                val apple = rel.any { it.startsWith("apple-touch-icon") }
                if (!apple && "icon" !in rel) return@mapNotNull null
                val href = link.absUrl("href")
                val web = href.startsWith("https://") || href.startsWith("http://")
                val svg = link.attr("type").contains("svg", ignoreCase = true) ||
                    href.substringBefore('?').substringBefore('#').endsWith(".svg", ignoreCase = true)
                if (!web || svg) return@mapNotNull null
                val declared = Regex("(\\d+)x\\d+", RegexOption.IGNORE_CASE)
                    .findAll(link.attr("sizes")).mapNotNull { it.groupValues[1].toIntOrNull() }.maxOrNull()
                href to (declared ?: if (apple) APPLE_TOUCH_DEFAULT else 0)
            }
            .sortedByDescending { it.second }
            .map { it.first }
            .distinct()
            .take(3)
}
