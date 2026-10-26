package com.makerocketgonow.pushthat

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import com.google.firebase.Firebase
import com.google.firebase.storage.storage
import com.makerocketgonow.pushthat.e2ee.FileCipher
import kotlinx.coroutines.tasks.await
import java.io.File
import java.util.UUID

/**
 * Opening a file push. The object is downloaded through the Storage SDK by `objectPath`,
 * with the user's own auth: no download URL is stored for an encrypted push, and the
 * Storage rules already limit reads to the owner. It lands in the cache, is decrypted into
 * a file named as the envelope names it, and is handed to a viewer through the
 * `FileProvider` declared in the manifest (res/xml/file_paths.xml), which shares only the
 * `opened/` folder.
 */
object PushFiles {
    private const val DOWNLOADS = "downloads"
    private const val OPENED = "opened"

    /**
     * Downloads [objectPath] and returns the file to open: decrypted with [fk] and [np], or,
     * for a migrated push (`legacyPlain`, both null), as it is, since its bytes were
     * uploaded before encryption. Any failure throws and leaves nothing behind, so a file
     * that did not decrypt is never opened short. Not on the main thread.
     *
     * Each open first clears the files opened before it. They are the plaintext of
     * someone's push, sitting in the cache, and the viewer it was handed to has had it by
     * then; keeping only the latest bounds both the space and the exposure.
     */
    suspend fun fetch(context: Context, objectPath: String, name: String, fk: ByteArray?, np: ByteArray?): File {
        val opened = File(context.cacheDir, OPENED)
        opened.deleteRecursively()
        // A folder per open, so the file keeps the envelope's name even when two pushes share it.
        val dir = File(opened, UUID.randomUUID().toString()).apply { mkdirs() }
        val dest = File(dir, safeName(name))
        val ref = Firebase.storage.reference.child(objectPath)
        try {
            if (fk == null || np == null) {
                ref.getFile(dest).await()
            } else {
                val downloads = File(context.cacheDir, DOWNLOADS).apply { mkdirs() }
                val encrypted = File.createTempFile("object", ".pte", downloads)
                try {
                    ref.getFile(encrypted).await()
                    FileCipher.decryptToFile(fk, np, encrypted, dest)
                } finally {
                    encrypted.delete()
                }
            }
            return dest
        } catch (e: Throwable) {
            dir.deleteRecursively()
            throw e
        }
    }

    /** Opens [file] in whatever app views its type, or offers every app when none claims it. */
    fun view(context: Context, file: File, mime: String, ext: String) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        val type = mime.takeIf { it.isNotBlank() && it != "application/octet-stream" }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.lowercase())
            ?: "application/octet-stream"
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            context.startActivity(view)
        } catch (e: ActivityNotFoundException) {
            val any = Intent(Intent.ACTION_VIEW).setDataAndType(uri, "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            context.startActivity(Intent.createChooser(any, null))
        }
    }

    /** On sign-out: nothing of the account's files stays in the cache. */
    fun clear(context: Context) {
        File(context.cacheDir, OPENED).deleteRecursively()
        File(context.cacheDir, DOWNLOADS).deleteRecursively()
    }

    /**
     * The envelope's name as a file name: it came from another device, so a slash or a
     * name of dots must not reach outside the folder, and a name past the file system's
     * 255 bytes is cut before its extension.
     */
    private fun safeName(name: String): String {
        val cleaned = name.replace('/', '_').replace('\u0000', '_').trim()
        if (cleaned.isEmpty() || cleaned.all { it == '.' }) return "file"
        if (cleaned.toByteArray().size <= 120) return cleaned
        val ext = cleaned.substringAfterLast('.', "").take(16)
        val base = cleaned.substringBeforeLast('.').take(60)
        return if (ext.isEmpty()) base else "$base.$ext"
    }
}
