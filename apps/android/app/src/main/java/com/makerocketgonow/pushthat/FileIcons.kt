package com.makerocketgonow.pushthat

import androidx.annotation.DrawableRes

/**
 * The icon a row shows for a file type, shipped inside the app. These were loaded from
 * `https://pushthat.link/files/<ext>.png`, which put the type of every encrypted file a list
 * showed into the site's logs (docs/e2ee.md, Icons). The PNGs are copies of
 * `apps/web/public/files`, with a `file_icon_` prefix so they cannot clash with the app's
 * other drawables (and so a type like `7z` would still make a valid resource name).
 *
 * The one list of the types that have an icon: adding one is a `file_icon_<ext>.png` in
 * `res/drawable-nodpi` (one size, never scaled per density, as the web serves it) and a line
 * here. A map of ids rather than a lookup by name, which would hide the icons from the
 * compiler and from resource shrinking.
 */
object FileIcons {
    private val BY_EXT = mapOf(
        "aac" to R.drawable.file_icon_aac,
        "ai" to R.drawable.file_icon_ai,
        "apk" to R.drawable.file_icon_apk,
        "avi" to R.drawable.file_icon_avi,
        "css" to R.drawable.file_icon_css,
        "csv" to R.drawable.file_icon_csv,
        "doc" to R.drawable.file_icon_doc,
        "flac" to R.drawable.file_icon_flac,
        "gif" to R.drawable.file_icon_gif,
        "html" to R.drawable.file_icon_html,
        "indd" to R.drawable.file_icon_indd,
        "jpeg" to R.drawable.file_icon_jpeg,
        "jpg" to R.drawable.file_icon_jpg,
        "js" to R.drawable.file_icon_js,
        "mov" to R.drawable.file_icon_mov,
        "mp3" to R.drawable.file_icon_mp3,
        "mp4" to R.drawable.file_icon_mp4,
        "pdf" to R.drawable.file_icon_pdf,
        "png" to R.drawable.file_icon_png,
        "pproj" to R.drawable.file_icon_pproj,
        "psd" to R.drawable.file_icon_psd,
        "tiff" to R.drawable.file_icon_tiff,
        "txt" to R.drawable.file_icon_txt,
        "xls" to R.drawable.file_icon_xls,
        "xml" to R.drawable.file_icon_xml,
        "zip" to R.drawable.file_icon_zip,
    )

    /** The icon for files ending in [ext], any case, or null for a type with none. */
    @DrawableRes
    fun forExt(ext: String?): Int? = ext?.lowercase()?.let { BY_EXT[it] }
}
