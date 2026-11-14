import Foundation
import FirebaseAuth
import FirebaseFirestore
import FirebaseStorage
import Combine
import SwiftUI
import PhotosUI

@MainActor
class PushListViewModel: ObservableObject {
    @Published var pushItems: [PushItem] = []
    @Published var isLoading = false
    @Published var selectedItems: Set<String> = []
    @Published var isSelectionMode = false
    @Published var showDeleteConfirmation = false
    @Published var showError = false
    @Published var errorMessage = ""

    // Photo/File picker state
    @Published var showPhotoPicker = false
    @Published var showFilePicker = false
    @Published var selectedPhoto: PhotosPickerItem?
    @Published var isUploading = false

    /// Set while an encrypted file is fetched and decrypted, which can take a while.
    @Published var isOpeningFile = false
    /// The tap on a locked push, which says why it cannot open.
    @Published var showLockedNotice = false
    /// The decrypted file QuickLook shows.
    @Published var previewURL: URL?

    private let db = Firestore.firestore()
    private let pageSize = 10
    private var lastDocument: DocumentSnapshot?
    private var hasMoreData = true
    private var searchQuery = ""
    private var searchTask: Task<Void, Never>?
    /// A refresh asked for while a load or a delete held `isLoading`, run once it is done.
    private var refreshPending = false
    private var notificationObservers: [NSObjectProtocol] = []

    var isAllSelected: Bool {
        !pushItems.isEmpty && selectedItems.count == pushItems.count
    }

    init() {
        Task { await loadPushes() }
        // The list is what opens once the account key is on this device, at start and right
        // after a sign-in or unlock, so it is where the plaintext pushes start moving.
        if let uid = Auth.auth().currentUser?.uid {
            Task.detached(priority: .background) {
                await PushMigration.shared.runIfNeeded(uid: uid)
            }
        }
        setupPushNotificationListener()
        setupForegroundListener()
    }

    deinit {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - Data Loading

    func loadPushes(isInitial: Bool = true) async {
        guard !isLoading, let userId = Auth.auth().currentUser?.uid else { return }
        if !isInitial && !hasMoreData { return }

        isLoading = true

        let keys = PushKeys.load(uid: userId)

        var query = db.collection("pushes")
            .whereField("userId", isEqualTo: userId)
            .order(by: "createdAt", descending: true)
            .limit(to: pageSize)

        // The blind token of the term's first word (docs/e2ee.md, "Search"); a term with no
        // word in it is no search, and the list is unfiltered.
        if let token = keys?.searchToken(for: searchQuery) {
            query = db.collection("pushes")
                .whereField("userId", isEqualTo: userId)
                .whereField("searchTokens", arrayContains: token)
                .order(by: "createdAt", descending: true)
                .limit(to: pageSize)
        }

        if !isInitial, let lastDoc = lastDocument {
            query = query.start(afterDocument: lastDoc)
        }

        do {
            let snapshot = try await query.getDocuments()
            let newItems = snapshot.documents.compactMap { PushItem(document: $0, keys: keys) }
            if let keys {
                scrapeUntitled(newItems, keys: keys)
            }

            if isInitial {
                pushItems = newItems
                // A reload keeps the first page only. A selection of rows it dropped would
                // be deleted unseen and would throw off `isAllSelected`, so only what the
                // list still shows stays selected.
                selectedItems.formIntersection(newItems.compactMap(\.id))
            } else {
                pushItems.append(contentsOf: newItems)
            }

            lastDocument = snapshot.documents.last
            hasMoreData = snapshot.documents.count >= pageSize
        } catch {
            errorMessage = "Failed to load pushes: \(error.localizedDescription)"
            showError = true
        }

        finishLoading()
    }

    func loadMore() {
        guard hasMoreData && !isLoading else { return }
        Task { await loadPushes(isInitial: false) }
    }

    /// Reloads the first page. The cursor is reset only once the load is sure to run: a
    /// refresh that arrived while another load or a delete held `isLoading` used to clear
    /// it and return, and the next page then fetched page 1 again, duplicating its rows.
    /// Nor is such a refresh dropped: it runs once the load in flight is done, so a push
    /// made meanwhile (a dropped URL, a share, a search typed during a load) still lands.
    func refresh() async {
        guard !isLoading else {
            refreshPending = true
            return
        }
        lastDocument = nil
        hasMoreData = true
        await loadPushes(isInitial: true)
    }

    /// Ends a load or a delete, and runs the refresh that arrived meanwhile, if any.
    private func finishLoading() {
        isLoading = false
        if refreshPending {
            refreshPending = false
            Task { await refresh() }
        }
    }

    // MARK: - Search

    func search(query: String) {
        searchTask?.cancel()
        searchTask = Task {
            // 500ms debounce (matches Android)
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }

            searchQuery = query
            await refresh()
        }
    }

    func clearSearch() {
        searchQuery = ""
        Task { await refresh() }
    }

    // MARK: - Selection

    func toggleSelection(_ item: PushItem) {
        guard let id = item.id else { return }
        if selectedItems.contains(id) {
            selectedItems.remove(id)
        } else {
            selectedItems.insert(id)
        }
    }

    func toggleSelectAll() {
        if isAllSelected {
            selectedItems.removeAll()
        } else {
            selectedItems = Set(pushItems.compactMap { $0.id })
        }
    }

    func enterSelectionMode() {
        isSelectionMode = true
    }

    func exitSelectionMode() {
        isSelectionMode = false
        selectedItems.removeAll()
    }

    // MARK: - Deletion

    func delete(at indexSet: IndexSet) {
        Task {
            isLoading = true
            for index in indexSet {
                guard let docId = pushItems[index].id else { continue }
                do {
                    try await db.collection("pushes").document(docId).delete()
                } catch {
                    print("Failed to delete: \(error)")
                }
            }
            pushItems.remove(atOffsets: indexSet)
            finishLoading()
        }
    }

    func deleteSelected() {
        guard !selectedItems.isEmpty else { return }

        Task {
            isLoading = true
            for docId in selectedItems {
                do {
                    try await db.collection("pushes").document(docId).delete()
                } catch {
                    print("Failed to delete \(docId): \(error)")
                }
            }
            pushItems.removeAll { selectedItems.contains($0.id ?? "") }
            selectedItems.removeAll()
            isSelectionMode = false
            finishLoading()
        }
    }

    // MARK: - Actions

    /// A tap on a row: a URL push opens its URL, a file push its file, a locked push says
    /// why it cannot.
    func open(_ item: PushItem) {
        switch item.source {
        case .locked:
            showLockedNotice = true
        case let .encrypted(file?, objectPath):
            guard let objectPath else {
                showError(PushFileOpener.OpenError.notDownloaded.localizedDescription)
                return
            }
            openFile(file, objectPath: objectPath)
        case .encrypted, .plaintext:
            // A URL push, or a plaintext file push, which still has its download URL.
            openURL(item.url)
        }
    }

    func openURL(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
    }

    func copyToClipboard(_ item: PushItem) {
        guard let text = item.copyText else { return }
        UIPasteboard.general.string = text
    }

    private func openFile(_ file: PushFile, objectPath: String) {
        guard !isOpeningFile else { return }
        isOpeningFile = true
        Task {
            defer { isOpeningFile = false }
            // A sign-out while the file opened ends the session it was for: nothing is shown
            // then, neither the file (which `PushFileOpener.clear()` has removed) nor an error.
            let session = PushFileOpener.session
            do {
                let local = try await PushFileOpener.localFile(file: file, objectPath: objectPath, storage: Storage.storage())
                guard PushFileOpener.session == session else { return }
                previewURL = local
            } catch PushFileOpener.OpenError.signedOut {
                return
            } catch {
                guard PushFileOpener.session == session else { return }
                showError(error.localizedDescription)
            }
        }
    }

    private func showError(_ message: String) {
        errorMessage = message
        showError = true
    }

    /// Untitled URL pushes get their page's title and icon, whichever device made them
    /// (`TitleScraperService`). In the background: the list does not wait for any page.
    /// A titled push is not read again for an icon (docs/e2ee.md, "Icons"), so a push
    /// from before icons keeps the placeholder rather than every list asking every site.
    ///
    /// The list is read once (`getDocuments`), so nothing redraws a row when its push is
    /// rewritten: the scraped title used to appear only at the next load, a relaunch for
    /// most. The row takes what the write left instead. A snapshot listener would also
    /// catch other devices' changes, but the list pages by cursor and searches by token,
    /// and a listener per page for one row's title was the larger change. Android's list is
    /// read once too and is not redrawn by its scrape either.
    private func scrapeUntitled(_ items: [PushItem], keys: PushKeys) {
        for item in items where item.type == .url && item.title.isEmpty {
            guard case .encrypted = item.source, let id = item.id else { continue }
            let url = item.url
            let hasIcon = !(item.icon ?? "").isEmpty
            let keyVersion = item.keyVersion
            Task.detached(priority: .utility) { [weak self] in
                guard let content = await TitleScraperService.shared.scrapeAndUpdate(
                    pushId: id, keyVersion: keyVersion, url: url, hasIcon: hasIcon, keys: keys
                ) else { return }
                await self?.showScraped(content, pushId: id)
            }
        }
    }

    /// Redraws the row of push `pushId` with what its scrape wrote. Found by id in the list
    /// as it is now, not as it was when the scrape began: a refresh, search or page loaded
    /// meanwhile has replaced the items, and a push no longer shown is left alone.
    private func showScraped(_ content: PushContent, pushId: String) {
        guard case let .url(_, title, _, icon) = content,
              let index = pushItems.firstIndex(where: { $0.id == pushId })
        else { return }
        pushItems[index] = pushItems[index].retitled(title: title, icon: icon)
    }

    // MARK: - Upload

    func uploadSelectedPhoto() {
        guard let photo = selectedPhoto else { return }

        isUploading = true
        UploadService.shared.uploadPhoto(photo) { [weak self] success in
            Task { @MainActor in
                self?.isUploading = false
                self?.selectedPhoto = nil

                if success {
                    await self?.refresh()
                } else if let error = UploadService.shared.uploadError {
                    self?.errorMessage = error
                    self?.showError = true
                }
            }
        }
    }

    func uploadFile(from url: URL) {
        isUploading = true
        UploadService.shared.uploadFile(from: url) { [weak self] success in
            Task { @MainActor in
                self?.isUploading = false

                if success {
                    await self?.refresh()
                } else if let error = UploadService.shared.uploadError {
                    self?.errorMessage = error
                    self?.showError = true
                }
            }
        }
    }

    // MARK: - Private

    private func setupPushNotificationListener() {
        notificationObservers.append(NotificationCenter.default.addObserver(
            forName: .pushReceived,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.refresh() }
        })
    }

    /// Reloads the first page each time the app comes back to the front, as Android's list
    /// does in `onResume`. A push shared from this device never reaches `.pushReceived`
    /// (the app keeps its own push's notification off the screen), so before this the list
    /// went on without it until a pull to refresh or a relaunch. Shared from another app's
    /// share sheet, the push is made while this app is in the background, so coming back
    /// to the front is the moment it can be in the list.
    ///
    /// `willEnterForeground`, not the scene becoming active: that also fires at launch,
    /// when `init` is already loading, and after every glance at Control Center or the
    /// notification shade, none of which can have made a push.
    private func setupForegroundListener() {
        notificationObservers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.refresh() }
        })
    }
}
