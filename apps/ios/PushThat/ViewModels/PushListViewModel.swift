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
    private var notificationObserver: NSObjectProtocol?

    var isAllSelected: Bool {
        !pushItems.isEmpty && selectedItems.count == pushItems.count
    }

    init() {
        Task { await loadPushes() }
        setupPushNotificationListener()
    }

    deinit {
        if let observer = notificationObserver {
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

            if isInitial {
                pushItems = newItems
            } else {
                pushItems.append(contentsOf: newItems)
            }

            lastDocument = snapshot.documents.last
            hasMoreData = snapshot.documents.count >= pageSize
        } catch {
            errorMessage = "Failed to load pushes: \(error.localizedDescription)"
            showError = true
        }

        isLoading = false
    }

    func loadMore() {
        guard hasMoreData && !isLoading else { return }
        Task { await loadPushes(isInitial: false) }
    }

    func refresh() async {
        lastDocument = nil
        hasMoreData = true
        await loadPushes(isInitial: true)
    }

    // MARK: - Search

    func search(query: String) {
        searchTask?.cancel()
        searchTask = Task {
            // 500ms debounce (matches Android)
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }

            searchQuery = query
            lastDocument = nil
            hasMoreData = true
            await loadPushes(isInitial: true)
        }
    }

    func clearSearch() {
        searchQuery = ""
        lastDocument = nil
        hasMoreData = true
        Task { await loadPushes(isInitial: true) }
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
            isLoading = false
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
            isLoading = false
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
            do {
                let local = try await PushFileOpener.localFile(file: file, objectPath: objectPath, storage: Storage.storage())
                previewURL = local
            } catch {
                showError(error.localizedDescription)
            }
        }
    }

    private func showError(_ message: String) {
        errorMessage = message
        showError = true
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
        notificationObserver = NotificationCenter.default.addObserver(
            forName: .pushReceived,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { await self?.refresh() }
        }
    }
}
