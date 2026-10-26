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
import kotlinx.coroutines.launch

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
    private val db = Firebase.firestore
    private var selectedItems = mutableSetOf<String>()
    private var menu: Menu? = null
    private lateinit var pushAdapter: PushAdapter
    private var isSelectAllChecked = false
    private var planDialog: AlertDialog? = null
    private lateinit var deleteProgressBar: ProgressBar
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
        deleteProgressBar = findViewById(R.id.deleteProgressBar)

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

        // Check if user is signed in
        if (auth.currentUser == null) {
            startActivity(Intent(this, LoginActivity::class.java))
            finish()
            return
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
                        currentSearchQuery = newText?.takeIf { it.isNotBlank() }?.lowercase()
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
        })
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
            pushAdapter.updatePushes(emptyList())
            swipeRefreshLayout.isRefreshing = false
            return
        }

        isLoading = true

        var query = db.collection("pushes")
            .whereEqualTo("userId", currentUser.uid)

        // Add search constraint if search term exists
        currentSearchQuery?.let { searchTerm ->
            query = query.whereArrayContains("searchTokens", searchTerm)
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

            val pushes = snapshot.documents.mapNotNull { doc ->
                val createdAt = doc.getTimestamp("createdAt")
                val url = doc.getString("url") ?: return@mapNotNull null
                val title = doc.getString("title")?.takeIf { it.isNotBlank() } ?: url
                val ext = doc.getString("ext")
                PushItem(doc.id, url, title, createdAt?.toDate(), ext)
            }

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

    override fun onDestroy() {
        super.onDestroy()
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
                auth.signOut()
                startActivity(Intent(this, LoginActivity::class.java))
                finish()
                true
            }
            R.id.nav_plan -> {
                showPlan()
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
        deleteProgressBar.visibility = View.VISIBLE
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
                        deleteProgressBar.visibility = View.GONE
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
                        deleteProgressBar.visibility = View.GONE
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

// Add these new classes at the bottom of the file
data class PushItem(
    val id: String,
    val url: String,
    val title: String,
    val createdAt: Date?,
    val ext: String? = null
)

class PushAdapter(
    private val onItemSelected: (String, Boolean) -> Unit,
    private val onEmptyStateChanged: (Boolean) -> Unit
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
            avatarImage.loadFavicon(push.url, push.ext)

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
            itemView.setOnClickListener {
                try {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(push.url))
                    itemView.context.startActivity(intent)
                } catch (e: Exception) {
                    Log.e("PushViewHolder", "Error opening URL", e)
                }
            }

            itemView.setOnLongClickListener {
                val clipboard = itemView.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("URL", push.url)
                clipboard.setPrimaryClip(clip)
                Toast.makeText(itemView.context, "URL copied to clipboard", Toast.LENGTH_SHORT).show()
                true
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