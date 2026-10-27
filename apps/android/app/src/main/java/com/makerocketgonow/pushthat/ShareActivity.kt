package com.makerocketgonow.pushthat

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.animation.Animation
import android.view.animation.RotateAnimation
import android.widget.ImageView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.auth
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.firestore
import com.google.firebase.Firebase
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.storage
import com.makerocketgonow.pushthat.data.AppDatabase
import com.makerocketgonow.pushthat.data.PendingPush
import com.makerocketgonow.pushthat.e2ee.AccountKeyStore
import com.makerocketgonow.pushthat.e2ee.E2ee
import com.makerocketgonow.pushthat.e2ee.FileCipher
import com.makerocketgonow.pushthat.e2ee.PreparedPush
import com.makerocketgonow.pushthat.e2ee.PushContent
import com.makerocketgonow.pushthat.e2ee.PushDocument
import com.makerocketgonow.pushthat.e2ee.PushKeys
import com.makerocketgonow.pushthat.e2ee.PushStore
import com.makerocketgonow.pushthat.e2ee.PushTooLargeException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.tasks.await
import androidx.lifecycle.lifecycleScope
import androidx.work.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.jsoup.Jsoup
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import org.apache.commons.validator.routines.UrlValidator

class ShareActivity : AppCompatActivity() {
    private val TAG = "ShareActivity"
    private lateinit var auth: FirebaseAuth
    private val db = Firebase.firestore
    private val storage = Firebase.storage
    private val pushStore = PushStore()
    private lateinit var appDatabase: AppDatabase
    private val urlValidator = UrlValidator(arrayOf("http", "https"))

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(R.style.Theme_LinkShare_WithActionBar)
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_share)

        // Start the logo spinning animation
        val spinningLogo = findViewById<ImageView>(R.id.spinningLogo)
        val rotateAnimation = RotateAnimation(
            0f, 360f,
            Animation.RELATIVE_TO_SELF, 0.5f,
            Animation.RELATIVE_TO_SELF, 0.5f
        ).apply {
            duration = 1500
            repeatCount = Animation.INFINITE
            interpolator = android.view.animation.LinearInterpolator()
        }
        spinningLogo.startAnimation(rotateAnimation)

        auth = Firebase.auth
        appDatabase = AppDatabase.getDatabase(this)

        // What kind of share, never what was shared: the text, subject and stream of a share
        // are the push itself, and logcat is readable by anything with adb or a bug report.
        Log.d(TAG, "Share: ${intent?.action} ${intent?.type}")

        // Signed in, and holding the account key, as MainActivity asks. A session without
        // the key (an install that updated while signed in) goes to LoginActivity's password
        // prompt rather than pushing: there is nothing to encrypt with, and a plaintext push
        // is what the encryption exists to stop. The share itself is not kept.
        val user = auth.currentUser
        if (user == null || !AccountKeyStore.hasKey(this, user.uid)) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        // The key is opened off the main thread, a Keystore call, as in MainActivity. One the
        // file says is there and that does not open has been cleared by then, and the share
        // goes to the password prompt like a missing key.
        val uid = user.uid
        lifecycleScope.launch {
            val keys = withContext(Dispatchers.IO) { AccountKeyStore.pushKeys(this@ShareActivity, uid) }
            if (keys == null) {
                startActivity(Intent(this@ShareActivity, LoginActivity::class.java))
                finish()
                return@launch
            }
            try {
                // Handle shared content
                if (intent?.action == Intent.ACTION_SEND) {
                    when (intent.type) {
                        "text/plain" -> shareLink(intent, keys)
                        else -> shareFile(intent, keys)
                    }
                } else {
                    Log.w(TAG, "Received intent with action: ${intent?.action} and type: ${intent?.type}")
                    finish()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error in onCreate", e)
                finish()
            }
        }
    }

    private fun getUrl(urlString: String): String {
        return if (!urlString.startsWith("http://") && !urlString.startsWith("https://")) {
            "https://$urlString"
        } else {
            urlString
        }
    }

    private fun isValidUrl(urlString: String): Boolean {
        return try {
            // If URL doesn't start with a protocol, prepend https://
            val urlWithProtocol = getUrl(urlString)

            // Use Apache Commons Validator for strict URL validation
            if (urlValidator.isValid(urlWithProtocol)) {
                return true
            }
            false
        } catch (e: Exception) {
            Log.e(TAG, "Error validating URL", e)
            false
        }
    }

    /**
     * Extracts URLs from text that may contain title, source, and URL.
     * Returns the first valid URL found, or null if none found.
     */
    private fun extractUrlFromText(text: String): String? {
        if (text.isBlank()) return null

        // First, check if the entire text is a valid URL (trimmed)
        val trimmedText = text.trim()
        if (isValidUrl(trimmedText)) {
            return getUrl(trimmedText)
        }

        // Try to find URLs in the text using regex
        // Pattern matches http://, https://, or www. URLs
        val urlPattern = Regex(
            """(https?://[^\s]+|www\.[^\s]+)""",
            RegexOption.IGNORE_CASE
        )

        val matches = urlPattern.findAll(text)
        for (match in matches) {
            val potentialUrl = match.value.trim()
            if (isValidUrl(potentialUrl)) {
                return getUrl(potentialUrl)
            }
        }

        // If no URL found with protocol, try to find lines that look like URLs
        // (e.g., lines starting with common TLDs or containing domain-like patterns)
        val lines = text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }
        for (line in lines) {
            // Check if line looks like a URL (contains dots and slashes, or common TLD patterns)
            if (line.contains(".") && (line.contains("/") || line.matches(Regex("""^[^\s]+\.[^\s]+$""")))) {
                if (isValidUrl(line)) {
                    return getUrl(line)
                }
            }
        }

        return null
    }

    /**
     * Extracts title from text that may contain title, source, and URL.
     * Returns the first non-URL line, or empty string if none found.
     */
    private fun extractTitleFromText(text: String): String {
        if (text.isBlank()) return ""

        val lines = text.split("\n").map { it.trim() }.filter { it.isNotEmpty() }

        for (line in lines) {
            // Skip lines that are URLs
            if (!isValidUrl(line) && !line.startsWith("http://") && !line.startsWith("https://") && !line.startsWith("www.")) {
                // Skip lines that look like source attribution (e.g., "- Source Name")
                if (!line.startsWith("-") || line.length > 20) {
                    return line
                }
            }
        }

        return ""
    }

    private fun shareLink(intent: Intent, keys: PushKeys) {
        lifecycleScope.launch {
            try {
                val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
                if (sharedText == null) {
                    Log.w(TAG, "No shared text received")
                    finish()
                    return@launch
                }

                // Try to extract URL from the shared text (which may contain title, source, and URL)
                val extractedUrl = extractUrlFromText(sharedText)
                if (extractedUrl == null) {
                    Log.w(TAG, "No valid URL found in shared text")
                    Toast.makeText(this@ShareActivity, getString(R.string.no_url_found), Toast.LENGTH_SHORT).show()
                    finish()
                    return@launch
                }

                val validatedUrl = extractedUrl
                val uri = Uri.parse(validatedUrl)

                // Try to get title from intent extras first, then from extracted text, then empty
                val initialTitle = intent.getStringExtra(Intent.EXTRA_TITLE)
                    ?: intent.getStringExtra(Intent.EXTRA_SUBJECT)
                    ?: extractTitleFromText(sharedText)

                // Extract file extension from URL path
                val ext = uri.lastPathSegment?.substringAfterLast('.', "") ?: ""

                // The id first: the envelope's AAD names it, so a ciphertext cannot be moved
                // to another document.
                val pushId = db.collection("pushes").document().id
                val prepared = try {
                    PreparedPush.prepare(keys, pushId, PushContent.Url(validatedUrl, initialTitle, ext))
                } catch (e: PushTooLargeException) {
                    Log.w(TAG, "The link is too long to push")
                    // Said as it is: the generic failure's "try again later" never works here.
                    showErrorDialog(getString(R.string.push_failed_title), getString(R.string.push_failed_link_too_long))
                    return@launch
                }

                pushStore.create(prepared)
                    .addOnSuccessListener {
                        Log.d(TAG, "Link saved with ID: $pushId")
                        onPushSaved(prepared)
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "Error saving link", e)
                        onPushFailed(e, keys, prepared)
                    }
            } catch (e: Exception) {
                Log.e(TAG, "Error in shareLink", e)
                finish()
            }
        }
    }

    /**
     * A push the server did not take. Refused by the rules: final unless it had landed after
     * all, the upload goes and the user is told why (the month's limit, or that the keys
     * changed when this install's key is one a reset replaced). Unreachable: queued,
     * ciphertext and id as they are, for `RetryPushWorker`. Anything else: final, as before.
     */
    private fun onPushFailed(e: Exception, keys: PushKeys, prepared: PreparedPush) {
        if (isPermissionError(e)) {
            lifecycleScope.launch {
                // The SDK resends a write whose acknowledgement was lost, and the resend of a
                // create is an update of the push it made, which the rules refuse. Without
                // this check that push was reported as past the limit and a file push's
                // object deleted under it. A check that fails counts as not landed, as on the
                // web: a refusal is far likelier than a lost acknowledgement.
                val landed = try {
                    pushStore.landed(prepared)
                } catch (checkFailed: Exception) {
                    false
                }
                if (landed) {
                    Log.d(TAG, "The refused push had landed: ${prepared.id}")
                    onPushSaved(prepared)
                    return@launch
                }
                // At 3 files a month on Free this is the common path.
                prepared.objectPath?.let { discardUpload(it) }
                // A stale key is told apart from the limit and named: trying again cannot
                // work, since only signing in again stores the new key. The web says the same.
                val message = if (pushStore.keyIsStale(keys) == true) {
                    R.string.keys_changed_here
                } else {
                    R.string.push_failed_message_limit
                }
                showErrorDialog(getString(R.string.push_failed_title), getString(message))
            }
        } else if (isNetworkError(e)) {
            lifecycleScope.launch(Dispatchers.IO) {
                try {
                    val pendingPush = PendingPush(
                        url = "",
                        userId = prepared.userId,
                        createdAt = System.currentTimeMillis(),
                        type = prepared.type,
                        prepared = prepared.toJson()
                    )
                    appDatabase.pendingPushDao().insert(pendingPush)
                    Log.d(TAG, "Saved failed push to local database")
                } catch (dbException: Exception) {
                    Log.e(TAG, "Error saving to local database", dbException)
                }
            }
            showErrorDialog(
                getString(R.string.push_failed_title),
                getString(R.string.push_failed_message_generic)
            )
        } else {
            // Nothing retries this, so the upload would be orphaned.
            prepared.objectPath?.let { discardUpload(it) }
            showErrorDialog(
                getString(R.string.push_failed_title),
                getString(R.string.push_failed_message_generic)
            )
        }
    }

    /** A push that is in Firestore: a link's title is scraped in the background, and the share is done. */
    private fun onPushSaved(prepared: PreparedPush) {
        if (prepared.type == PushContent.TYPE_URL) TitleScrapingWorker.enqueue(applicationContext, prepared.id)
        finish()
    }

    /**
     * A shared file, encrypted on the phone before it leaves: streamed through `FileCipher`
     * into a temporary file in the cache (never the whole file in memory), uploaded under a
     * random name as `application/octet-stream`, and only then the push that names it, with
     * the file's key, name and type inside the envelope.
     */
    private fun shareFile(intent: Intent, keys: PushKeys) {
        lifecycleScope.launch {
            try {
                val uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                } ?: run {
                    Log.w(TAG, "No file URI received")
                    Toast.makeText(this@ShareActivity, getString(R.string.no_file_received), Toast.LENGTH_SHORT).show()
                    finish()
                    return@launch
                }

                // Get file size
                val fileSize = contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize } ?: run {
                    Log.w(TAG, "Could not determine file size")
                    Toast.makeText(this@ShareActivity, getString(R.string.file_size_error), Toast.LENGTH_SHORT).show()
                    finish()
                    return@launch
                }

                // The tier's file size, which the Storage rules enforce; said here before the upload
                // starts, when the tier can be read. `>=`, as the rule has it. The rule measures
                // the encrypted object, 12 bytes and 16 a MiB larger than the file, and a file
                // just under the limit can be just over it encrypted: refused here, with the
                // limit named, rather than by the upload with a generic error.
                val maxFileBytes = Plan.maxFileBytes()
                if (maxFileBytes != null && E2ee.encryptedFileSize(fileSize) >= maxFileBytes) {
                    Toast.makeText(this@ShareActivity, getString(R.string.file_too_large, Plan.megabytes(maxFileBytes)), Toast.LENGTH_LONG).show()
                    finish()
                    return@launch
                }

                val fileName = getFileName(uri)
                val ext = fileName.substringAfterLast('.', "").lowercase()
                val mime = contentResolver.getType(uri) ?: "application/octet-stream"
                val fk = E2ee.newFileKey()
                val prefix = E2ee.newFilePrefix()
                // A random name: the file's own name is in the envelope, not in Storage.
                val objectPath = "uploads/${keys.uid}/${E2ee.newObjectId()}"

                val plaintextSize = try {
                    uploadEncrypted(uri, fk, prefix, objectPath)
                } catch (e: Exception) {
                    Log.e(TAG, "Error uploading file", e)
                    // A failure after the upload went through leaves the object too.
                    discardUpload(objectPath)
                    Toast.makeText(this@ShareActivity, getString(R.string.file_upload_error), Toast.LENGTH_SHORT).show()
                    finish()
                    return@launch
                }

                val pushId = db.collection("pushes").document().id
                val content = PushContent.File(fileName, mime, plaintextSize, ext, fk, prefix)
                val prepared = try {
                    PreparedPush.prepare(keys, pushId, content, objectPath)
                } catch (e: PushTooLargeException) {
                    discardUpload(objectPath)
                    showErrorDialog(getString(R.string.push_failed_title), getString(R.string.push_failed_file_name_too_long))
                    return@launch
                }

                pushStore.create(prepared)
                    .addOnSuccessListener {
                        Log.d(TAG, "File saved with ID: $pushId")
                        onPushSaved(prepared)
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "Error saving file", e)
                        onPushFailed(e, keys, prepared)
                    }
            } catch (e: Exception) {
                Log.e(TAG, "Error in shareFile", e)
                finish()
            }
        }
    }

    /**
     * Encrypts [uri] into a temporary file and uploads that to [objectPath]; returns the
     * plaintext size, counted as it was read rather than taken from the provider, which may
     * not know it. The temporary file goes whatever happens.
     */
    private suspend fun uploadEncrypted(uri: Uri, fk: ByteArray, prefix: ByteArray, objectPath: String): Long {
        val dir = File(cacheDir, "uploads").apply { mkdirs() }
        val temp = File.createTempFile("push", ".pte", dir)
        try {
            val size = withContext(Dispatchers.IO) {
                val source = contentResolver.openInputStream(uri) ?: throw IOException("the file could not be opened")
                source.use { FileCipher.encryptToFile(fk, prefix, it, temp) }
            }
            val metadata = StorageMetadata.Builder().setContentType("application/octet-stream").build()
            storage.reference.child(objectPath).putFile(Uri.fromFile(temp), metadata).await()
            return size
        } finally {
            temp.delete()
        }
    }

    private fun getFileName(uri: Uri): String {
        // Try to get the file name from the content provider
        contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val displayNameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                if (displayNameIndex != -1) {
                    return cursor.getString(displayNameIndex)
                }
            }
        }

        // Fallback to the last path segment
        uri.lastPathSegment?.let { return it }

        // If all else fails, generate a timestamp-based name
        return "file_${System.currentTimeMillis()}"
    }

    /**
     * Removes an upload no push document names. The file goes to Storage before the push is
     * made, and only the push is checked against the month's limit; with no document, neither the
     * delete trigger nor the expiry sweep would ever remove the object. A delete of an object that
     * is already gone fails harmlessly.
     */
    private fun discardUpload(storageRef: String) {
        storage.reference.child(storageRef).delete()
            .addOnFailureListener { Log.w(TAG, "Could not remove the orphaned upload $storageRef", it) }
    }

    /**
     * Checks if the exception is a Firestore permission error (e.g., license limit reached)
     */
    private fun isPermissionError(exception: Exception): Boolean {
        return exception is FirebaseFirestoreException &&
                exception.code == FirebaseFirestoreException.Code.PERMISSION_DENIED
    }

    /**
     * Checks if the exception is a network-related error that might be retryable
     */
    private fun isNetworkError(exception: Exception): Boolean {
        return exception is FirebaseFirestoreException &&
                (exception.code == FirebaseFirestoreException.Code.UNAVAILABLE ||
                 exception.code == FirebaseFirestoreException.Code.DEADLINE_EXCEEDED ||
                 exception.code == FirebaseFirestoreException.Code.ABORTED)
    }

    /**
     * Shows an error dialog that requires user acknowledgment before closing the activity
     */
    private fun showErrorDialog(title: String, message: String) {
        androidx.appcompat.app.AlertDialog.Builder(this, R.style.DeleteDialogStyle)
            .setTitle(title)
            .setMessage(message)
            .setCancelable(false)
            .setPositiveButton(R.string.ok) { _, _ ->
                finish()
            }
            .show()
    }
}

/**
 * Fills in a URL push's title from the page, once the device has a network. Runs for this
 * device's own pushes (the share sheet's title, if any, is replaced by the page's) and for
 * a received push whose title is empty, since a web push now goes out without one: the web
 * app can no longer ask a server for it without the server learning the URL.
 *
 * Given only the push's id, so neither the URL nor the title waits in WorkManager's
 * database: it reads the document from the server and decrypts it. On an encrypted push
 * the update is exactly `enc` and `searchTokens` (`isEncryptedRetitle`): the URL and its
 * extension again with the new title under a fresh nonce, and the blind index of the new
 * title and the URL. Only under the push's own key version, and only when that is the one
 * this install holds; another device scraping the same push writes the same title, and
 * the last write wins. A plaintext push (a job queued before this version) gets its title
 * alone, as before; the migration encrypts it.
 */
class TitleScrapingWorker(
    context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {
    private val TAG = "TitleScrapingWorker"
    private val db = Firebase.firestore

    override suspend fun doWork(): Result {
        val documentId = inputData.getString(KEY_DOCUMENT_ID) ?: run {
            Log.e(TAG, "Missing documentId")
            return Result.failure()
        }
        val uid = Firebase.auth.currentUser?.uid ?: return Result.failure()
        val keys = AccountKeyStore.pushKeys(applicationContext, uid) ?: return Result.failure()

        return try {
            val ref = db.collection("pushes").document(documentId)
            val snapshot = ref.get(Source.SERVER).await()
            val data = snapshot.data ?: return Result.success()
            val updates: Map<String, Any> = when (val push = PushDocument.read(keys, documentId, data)) {
                is PushDocument.Read.Opened -> {
                    val content = push.content as? PushContent.Url ?: return Result.success()
                    val title = scrapeTitle(content.url)
                    if (title.isNullOrBlank() || title == content.title) return Result.success()
                    val prepared = PreparedPush.prepare(keys, documentId, content.copy(title = title))
                    mapOf("enc" to prepared.enc.toMap(), "searchTokens" to prepared.searchTokens)
                }
                is PushDocument.Read.Plain -> {
                    if (push.type != PushContent.TYPE_URL) return Result.success()
                    val title = scrapeTitle(push.url)
                    if (title.isNullOrBlank() || title == push.title) return Result.success()
                    mapOf("title" to title.take(PreparedPush.MAX_TITLE_LENGTH))
                }
                PushDocument.Read.Locked, null -> return Result.success()
            }
            ref.update(updates).await()
            Result.success()
        } catch (e: FirebaseFirestoreException) {
            Log.e(TAG, "Error saving scraped title", e)
            // A refusal is final: the push is gone or is no longer this account's to change.
            if (e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) Result.failure() else Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "Error saving scraped title", e)
            Result.retry()
        }
    }

    private suspend fun scrapeTitle(url: String): String? {
        return withContext(Dispatchers.IO) {
            try {
                val client = OkHttpClient()
                val request = Request.Builder()
                    .url(url)
                    .header("User-Agent", "Mozilla/5.0")
                    .build()

                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        Log.e(TAG, "HTTP request failed: ${response.code}")
                        return@withContext null
                    }

                    val html = response.body?.string()
                    if (html == null) {
                        Log.e(TAG, "Empty response")
                        return@withContext null
                    }

                    val doc = Jsoup.parse(html)
                    doc.title().takeIf { it.isNotBlank() }
                }
            } catch (e: IOException) {
                // The exception's type only: its message can name the page's host.
                Log.e(TAG, "Error scraping title: ${e.javaClass.simpleName}")
                null
            } catch (e: IllegalArgumentException) {
                // OkHttp refuses a URL it cannot parse; there is no title to find.
                null
            }
        }
    }

    companion object {
        private const val KEY_DOCUMENT_ID = "documentId"

        fun enqueue(context: Context, documentId: String) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val titleScrapingWork = OneTimeWorkRequestBuilder<TitleScrapingWorker>()
                .setInputData(workDataOf(KEY_DOCUMENT_ID to documentId))
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
                .build()

            WorkManager.getInstance(context).enqueue(titleScrapingWork)
        }
    }
}
