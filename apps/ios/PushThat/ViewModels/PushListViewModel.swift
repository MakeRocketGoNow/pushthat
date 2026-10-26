import Foundation
import FirebaseAuth
import FirebaseFirestore
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

        var query = db.collection("pushes")
            .whereField("userId", isEqualTo: userId)
            .order(by: "createdAt", descending: true)
            .limit(to: pageSize)

        if !searchQuery.isEmpty {
            query = db.collection("pushes")
                .whereField("userId", isEqualTo: userId)
                .whereField("searchTokens", arrayContains: searchQuery.lowercased())
                .order(by: "createdAt", descending: true)
                .limit(to: pageSize)
        }

        if !isInitial, let lastDoc = lastDocument {
            query = query.start(afterDocument: lastDoc)
        }

        do {
            let snapshot = try await query.getDocuments()
            let newItems = snapshot.documents.compactMap { doc -> PushItem? in
                try? doc.data(as: PushItem.self)
            }

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

    func openURL(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        UIApplication.shared.open(url)
    }

    func copyToClipboard(_ urlString: String) {
        UIPasteboard.general.string = urlString
    }

    func logout() {
        do {
            try Auth.auth().signOut()
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
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
