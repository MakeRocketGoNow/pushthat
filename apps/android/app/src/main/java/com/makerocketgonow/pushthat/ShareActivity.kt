package com.makerocketgonow.pushthat

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.view.animation.Animation
import android.view.animation.RotateAnimation
import android.widget.ImageView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.auth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.firestore
import com.google.firebase.Firebase
import com.google.firebase.storage.storage
import com.makerocketgonow.pushthat.data.AppDatabase
import com.makerocketgonow.pushthat.data.PendingPush
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.tasks.await
import androidx.lifecycle.lifecycleScope
import androidx.work.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.jsoup.Jsoup
import java.io.IOException
import java.util.concurrent.TimeUnit
import org.apache.commons.validator.routines.UrlValidator

class ShareActivity : AppCompatActivity() {
    private val TAG = "ShareActivity"
    private lateinit var auth: FirebaseAuth
    private val db = Firebase.firestore
    private val storage = Firebase.storage
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

        // Log complete intent details
        Log.d(TAG, "Intent details:")
        Log.d(TAG, "Action: ${intent?.action}")
        Log.d(TAG, "Type: ${intent?.type}")
        Log.d(TAG, "Categories: ${intent?.categories}")
        Log.d(TAG, "Data: ${intent?.data}")
        Log.d(TAG, "Package: ${intent?.`package`}")

        intent?.extras?.let { bundle ->
            Log.d(TAG, "Extras:")
            for (key in bundle.keySet()) {
                @Suppress("DEPRECATION")
                Log.d(TAG, "$key: ${bundle.get(key)}")
            }
        }

        // Check if user is signed in
        if (auth.currentUser == null) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }

        try {
            // Handle shared content
            if (intent?.action == Intent.ACTION_SEND) {
                when (intent.type) {
                    "text/plain" -> shareLink(intent)
                    else -> shareFile(intent)
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

    private fun scheduleUrlTitleScraping(documentId: String, url: String, initialTitle: String) {
        val data = workDataOf(
            "documentId" to documentId,
            "url" to url,
            "initialTitle" to initialTitle
        )

        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val titleScrapingWork = OneTimeWorkRequestBuilder<TitleScrapingWorker>()
            .setInputData(data)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(applicationContext)
            .enqueue(titleScrapingWork)
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

    private fun shareLink(intent: Intent) {
        lifecycleScope.launch {
            try {
                val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT)
                Log.d(TAG, "Received shared text: $sharedText")
                if (sharedText == null) {
                    Log.w(TAG, "No shared text received")
                    finish()
                    return@launch
                }

                // Try to extract URL from the shared text (which may contain title, source, and URL)
                val extractedUrl = extractUrlFromText(sharedText)
                if (extractedUrl == null) {
                    Log.w(TAG, "No valid URL found in shared text: $sharedText")
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

                val deviceName = Settings.Global.getString(contentResolver, "device_name")

                // Extract file extension from URL path
                val ext = uri.lastPathSegment?.let { path ->
                    path.substringAfterLast('.', "").takeIf { it.isNotEmpty() }
                }

                val push = hashMapOf(
                    "url" to validatedUrl,
                    "userId" to auth.currentUser?.uid,
                    "createdAt" to FieldValue.serverTimestamp(),
                    "title" to initialTitle,
                    "type" to "url",
                    "deviceName" to (deviceName ?: android.os.Build.MODEL),
                    "searchTokens" to generateSearchTokens("$initialTitle $validatedUrl"),
                    "ext" to ext
                )

                Log.d(TAG, "Saving initial link to Firestore: $push")

                try {
                    db.collection("pushes")
                        .add(push)
                        .addOnSuccessListener { documentReference ->
                            Log.d(TAG, "Link saved with ID: ${documentReference.id}")
                            // Schedule title scraping as a background task
                            scheduleUrlTitleScraping(documentReference.id, uri.toString(), initialTitle)
                            finish()
                        }
                        .addOnFailureListener { e ->
                            Log.e(TAG, "Error saving link", e)

                            // Check if it's a permission error (license limit)
                            if (isPermissionError(e)) {
                                // Show error dialog - don't save to local DB as it will fail again
                                showErrorDialog(
                                    getString(R.string.push_failed_title),
                                    getString(R.string.push_failed_message_limit)
                                )
                            } else if (isNetworkError(e)) {
                                // Network error - save to local DB for retry, but still show dialog
                                lifecycleScope.launch(Dispatchers.IO) {
                                    try {
                                        val pendingPush = PendingPush(
                                            url = uri.toString(),
                                            userId = auth.currentUser?.uid,
                                            createdAt = System.currentTimeMillis(),
                                            title = initialTitle,
                                            type = "url",
                                            deviceName = deviceName ?: android.os.Build.MODEL
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
                                // Other errors - show generic error dialog
                                showErrorDialog(
                                    getString(R.string.push_failed_title),
                                    getString(R.string.push_failed_message_generic)
                                )
                            }
                        }
                } catch (e: Exception) {
                    Log.e(TAG, "Error in Firestore operation", e)
                    finish()
                }

            } catch (e: Exception) {
                Log.e(TAG, "Error in shareLink", e)
                finish()
            }
        }
    }

    private fun generateSearchTokens(text: String): List<String> {
        // Convert to lowercase and split into words
        val words = text
            .lowercase()
            .replace(Regex("[^\\w\\s]"), "") // Remove special characters
            .split(Regex("\\s+")) // Split on whitespace
            .filter { it.isNotEmpty() }

        val tokens = mutableSetOf<String>()

        // Add full words
        tokens.addAll(words)

        // Add partial matches (substrings)
        words.forEach { word ->
            for (i in 1..word.length) {
                tokens.add(word.substring(0, i))
            }
        }

        return tokens.toList()
    }

    private fun generateUniqueFileName(originalName: String, attempt: Int = 0): String {
        if (attempt == 0) return originalName

        val lastDotIndex = originalName.lastIndexOf('.')
        val nameWithoutExt = if (lastDotIndex == -1) originalName else originalName.substring(0, lastDotIndex)
        val extension = if (lastDotIndex == -1) "" else originalName.substring(lastDotIndex)

        // Check if name already ends with a number pattern like " (1)" or " (2)"
        // If so, extract base name and add attempt to existing number
        val pattern = Regex("""^(.+) \((\d+)\)$""")
        val match = pattern.matchEntire(nameWithoutExt)

        return if (match != null) {
            val baseName = match.groupValues[1]
            val existingNum = match.groupValues[2].toInt()
            val newNum = existingNum + attempt
            "$baseName ($newNum)$extension"
        } else {
            "$nameWithoutExt ($attempt)$extension"
        }
    }

    private suspend fun checkFileExists(storageRef: String): Boolean {
        return try {
            storage.reference.child(storageRef).metadata.await()
            true
        } catch (e: Exception) {
            false
        }
    }

    private suspend fun getUniqueStorageRef(userId: String, fileName: String): String {
        var attempt = 0
        var uniqueFileName = fileName
        var storageRef = "uploads/$userId/$uniqueFileName"

        while (checkFileExists(storageRef)) {
            attempt++
            uniqueFileName = generateUniqueFileName(fileName, attempt)
            storageRef = "uploads/$userId/$uniqueFileName"
        }

        return storageRef
    }

    private fun shareFile(intent: Intent) {
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
                val fileSize = contentResolver.openFileDescriptor(uri, "r")?.statSize ?: run {
                    Log.w(TAG, "Could not determine file size")
                    Toast.makeText(this@ShareActivity, getString(R.string.file_size_error), Toast.LENGTH_SHORT).show()
                    finish()
                    return@launch
                }

                // The tier's file size, which the Storage rules enforce; said here before the upload
                // starts, when the tier can be read. `>=`, as the rule has it.
                val maxFileBytes = Plan.maxFileBytes()
                if (maxFileBytes != null && fileSize >= maxFileBytes) {
                    Toast.makeText(this@ShareActivity, getString(R.string.file_too_large, Plan.megabytes(maxFileBytes)), Toast.LENGTH_LONG).show()
                    finish()
                    return@launch
                }

                val fileName = getFileName(uri)
                val deviceName = Settings.Global.getString(contentResolver, "device_name")
                val ext = fileName.substringAfterLast('.', "").takeIf { it.isNotEmpty() }

                // Get unique storage reference
                val storageRef = getUniqueStorageRef(auth.currentUser!!.uid, fileName)
                val finalFileName = storageRef.split('/').last()

                try {
                    // Upload file to Firebase Storage
                    val uploadTask = storage.reference.child(storageRef)
                        .putStream(contentResolver.openInputStream(uri)!!)
                        .await()

                    // Get download URL
                    val downloadUrl = uploadTask.storage.downloadUrl.await().toString()

                    // Create Firestore document
                    val push = hashMapOf(
                        "url" to downloadUrl,
                        "userId" to auth.currentUser?.uid,
                        "createdAt" to FieldValue.serverTimestamp(),
                        "title" to finalFileName,
                        "type" to "file",
                        "deviceName" to (deviceName ?: android.os.Build.MODEL),
                        "searchTokens" to generateSearchTokens("$finalFileName $downloadUrl"),
                        "ext" to ext
                    )

                    Log.d(TAG, "Saving file to Firestore: $push")

                    db.collection("pushes")
                        .add(push)
                        .addOnSuccessListener { documentReference ->
                            Log.d(TAG, "File saved with ID: ${documentReference.id}")
                            finish()
                        }
                        .addOnFailureListener { e ->
                            Log.e(TAG, "Error saving file", e)

                            // Check if it's a permission error (license limit)
                            if (isPermissionError(e)) {
                                // At 3 files a month on Free this is the common path.
                                discardUpload(storageRef)
                                // Show error dialog - don't save to local DB as it will fail again
                                showErrorDialog(
                                    getString(R.string.push_failed_title),
                                    getString(R.string.push_failed_message_limit)
                                )
                            } else if (isNetworkError(e)) {
                                // Network error - save to local DB for retry, but still show dialog
                                lifecycleScope.launch(Dispatchers.IO) {
                                    try {
                                        val pendingPush = PendingPush(
                                            url = downloadUrl,
                                            userId = auth.currentUser?.uid,
                                            createdAt = System.currentTimeMillis(),
                                            title = finalFileName,
                                            type = "file",
                                            deviceName = deviceName ?: android.os.Build.MODEL
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
                                // Other errors: nothing retries this, so the upload would be orphaned.
                                discardUpload(storageRef)
                                // Other errors - show generic error dialog
                                showErrorDialog(
                                    getString(R.string.push_failed_title),
                                    getString(R.string.push_failed_message_generic)
                                )
                            }
                        }
                } catch (e: Exception) {
                    Log.e(TAG, "Error uploading file", e)
                    // A failure after the upload went through (the download URL, say) leaves the object too.
                    discardUpload(storageRef)
                    Toast.makeText(this@ShareActivity, getString(R.string.file_upload_error), Toast.LENGTH_SHORT).show()
                    finish()
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error in shareFile", e)
                finish()
            }
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

class TitleScrapingWorker(
    context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {
    private val TAG = "TitleScrapingWorker"
    private val db = Firebase.firestore

    override suspend fun doWork(): Result {
        Log.d(TAG, "Starting title scraping")

        val documentId = inputData.getString("documentId") ?: run {
            Log.e(TAG, "Missing documentId")
            return Result.failure()
        }
        val url = inputData.getString("url") ?: run {
            Log.e(TAG, "Missing URL")
            return Result.failure()
        }
        val initialTitle = inputData.getString("initialTitle") ?: ""

        return try {
            val scrapedTitle = scrapeTitle(url)
            if (!scrapedTitle.isNullOrBlank() && scrapedTitle != initialTitle) {
                Log.d(TAG, "Found title: $scrapedTitle")
                val updates = hashMapOf<String, Any>(
                    "title" to scrapedTitle,
                    "searchTokens" to generateSearchTokens("$scrapedTitle $url")
                )

                withContext(Dispatchers.IO) {
                    db.collection("pushes")
                        .document(documentId)
                        .update(updates)
                        .await()
                }
                Result.success()
            } else {
                Result.success()
            }
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
                Log.e(TAG, "Error scraping title", e)
                null
            }
        }
    }

    private fun generateSearchTokens(text: String): List<String> {
        val words = text
            .lowercase()
            .replace(Regex("[^\\w\\s]"), "")
            .split(Regex("\\s+"))
            .filter { it.isNotEmpty() }

        val tokens = mutableSetOf<String>()
        tokens.addAll(words)
        words.forEach { word ->
            for (i in 1..word.length) {
                tokens.add(word.substring(0, i))
            }
        }
        return tokens.toList()
    }
}