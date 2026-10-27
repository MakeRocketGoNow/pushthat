package com.makerocketgonow.pushthat

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.auth
import com.google.firebase.firestore.firestore
import com.google.firebase.Firebase
import com.google.firebase.firestore.Query
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.Date
import android.text.format.DateUtils
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.Menu
import android.view.MenuItem
import androidx.appcompat.widget.Toolbar
import com.makerocketgonow.pushthat.workers.RetryPushWorker
import com.makerocketgonow.pushthat.e2ee.AccountKeyStore
import com.makerocketgonow.pushthat.e2ee.E2ee
import com.makerocketgonow.pushthat.e2ee.MIN_NEW_PASSWORD_LENGTH
import com.makerocketgonow.pushthat.e2ee.PushContent
import com.makerocketgonow.pushthat.e2ee.PushDocument
import com.makerocketgonow.pushthat.e2ee.PushKeys
import com.makerocketgonow.pushthat.e2ee.PushMigration
import com.makerocketgonow.pushthat.e2ee.forgetSession
import com.makerocketgonow.pushthat.e2ee.signOut
import android.content.ClipboardManager
import android.content.ClipData
import android.widget.Toast
import android.content.Context
import com.google.firebase.firestore.DocumentSnapshot
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import android.widget.ProgressBar
import android.os.Handler
import android.os.Looper
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.firestore.FieldValue
import android.content.BroadcastReceiver
import android.content.IntentFilter
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import androidx.appcompat.app.AlertDialog
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.repeatOnLifecycle
import android.widget.EditText
import android.widget.ScrollView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// Move extractRootDomain to top-level
private fun extractRootDomain(url: String): String {
    return try {
        val uri = Uri.parse(url)
        val host = uri.host ?: return url
        // Get the last two parts of the domain (e.g., "google.com" from "www.google.com")
        host.split(".").takeLast(2).first()
    } catch (e: Exception) {
        url
    }
}

class MainActivity : AppCompatActivity() {

    private val TAG = "MainActivity"
    private lateinit var pushRecyclerView: RecyclerView
    private lateinit var swipeRefreshLayout: SwipeRefreshLayout
    private lateinit var auth: FirebaseAuth
    /** Null until the key has been opened off the main thread in `onCreate`. */
    private var keys: PushKeys? = null
    private var openingFile = false
    private val db = Firebase.firestore
    private var selectedItems = mutableSetOf<String>()
    private var menu: Menu? = null
    private lateinit var pushAdapter: PushAdapter
    private var isSelectAllChecked = false
    private var planDialog: AlertDialog? = null
    private lateinit var keySettings: KeySettingsViewModel
    private var keySettingsDialog: AlertDialog? = null
    private lateinit var listProgressBar: ProgressBar
    private lateinit var searchLayout: View
    private lateinit var selectionLayout: View
    private lateinit var selectAllText: TextView
    private lateinit var deleteButton: View
    private var currentSearchQuery: String? = null
    private val searchHandler = Handler(Looper.getMainLooper())
    private var searchRunnable: Runnable? = null
    private val NOTIFICATION_PERMISSION_REQUEST_CODE = 123

    // Pagination variables
    private val limit = 10
    private var isLoading = false
    private var lastVisibleDocument: DocumentSnapshot? = null
    private var hasMoreData = true

    private var isReceiverRegistered = false
    private val pushReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == PushThatMessagingService.ACTION_PUSH_RECEIVED) {
                Log.d(TAG, "Received push notification broadcast")
                // Reset pagination variables and reload on main thread
                runOnUiThread {
                    lastVisibleDocument = null
                    hasMoreData = true
                    loadPushRecords(true)
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        applyWindowInsets()

        auth = Firebase.auth
        listProgressBar = findViewById(R.id.listProgressBar)

        // Initialize toolbar views
        searchLayout = findViewById(R.id.searchLayout)
        selectionLayout = findViewById(R.id.selectionLayout)
        selectAllText = findViewById(R.id.selectAllText)
        deleteButton = findViewById(R.id.deleteButton)

        // Setup click listeners
        selectAllText.setOnClickListener {
            isSelectAllChecked = !isSelectAllChecked
            selectAllText.text = if (isSelectAllChecked) getString(R.string.deselect_all) else getString(R.string.select_all)
            pushAdapter.selectAll(isSelectAllChecked)
        }

        deleteButton.setOnClickListener {
            showDeleteConfirmation()
        }

        // Signed in, and holding the account key. A session without the key (an install that
        // updated while signed in) goes to LoginActivity's password prompt before the list,
        // and one with a recovery key not yet confirmed to its recovery key screen, unless
        // Settings is showing that key here (this is a rotation, not a new process).
        keySettings = ViewModelProvider(this)[KeySettingsViewModel::class.java]
        val settingsShowKey = keySettings.state.value.let {
            it is KeySettingsViewModel.State.RecoveryKey || it is KeySettingsViewModel.State.Working
        }
        val user = auth.currentUser
        if (
            user == null ||
            !AccountKeyStore.hasKey(this, user.uid) ||
            (
                !settingsShowKey &&
                    !LoginViewModel.recoveryKeyUnavailable &&
                    AccountKeyStore.hasUnconfirmedRecoveryKey(this, user.uid)
                )
        ) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
        }
        // The key is opened off the main thread (a Keystore call, see AccountKeyStore.hasKey),
        // and the list waits for it: until then loadPushRecords has nothing to read with.
        val uid = user.uid
        lifecycleScope.launch {
            val loaded = withContext(Dispatchers.IO) { AccountKeyStore.pushKeys(this@MainActivity, uid) }
            if (loaded == null) {
                // The key was there by the file and did not open; load has cleared it.
                startActivity(Intent(this@MainActivity, LoginActivity::class.java))
                finish()
                return@launch
            }
            keys = loaded
            // The account's plaintext pushes, encrypted in place in the background. Here,
            // since this is where every start with a key and every sign-in or unlock arrives.
            PushMigration.startOnce(loaded)
            loadPushRecords(true)
        }

        pushRecyclerView = findViewById(R.id.pushRecyclerView)
        swipeRefreshLayout = findViewById(R.id.swipeRefreshLayout)

        // Setup search
        findViewById<androidx.appcompat.widget.SearchView>(R.id.searchView).apply {
            setOnQueryTextListener(object : androidx.appcompat.widget.SearchView.OnQueryTextListener {
                override fun onQueryTextSubmit(query: String?): Boolean {
                    return true // We don't need to handle submit as we're doing real-time search
                }

                override fun onQueryTextChange(newText: String?): Boolean {
                    // Cancel any pending search
                    searchRunnable?.let { searchHandler.removeCallbacks(it) }

                    // Create new search with debounce
                    searchRunnable = Runnable {
                        // As typed: loadPushRecords normalizes it the way the tokens were.
                        currentSearchQuery = newText?.takeIf { it.isNotBlank() }
                        // Reset pagination
                        lastVisibleDocument = null
                        hasMoreData = true
                        // Reload data with search
                        loadPushRecords(true)
                    }.also {
                        // Schedule the search after 500ms debounce
                        searchHandler.postDelayed(it, 500)
                    }
                    return true
                }
            })
        }

        // Setup SwipeRefreshLayout
        swipeRefreshLayout.setOnRefreshListener {
            // Reset pagination variables
            lastVisibleDocument = null
            hasMoreData = true
            // Reload data
            loadPushRecords(true)
        }

        val layoutManager = LinearLayoutManager(this)
        pushRecyclerView.layoutManager = layoutManager
        pushAdapter = PushAdapter({ url, isSelected ->
            onItemSelected(url, isSelected)
        }, { isEmpty ->
            findViewById<TextView>(R.id.emptyStateText).visibility = if (isEmpty) View.VISIBLE else View.GONE
        }, { push -> openPush(push) })
        pushRecyclerView.adapter = pushAdapter

        // Add scroll listener for pagination
        pushRecyclerView.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                super.onScrolled(recyclerView, dx, dy)

                val visibleItemCount = layoutManager.childCount
                val totalItemCount = layoutManager.itemCount
                val firstVisibleItemPosition = layoutManager.findFirstVisibleItemPosition()

                if (!isLoading && hasMoreData) {
                    if ((visibleItemCount + firstVisibleItemPosition) >= totalItemCount
                        && firstVisibleItemPosition >= 0
                        && totalItemCount >= limit
                    ) {
                        loadPushRecords(false)
                    }
                }
            }
        })

        // Setup toolbar
        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        setSupportActionBar(toolbar)

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                keySettings.state.collect { renderKeySettings(it) }
            }
        }

        // Fetch initial push records
        loadPushRecords(true)

        // Schedule the worker
        RetryPushWorker.schedule(this)

        // Request notification permission for Android 13 and above
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestNotificationPermission()
        }

        // Get FCM token
        FirebaseMessaging.getInstance().token
            .addOnCompleteListener { task ->
                if (!task.isSuccessful) {
                    Log.w(TAG, "Fetching FCM registration token failed", task.exception)
                    return@addOnCompleteListener
                }

                // Get new FCM registration token
                val token = task.result
                Log.d(TAG, "FCM Token: $token")

                // Save the token to Firestore
                updateUserFcmToken(token)
            }

        // Register broadcast receiver using LocalBroadcastManager
        try {
            LocalBroadcastManager.getInstance(this).registerReceiver(
                pushReceiver,
                IntentFilter(PushThatMessagingService.ACTION_PUSH_RECEIVED)
            )
            isReceiverRegistered = true
            Log.d(TAG, "Registered push receiver")
        } catch (e: Exception) {
            Log.e(TAG, "Error registering push receiver", e)
        }
    }

    private fun loadPushRecords(isInitialLoad: Boolean) {
        val currentUser = auth.currentUser
        if (currentUser == null) {
            // The session ended while the list was open (see LoginActivity.onCreate): the
            // key goes with it.
            forgetSession(this)
            pushAdapter.updatePushes(emptyList())
            swipeRefreshLayout.isRefreshing = false
            return
        }

        val keys = keys ?: run {
            swipeRefreshLayout.isRefreshing = false
            return
        }
        isLoading = true

        var query = db.collection("pushes")
            .whereEqualTo("userId", currentUser.uid)

        // A search looks up the blind token of the term's first word, the same index every
        // client writes (docs/e2ee.md, Search). A term with no word in it is no search.
        currentSearchQuery?.let { E2ee.searchTermToken(keys.searchKey, it) }?.let { token ->
            query = query.whereArrayContains("searchTokens", token)
        }

        query = query.orderBy("createdAt", Query.Direction.DESCENDING)
            .limit(limit.toLong())

        // If not initial load, start after the last document
        if (!isInitialLoad && lastVisibleDocument != null) {
            query = query.startAfter(lastVisibleDocument!!)
        }

        query.get().addOnSuccessListener { snapshot ->
            isLoading = false
            swipeRefreshLayout.isRefreshing = false

            if (snapshot.isEmpty) {
                hasMoreData = false
                if (isInitialLoad) {
                    pushAdapter.updatePushes(emptyList())
                }
                return@addOnSuccessListener
            }

            val pushes = snapshot.documents.mapNotNull { doc -> pushItem(keys, doc) }

            // Update the last visible document for pagination
            lastVisibleDocument = snapshot.documents.lastOrNull()

            if (isInitialLoad) {
                pushAdapter.updatePushes(pushes)
            } else {
                pushAdapter.appendPushes(pushes)
            }
        }.addOnFailureListener { e ->
            Log.e("MainActivity", "Error loading pushes", e)
            isLoading = false
        }
    }

    /**
     * A row from either shape of push: decrypted when it has an envelope (until phase 5,
     * a push may still be plaintext), locked when this install cannot open it.
     */
    private fun pushItem(keys: PushKeys, doc: DocumentSnapshot): PushItem? {
        val data = doc.data ?: return null
        val createdAt = doc.getTimestamp("createdAt")?.toDate()
        return when (val read = PushDocument.read(keys, doc.id, data)) {
            null -> null
            is PushDocument.Read.Plain ->
                PushItem(doc.id, read.title.ifBlank { read.url }, createdAt, read.url, read.ext, PushTarget.Link(read.url))
            PushDocument.Read.Locked ->
                PushItem(doc.id, getString(R.string.locked_push), createdAt, null, null, PushTarget.Locked)
            is PushDocument.Read.Opened -> when (val content = read.content) {
                is PushContent.Url ->
                    PushItem(doc.id, content.title.ifBlank { content.url }, createdAt, content.url, content.ext, PushTarget.Link(content.url))
                is PushContent.File -> {
                    val target = doc.getString("objectPath")?.let { PushTarget.File(it, content) } ?: PushTarget.Locked
                    PushItem(doc.id, content.name, createdAt, null, content.ext, target)
                }
            }
        }
    }

    private fun openPush(push: PushItem) {
        when (val target = push.target) {
            is PushTarget.Link -> try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(target.url)))
            } catch (e: Exception) {
                Log.e(TAG, "Error opening URL", e)
            }
            is PushTarget.File -> openFile(target)
            PushTarget.Locked -> AlertDialog.Builder(this, R.style.DeleteDialogStyle)
                .setTitle(R.string.locked_push)
                .setMessage(R.string.locked_push_message)
                .setPositiveButton(R.string.ok, null)
                .show()
        }
    }

    /**
     * Downloads, decrypts and opens a file push, with the list's progress bar up meanwhile.
     * One at a time: a second tap while a large file downloads would start it again.
     */
    private fun openFile(target: PushTarget.File) {
        if (openingFile) return
        openingFile = true
        listProgressBar.visibility = View.VISIBLE
        val file = target.content
        lifecycleScope.launch {
            val result = runCatching {
                withContext(Dispatchers.IO) { PushFiles.fetch(this@MainActivity, target.objectPath, file.name, file.fk, file.np) }
            }
            openingFile = false
            listProgressBar.visibility = View.GONE
            // Signed out while the file was on its way (this scope cancelled, or the session
            // ended under the open): `PushFiles.fetch` has removed what it wrote, nothing is
            // opened, and a failure to decrypt would be the wrong thing to say.
            if (result.exceptionOrNull() is CancellationException) return@launch
            result.onSuccess { opened ->
                try {
                    PushFiles.view(this@MainActivity, opened, file.mime, file.ext)
                } catch (e: Exception) {
                    Log.e(TAG, "Error opening file", e)
                }
            }.onFailure { e ->
                // A download that failed and a file that did not decrypt alike: in both cases
                // nothing was opened and nothing partial is left.
                Log.e(TAG, "Error fetching file", e)
                Toast.makeText(this@MainActivity, R.string.file_decrypt_failed, Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        dismissKeySettingsDialog()
        // Safely unregister broadcast receiver
        if (isReceiverRegistered) {
            try {
                LocalBroadcastManager.getInstance(this).unregisterReceiver(pushReceiver)
                isReceiverRegistered = false
                Log.d(TAG, "Unregistered push receiver")
            } catch (e: Exception) {
                Log.e(TAG, "Error unregistering push receiver", e)
            }
        }
        // Clean up the handler
        searchHandler.removeCallbacksAndMessages(null)
    }

    override fun onResume() {
        super.onResume()
        // Reset pagination variables
        lastVisibleDocument = null
        hasMoreData = true
        // Reload data
        loadPushRecords(true)
    }

    /**
     * Apps targeting Android 16 (API 36) are always laid out edge to edge: the
     * window spans the status and navigation bars and Window.setDecorFitsSystemWindows
     * is a no-op, so every view that must stay clear of the system bars has to be
     * padded by hand.
     *
     * The toolbar takes the top inset so its background extends behind the status
     * bar, and the list takes the bottom inset so it can still scroll underneath
     * the navigation bar.
     */
    private fun applyWindowInsets() {
        val toolbar = findViewById<Toolbar>(R.id.toolbar)
        ViewCompat.setOnApplyWindowInsetsListener(toolbar) { view, windowInsets ->
            val insets = windowInsets.systemBarAndCutoutInsets()
            view.updatePadding(left = insets.left, top = insets.top, right = insets.right)
            windowInsets
        }

        ViewCompat.setOnApplyWindowInsetsListener(findViewById(R.id.pushRecyclerView)) { view, windowInsets ->
            val insets = windowInsets.systemBarAndCutoutInsets()
            view.updatePadding(left = insets.left, right = insets.right, bottom = insets.bottom)
            windowInsets
        }
    }

    private fun WindowInsetsCompat.systemBarAndCutoutInsets() =
        getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.main_menu, menu)
        menuInflater.inflate(R.menu.overflow_menu, menu)
        this.menu = menu
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        return when (item.itemId) {
            R.id.nav_logout -> {
                signOut(this, auth)
                startActivity(Intent(this, LoginActivity::class.java))
                finish()
                true
            }
            R.id.nav_plan -> {
                showPlan()
                true
            }
            R.id.nav_change_password -> {
                showChangePassword()
                true
            }
            R.id.nav_new_recovery_key -> {
                // Said first: the old key stops working the moment the new one is written.
                AlertDialog.Builder(this, R.style.DeleteDialogStyle)
                    .setTitle(R.string.new_recovery_key)
                    .setMessage(R.string.new_recovery_key_warning)
                    .setPositiveButton(R.string.continue_) { _, _ -> keySettings.newRecoveryKey() }
                    .setNegativeButton(R.string.cancel, null)
                    .show()
                true
            }
            R.id.action_delete -> {
                showDeleteConfirmation()
                true
            }
            R.id.action_select_all -> {
                isSelectAllChecked = !isSelectAllChecked
                item.isChecked = isSelectAllChecked
                pushAdapter.selectAll(isSelectAllChecked)
                true
            }
            else -> super.onOptionsItemSelected(item)
        }
    }

    /**
     * Where the account stands: the tier, this month's usage against its limits, and that
     * plans are managed on the web. Said, not linked: both stores forbid a button that
     * leads to a purchase outside their billing.
     */
    private fun showPlan() {
        // One dialog at a time: a second tap while the report is being read would otherwise
        // start another read and stack another dialog on top.
        if (planDialog?.isShowing == true) return
        // Shown at once, with a loading line, and filled in when the report arrives: the
        // read is a token fetch and an HTTP call, and a blank wait invites a second tap.
        val dialog = AlertDialog.Builder(this, R.style.DeleteDialogStyle)
            .setTitle(R.string.plan)
            .setMessage(R.string.plan_reading)
            .setPositiveButton(R.string.ok, null)
            .show()
        planDialog = dialog
        lifecycleScope.launch {
            val report = Plan.fetchReport()
            if (isFinishing || isDestroyed || !dialog.isShowing) return@launch
            if (report == null) {
                dialog.setMessage(getString(R.string.plan_unavailable))
                return@launch
            }
            // A comp is complimentary while it runs; one that has ended is a Free account
            // (`subscriptionType` stays "comp" either way).
            val title = when {
                report.isPro && report.subscriptionType == "comp" -> R.string.plan_pro_comp
                report.isPro -> R.string.plan_pro
                else -> R.string.plan_free
            }
            val usage = getString(
                R.string.plan_usage,
                report.urlUsed, report.urlLimit, report.fileUsed, report.fileLimit,
                Plan.megabytes(report.fileBytes), report.keepDays
            )
            val collecting = report.subscriptionStatus == "past_due" || report.subscriptionStatus == "unpaid"
            val standing = when {
                report.isPro && collecting -> getString(R.string.plan_payment_failed)
                report.isPro && report.cancelsAt != null -> getString(R.string.plan_ends, formatDay(report.cancelsAt))
                report.isPro && report.subscriptionType == "pro" && report.expiresAt != null ->
                    getString(R.string.plan_renews, formatDay(report.expiresAt))
                else -> null
            }
            dialog.setTitle(getString(title))
            dialog.setMessage(listOfNotNull(usage, standing, getString(R.string.plan_managed)).joinToString("\n\n"))
        }
    }

    /**
     * Current, new and new again. The dialog stays open while what was typed is wrong, so
     * its buttons are wired after `show()`: the builder's would close it on any tap.
     */
    private fun showChangePassword() {
        val view = layoutInflater.inflate(R.layout.dialog_change_password, null)
        val current = view.findViewById<EditText>(R.id.currentPasswordInput)
        val new = view.findViewById<EditText>(R.id.newPasswordInput)
        val again = view.findViewById<EditText>(R.id.newPasswordAgainInput)
        view.findViewById<TextView>(R.id.passwordRuleText).text = getString(R.string.password_rule, MIN_NEW_PASSWORD_LENGTH)
        val dialog = AlertDialog.Builder(this, R.style.DeleteDialogStyle)
            .setTitle(R.string.change_password)
            .setView(view)
            .setPositiveButton(R.string.change_password, null)
            .setNegativeButton(R.string.cancel, null)
            .show()
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            // Not trimmed: the keys are derived from the password exactly as typed.
            val currentPassword = current.text.toString()
            val newPassword = new.text.toString()
            when {
                currentPassword.isEmpty() -> current.error = getString(R.string.password_required)
                newPassword.length < MIN_NEW_PASSWORD_LENGTH -> new.error = getString(R.string.password_rule, MIN_NEW_PASSWORD_LENGTH)
                newPassword != again.text.toString() -> again.error = getString(R.string.passwords_differ)
                else -> {
                    dialog.dismiss()
                    keySettings.changePassword(currentPassword, newPassword)
                }
            }
        }
    }

    /**
     * The settings' progress, result and recovery key, one dialog at a time, shown again
     * from the view model's state after a rotation. The recovery key cannot be dismissed
     * but by "I saved it", as at sign-up.
     */
    private fun renderKeySettings(state: KeySettingsViewModel.State) {
        dismissKeySettingsDialog()
        val builder = AlertDialog.Builder(this, R.style.DeleteDialogStyle)
        keySettingsDialog = when (state) {
            KeySettingsViewModel.State.Idle -> null
            is KeySettingsViewModel.State.Working -> builder
                .setMessage(state.message)
                .setCancelable(false)
                .show()
            is KeySettingsViewModel.State.Done -> builder
                .setMessage(state.message)
                .setPositiveButton(R.string.ok, null)
                .setOnDismissListener { keySettings.acknowledge() }
                .show()
            is KeySettingsViewModel.State.Failed -> builder
                .setMessage(state.message)
                .setPositiveButton(R.string.ok, null)
                .setOnDismissListener { keySettings.acknowledge() }
                .show()
            is KeySettingsViewModel.State.RecoveryKey -> {
                val view = LayoutInflater.from(builder.context).inflate(R.layout.view_recovery_key, null)
                val padding = (24 * resources.displayMetrics.density).toInt()
                val scroll = ScrollView(builder.context).apply {
                    setPadding(padding, padding, padding, padding)
                    addView(view)
                }
                val dialog = builder.setView(scroll).setCancelable(false).show()
                RecoveryKeyView.bind(view, state.recoveryKey) {
                    dialog.dismiss()
                    keySettings.recoveryKeySaved()
                }
                dialog
            }
        }
    }

    // Without its dismiss listener, which would take the dismissal for the user having seen
    // the result: this runs when the state moves on, and when a rotation takes the window.
    private fun dismissKeySettingsDialog() {
        keySettingsDialog?.setOnDismissListener(null)
        keySettingsDialog?.dismiss()
        keySettingsDialog = null
    }

    /** An ISO 8601 instant from the server as a local date. Without java.time, which minSdk 24 lacks. */
    private fun formatDay(iso: String): String = runCatching {
        val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        java.text.DateFormat.getDateInstance(java.text.DateFormat.LONG).format(parser.parse(iso)!!)
    }.getOrDefault(iso)

    private fun showDeleteConfirmation() {
        val itemCount = selectedItems.size
        val message = if (itemCount == 1) {
            getString(R.string.delete_confirmation_single)
        } else {
            getString(R.string.delete_confirmation_multiple, itemCount)
        }

        androidx.appcompat.app.AlertDialog.Builder(this, R.style.DeleteDialogStyle)
            .setTitle(R.string.delete_confirmation_title)
            .setMessage(message)
            .setPositiveButton(R.string.delete) { _, _ ->
                deleteSelectedItems()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun deleteSelectedItems() {
        auth.currentUser ?: return

        // Show progress and disable interactions
        listProgressBar.visibility = View.VISIBLE
        pushRecyclerView.isEnabled = false
        swipeRefreshLayout.isEnabled = false

        var deletedCount = 0
        val totalItems = selectedItems.size

        selectedItems.forEach { documentId ->
            db.collection("pushes")
                .document(documentId)
                .delete()
                .addOnCompleteListener {
                    deletedCount++
                    if (deletedCount == totalItems) {
                        // All items deleted, restore UI
                        listProgressBar.visibility = View.GONE
                        pushRecyclerView.isEnabled = true
                        swipeRefreshLayout.isEnabled = true
                        clearSelection()
                        updateToolbarState()
                        // Refresh the list
                        loadPushRecords(true)
                    }
                }
                .addOnFailureListener {
                    // Handle failure
                    deletedCount++
                    if (deletedCount == totalItems) {
                        // Restore UI even if some deletions failed
                        listProgressBar.visibility = View.GONE
                        pushRecyclerView.isEnabled = true
                        swipeRefreshLayout.isEnabled = true
                        clearSelection()
                        updateToolbarState()
                        loadPushRecords(true)
                    }
                }
        }
    }

    private fun updateDeleteButton() {
        menu?.let { menu ->
            val hasSelectedItems = selectedItems.isNotEmpty()
            menu.findItem(R.id.action_delete)?.isVisible = hasSelectedItems
            menu.findItem(R.id.action_select_all)?.isVisible = hasSelectedItems
        }
    }

    private fun clearSelection() {
        selectedItems.clear()
        isSelectAllChecked = false
        menu?.findItem(R.id.action_select_all)?.isChecked = false
        updateDeleteButton()
        pushAdapter.selectAll(false)
    }

    private fun updateToolbarState() {
        val hasSelectedItems = selectedItems.isNotEmpty()
        searchLayout.visibility = if (hasSelectedItems) View.GONE else View.VISIBLE
        selectionLayout.visibility = if (hasSelectedItems) View.VISIBLE else View.GONE

        // Reset select all text when no items are selected
        if (!hasSelectedItems) {
            isSelectAllChecked = false
            selectAllText.text = getString(R.string.select_all)
        }
    }

    fun onItemSelected(url: String, isSelected: Boolean) {
        if (isSelected) {
            selectedItems.add(url)
        } else {
            selectedItems.remove(url)
            // Update select all state if an item is deselected
            if (isSelectAllChecked) {
                isSelectAllChecked = false
                selectAllText.text = getString(R.string.select_all)
            }
        }
        updateToolbarState()
    }

    private fun requestNotificationPermission() {
        if (ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                NOTIFICATION_PERMISSION_REQUEST_CODE
            )
        }
    }

    private fun updateUserFcmToken(token: String) {
        val currentUser = auth.currentUser ?: return

        val userRef = db.collection("users").document(currentUser.uid)

        userRef.get()
            .addOnSuccessListener { document ->
                if (document.exists()) {
                    @Suppress("UNCHECKED_CAST")
                    val existingTokens = document.get("fcmTokens") as? List<String> ?: emptyList()
                    if (!existingTokens.contains(token)) {
                        userRef.update("fcmTokens", FieldValue.arrayUnion(token))
                            .addOnSuccessListener {
                                Log.d(TAG, "FCM Token added successfully")
                            }
                            .addOnFailureListener { e ->
                                Log.w(TAG, "Error adding FCM token", e)
                            }
                    }
                } else {
                    userRef.set(mapOf(
                        "fcmTokens" to listOf(token),
                        "createdAt" to FieldValue.serverTimestamp()
                    ))
                        .addOnSuccessListener {
                            Log.d(TAG, "New user document created with FCM token")
                        }
                        .addOnFailureListener { e ->
                            Log.w(TAG, "Error creating user document", e)
                        }
                }
            }
            .addOnFailureListener { e ->
                Log.w(TAG, "Error checking user document", e)
            }
    }
}

/** What tapping a row does. */
sealed class PushTarget {
    /** A URL push, or a plaintext file push, which still carries its download URL. */
    data class Link(val url: String) : PushTarget()

    /** An encrypted file push: downloaded by [objectPath], decrypted unless `legacyPlain`. */
    class File(val objectPath: String, val content: PushContent.File) : PushTarget()

    /** A push this install cannot open: it says so, and can be deleted. */
    data object Locked : PushTarget()
}

data class PushItem(
    val id: String,
    val title: String,
    val createdAt: Date?,
    /** The URL the favicon comes from; none for an encrypted file or a locked push. */
    val iconUrl: String?,
    val ext: String?,
    val target: PushTarget,
)

class PushAdapter(
    private val onItemSelected: (String, Boolean) -> Unit,
    private val onEmptyStateChanged: (Boolean) -> Unit,
    private val onItemClicked: (PushItem) -> Unit,
) : RecyclerView.Adapter<PushAdapter.PushViewHolder>() {
    private var pushes: List<PushItem> = emptyList()
    private var selectedIds = mutableSetOf<String>()

    fun updatePushes(newPushes: List<PushItem>) {
        pushes = newPushes
        onEmptyStateChanged(newPushes.isEmpty())
        notifyDataSetChanged()
    }

    fun appendPushes(newPushes: List<PushItem>) {
        val currentSize = pushes.size
        pushes = pushes + newPushes
        notifyItemRangeInserted(currentSize, newPushes.size)
        onEmptyStateChanged(pushes.isEmpty())
    }

    fun selectAll(isSelected: Boolean) {
        if (isSelected) {
            selectedIds.addAll(pushes.map { it.id })
        } else {
            selectedIds.clear()
        }
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PushViewHolder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.push_item, parent, false)
        return PushViewHolder(view)
    }

    override fun onBindViewHolder(holder: PushViewHolder, position: Int) {
        holder.bind(pushes[position])
    }

    override fun getItemCount() = pushes.size

    inner class PushViewHolder(itemView: View) : RecyclerView.ViewHolder(itemView) {
        private val avatarImage: SwivelCheckView = itemView.findViewById(R.id.avatarImage)
        private val titleText: TextView = itemView.findViewById(R.id.titleText)
        private val relativeTimeText: TextView = itemView.findViewById(R.id.relativeTimeText)
        private val actualTimeText: TextView = itemView.findViewById(R.id.actualTimeText)
        private val dateFormat = SimpleDateFormat("h:mm a", Locale.getDefault())

        fun bind(push: PushItem) {
            // Load favicon or file icon
            avatarImage.loadFavicon(push.iconUrl, push.ext)

            // Set title
            titleText.text = push.title

            // Set times
            push.createdAt?.let { date ->
                val relativeTime = DateUtils.getRelativeTimeSpanString(
                    date.time,
                    System.currentTimeMillis(),
                    DateUtils.MINUTE_IN_MILLIS,
                    DateUtils.FORMAT_ABBREV_RELATIVE
                )
                relativeTimeText.text = relativeTime.toString()
                actualTimeText.text = dateFormat.format(date)
            }

            // Update checkbox state
            avatarImage.setChecked(selectedIds.contains(push.id), false)

            // Add click listener for the checkbox
            avatarImage.setOnClickListener {
                avatarImage.toggle()
            }

            // Set click listener for the item
            itemView.setOnClickListener { onItemClicked(push) }

            // Copies a URL. An encrypted file push has none (no download URL is stored) and a
            // locked one's is unknown, so a long press on those offers nothing.
            val link = push.target as? PushTarget.Link
            if (link == null) {
                itemView.setOnLongClickListener(null)
                itemView.isLongClickable = false
            } else {
                itemView.setOnLongClickListener {
                    val clipboard = itemView.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val clip = ClipData.newPlainText("URL", link.url)
                    clipboard.setPrimaryClip(clip)
                    Toast.makeText(itemView.context, "URL copied to clipboard", Toast.LENGTH_SHORT).show()
                    true
                }
            }

            avatarImage.setOnCheckedChangeListener { _, isChecked ->
                if (isChecked) {
                    selectedIds.add(push.id)
                } else {
                    selectedIds.remove(push.id)
                }
                onItemSelected(push.id, isChecked)
            }
        }
    }
}