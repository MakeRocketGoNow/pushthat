package com.makerocketgonow.pushthat

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.makerocketgonow.pushthat.e2ee.E2ee
import okhttp3.HttpUrl
import org.jsoup.nodes.Document
import java.io.ByteArrayOutputStream
import java.io.InputStream
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Finding and shrinking a page's icon, for the envelope's `icon` (docs/e2ee.md, Icons).
 * `TitleScrapingWorker` does the fetching; what is here is the choice of candidates and the
 * sizes, kept out of the worker so the JVM tests cover them, and the bitmap work, which
 * they cannot run.
 *
 * The icon travels in the envelope so that nothing is fetched to draw a row. The list used
 * to ask Google's favicon service for every link's host each time it was drawn, which told
 * Google, in plaintext, the host of every push the envelope keeps from it.
 */
object PageIcons {
    /** The longest side of an icon in the envelope, in pixels. */
    const val MAX_SIDE = 64

    /** Tried once when the icon at [MAX_SIDE] encodes past [MAX_ICON_BYTES]. */
    const val FALLBACK_SIDE = 32

    /** The most PNG bytes an icon may have (5464 characters of base64). */
    const val MAX_ICON_BYTES = 4096

    /** How much of each candidate is read: an icon larger than this is skipped. */
    const val MAX_FETCH_BYTES = 256L * 1024

    /**
     * How many of the page's `<link>` candidates are tried. The spec says every one; a page
     * listing hundreds of broken links would otherwise hold the worker for as many requests.
     * Sites list several sizes of the same icon, all of which decode, so the first few
     * almost always settle it, and `/favicon.ico` is tried after these whatever the page has.
     */
    const val MAX_LINK_CANDIDATES = 8

    /** The longest side an image attached to a shared link may have and be taken for its icon. */
    const val MAX_SHARED_SIDE = 256

    private val APPLE_TOUCH_ICON = setOf("apple-touch-icon", "apple-touch-icon-precomposed")

    /**
     * Where to look for [doc]'s icon, in the order to try: every `<link>` whose `rel` names
     * `apple-touch-icon` or `apple-touch-icon-precomposed`, then every one naming `icon`
     * (`shortcut icon` included) that is not SVG by its `type` or its path, then
     * `/favicon.ico` at the page's origin. Each `href` is resolved against [pageUrl], the
     * page's final URL after redirects: not against the address the push names, which a
     * redirect may have left, nor a `<base>` element, which the spec does not follow. Only
     * http and https come back (`HttpUrl` cannot hold anything else), each once.
     *
     * SVG is left out because `BitmapFactory` cannot open it, so fetching one only costs a
     * request. The spec filters the `icon` group only: an apple-touch-icon is a PNG by
     * Apple's definition, and one that is not simply fails to decode.
     */
    fun candidates(doc: Document, pageUrl: HttpUrl): List<HttpUrl> {
        // An empty href resolves to the page itself, which is HTML, not an icon.
        val links = doc.select("link[rel][href]").filter { it.attr("href").isNotBlank() }.map { link ->
            val rel = link.attr("rel").lowercase().split(Regex("\\s+")).toSet()
            Triple(rel, link.attr("type").trim().lowercase(), pageUrl.resolve(link.attr("href").trim()))
        }
        val touch = links.filter { (rel, _, _) -> rel.any { it in APPLE_TOUCH_ICON } }.mapNotNull { it.third }
        val icons = links
            .filter { (rel, type, url) -> "icon" in rel && type != "image/svg+xml" && url != null && !isSvgPath(url) }
            .mapNotNull { it.third }
        val fromLinks = (touch + icons).distinct().take(MAX_LINK_CANDIDATES)
        return (fromLinks + listOfNotNull(pageUrl.resolve("/favicon.ico"))).distinct()
    }

    private fun isSvgPath(url: HttpUrl) = url.encodedPath.lowercase().endsWith(".svg")

    /**
     * [width] by [height] scaled down to fit [side] by [side] with its aspect kept, never
     * up, and never below one pixel a side (a 1000 by 1 strip would round to nothing).
     */
    fun fit(width: Int, height: Int, side: Int): Pair<Int, Int> {
        val longest = max(width, height)
        if (longest <= side) return width to height
        val scale = side.toDouble() / longest
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    /**
     * The `inSampleSize` that decodes [width] by [height] as small as it can while its
     * longest side stays at least [side]. A 256 KiB PNG of one color can be tens of
     * thousands of pixels a side, which decoded whole would be gigabytes; sampled, it is
     * never more than four times the icon's area, and the scale after it does the rest.
     */
    fun sampleSize(width: Int, height: Int, side: Int): Int {
        val longest = max(width, height)
        var sample = 1
        while (longest / (sample * 2) >= side) sample *= 2
        return sample
    }

    /**
     * Whether an image a share attaches is shaped like a site's icon: square, and no more
     * than [MAX_SHARED_SIDE] a side. Chrome attaches the page's favicon to a link it shares,
     * for the share sheet's preview, which is how a push gets the icon of a page that turns
     * the scraper away (a shop's product page answering it with 429). Other apps attach a
     * preview too, and theirs is often a picture of the content (a video's thumbnail, a
     * product photo), which is not the site's icon and would be drawn as one. A favicon is
     * square; those mostly are not, and the few that are tend to be far larger.
     */
    fun isIconShaped(width: Int, height: Int): Boolean = width == height && width in 1..MAX_SHARED_SIDE

    /**
     * [input] read whole, or null when it holds more than [MAX_FETCH_BYTES]: the same cap as
     * a fetched candidate, since the stream is another app's and can be any length.
     */
    fun readCapped(input: InputStream): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return out.toByteArray()
            if (out.size() + read > MAX_FETCH_BYTES) return null
            out.write(buffer, 0, read)
        }
    }

    /**
     * [bytes], an image a share attached, decoded when [isIconShaped] says it is an icon,
     * checked on its header before anything is decoded. Null otherwise, or when the decoder
     * cannot open it.
     */
    fun decodeShared(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (!isIconShaped(bounds.outWidth, bounds.outHeight)) return null
        return decode(bytes)
    }

    /** [bytes] as an image, or null when the platform's decoder cannot open them. */
    fun decode(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, MAX_SIDE)
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    /**
     * An envelope's `icon` for a row, or null when it is not what the spec says one is: a
     * PNG of at most [MAX_SIDE] a side and [MAX_ICON_BYTES], checked before decoding. Every
     * client draws exactly that and nothing else (docs/e2ee.md, Icons), so an icon some
     * other writer got wrong is passed over the same way everywhere rather than drawing on
     * one platform and not another, and a PNG claiming to be huge is never decoded.
     */
    fun decodeForDisplay(bytes: ByteArray): Bitmap? {
        if (bytes.size > MAX_ICON_BYTES) return null
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outMimeType != "image/png") return null
        if (bounds.outWidth !in 1..MAX_SIDE || bounds.outHeight !in 1..MAX_SIDE) return null
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }

    /**
     * [bitmap] as the envelope's `icon`: fit to [MAX_SIDE], PNG, base64; at [FALLBACK_SIDE]
     * when that is over [MAX_ICON_BYTES]; null when that is too. Null is no icon, not a
     * reason to try the next candidate: the decoder opened this one, and the spec takes the
     * first it opens.
     */
    fun encode(bitmap: Bitmap): String? {
        for (side in listOf(MAX_SIDE, FALLBACK_SIDE)) {
            val png = png(bitmap, side)
            if (png.size <= MAX_ICON_BYTES) return E2ee.base64(png)
        }
        return null
    }

    private fun png(bitmap: Bitmap, side: Int): ByteArray {
        val (width, height) = fit(bitmap.width, bitmap.height, side)
        val scaled = if (width == bitmap.width && height == bitmap.height) {
            bitmap
        } else {
            Bitmap.createScaledBitmap(bitmap, width, height, true)
        }
        try {
            return ByteArrayOutputStream().also { scaled.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        } finally {
            if (scaled !== bitmap) scaled.recycle()
        }
    }
}
