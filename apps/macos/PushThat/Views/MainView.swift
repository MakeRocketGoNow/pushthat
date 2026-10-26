import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct MainView: View {
    @EnvironmentObject var authViewModel: AuthViewModel
    @StateObject private var viewModel = PushListViewModel()
    @State private var searchText = ""
    @State private var isDragOver = false
    @State private var showPlan = false
    @State private var showChangePassword = false
    @State private var confirmNewRecoveryKey = false

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.pushItems.isEmpty && !viewModel.isLoading {
                    emptyStateView
                } else {
                    pushListView
                }
            }
            .navigationTitle("PushThat")
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    leadingToolbarContent
                }

                ToolbarItemGroup(placement: .automatic) {
                    trailingToolbarContent
                }
            }
            .searchable(
                text: $searchText,
                prompt: "Search pushes..."
            )
            .onChange(of: searchText) { _, newValue in
                viewModel.search(query: newValue)
            }
            .sheet(isPresented: $showPlan) {
                PlanView()
                    .frame(minWidth: 360, minHeight: 320)
            }
            .accountSettings(
                authViewModel: authViewModel,
                showChangePassword: $showChangePassword,
                confirmNewRecoveryKey: $confirmNewRecoveryKey
            )
            .alert("Error", isPresented: $viewModel.showError) {
                Button("OK") {}
            } message: {
                Text(viewModel.errorMessage)
            }
            .confirmationDialog(
                "Delete \(viewModel.selectedItems.count) item(s)?",
                isPresented: $viewModel.showDeleteConfirmation,
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    viewModel.deleteSelected()
                }
                Button("Cancel", role: .cancel) {}
            }
            .photosPicker(
                isPresented: $viewModel.showPhotoPicker,
                selection: $viewModel.selectedPhoto,
                matching: .any(of: [.images, .videos])
            )
            .onChange(of: viewModel.selectedPhoto) { _, newValue in
                if newValue != nil {
                    viewModel.uploadSelectedPhoto()
                }
            }
            .fileImporter(
                isPresented: $viewModel.showFilePicker,
                allowedContentTypes: [.item],
                allowsMultipleSelection: false
            ) { result in
                switch result {
                case .success(let urls):
                    if let url = urls.first {
                        viewModel.uploadFile(from: url)
                    }
                case .failure(let error):
                    viewModel.errorMessage = error.localizedDescription
                    viewModel.showError = true
                }
            }
            .overlay {
                if viewModel.isUploading {
                    uploadingOverlay
                }
            }
            // Drag and drop support
            .onDrop(of: [.fileURL, .url], isTargeted: $isDragOver) { providers in
                handleDrop(providers: providers)
                return true
            }
            .border(isDragOver ? Color.pink200 : Color.clear, width: 3)
        }
    }

    // MARK: - Drag and Drop

    private func handleDrop(providers: [NSItemProvider]) {
        for provider in providers {
            // Handle file URLs
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier) { data, error in
                    if let data = data as? Data,
                       let urlString = String(data: data, encoding: .utf8),
                       let url = URL(string: urlString) {
                        Task { @MainActor in
                            viewModel.uploadFile(from: url)
                        }
                    }
                }
            }
            // Handle web URLs
            else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                provider.loadItem(forTypeIdentifier: UTType.url.identifier) { data, error in
                    if let url = data as? URL {
                        Task { @MainActor in
                            viewModel.saveURL(url.absoluteString)
                        }
                    } else if let data = data as? Data,
                              let urlString = String(data: data, encoding: .utf8) {
                        Task { @MainActor in
                            viewModel.saveURL(urlString)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Uploading Overlay

    private var uploadingOverlay: some View {
        UploadingOverlayView()
    }

    // MARK: - Toolbar Content

    @ViewBuilder
    private var leadingToolbarContent: some View {
        if viewModel.isSelectionMode {
            Button(viewModel.isAllSelected ? "Deselect All" : "Select All") {
                viewModel.toggleSelectAll()
            }
            .font(.subheadline)
        } else {
            Image("Logo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 24, height: 24)
        }
    }

    @ViewBuilder
    private var trailingToolbarContent: some View {
        if viewModel.isSelectionMode {
            Button(action: { viewModel.showDeleteConfirmation = true }) {
                Image(systemName: "trash")
                    .foregroundColor(.red)
            }
            .disabled(viewModel.selectedItems.isEmpty)

            Button("Done") {
                viewModel.exitSelectionMode()
            }
        } else {
            Button(action: { viewModel.showPhotoPicker = true }) {
                Image(systemName: "photo")
            }
            .help("Share Photo")

            Button(action: { viewModel.showFilePicker = true }) {
                Image(systemName: "doc")
            }
            .help("Share File")

            Button(action: { Task { await viewModel.refresh() } }) {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh")

            Menu {
                Button(action: { showPlan = true }) {
                    Label("Plan", systemImage: "star")
                }

                Button(action: { showChangePassword = true }) {
                    Label("Change password", systemImage: "key")
                }

                Button(action: { confirmNewRecoveryKey = true }) {
                    Label("Show a new recovery key", systemImage: "lock.rotation")
                }

                Button(action: { authViewModel.signOut() }) {
                    Label("Logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "link.circle")
                .font(.system(size: 64))
                .foregroundColor(.secondary)

            Text("Waiting for Links")
                .font(.title2)
                .foregroundColor(.secondary)

            Text("Share a URL or file from any app, or drag and drop here")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Spacer()
        }
    }

    // MARK: - Push List

    private var pushListView: some View {
        List {
            ForEach(viewModel.pushItems) { item in
                PushRowView(
                    item: item,
                    isSelectionMode: viewModel.isSelectionMode,
                    isSelected: viewModel.selectedItems.contains(item.id ?? ""),
                    onToggleSelection: { viewModel.toggleSelection(item) },
                    onTap: { viewModel.openURL(item.url) },
                    onLongPress: {
                        if viewModel.isSelectionMode {
                            viewModel.toggleSelection(item)
                        } else {
                            viewModel.enterSelectionMode()
                            viewModel.toggleSelection(item)
                        }
                    },
                    onCopy: { viewModel.copyToClipboard(item.url) }
                )
                .onAppear {
                    // Infinite scroll trigger
                    if item.id == viewModel.pushItems.last?.id {
                        viewModel.loadMore()
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }
            .onDelete { indexSet in
                viewModel.delete(at: indexSet)
            }

            if viewModel.isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
    }
}

#Preview {
    MainView()
        .environmentObject(AuthViewModel())
}

// MARK: - Plan

/// Where the account stands: the tier, this month's usage against its limits, and that
/// plans are managed on the web. Said in one neutral sentence, with no link, address or
/// price: the App Store forbids a call to action for a purchase outside its billing.
struct PlanView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var report: PlanReport?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if let report {
                    List {
                        Section {
                            Text(title(for: report))
                                .font(.title2.bold())
                            if let standing = standing(for: report) {
                                Text(standing)
                            }
                        }
                        Section("This month") {
                            LabeledContent("Links", value: "\(report.usage.url) of \(report.limits.url)")
                            LabeledContent("Files", value: "\(report.usage.file) of \(report.limits.file)")
                            LabeledContent("File size", value: "up to \(report.limits.fileBytes / (1024 * 1024)) MB")
                            LabeledContent("Files kept", value: "\(report.limits.keepDays) days")
                        }
                        Section {
                            Text("Your plan is managed from your PushThat account on the web.")
                                .foregroundColor(.secondary)
                        }
                    }
                } else if failed {
                    VStack(spacing: 12) {
                        Text("Your plan could not be read right now.")
                            .foregroundColor(.secondary)
                        Button("Try again") { Task { await load() } }
                    }
                } else {
                    ProgressView("Reading your plan…")
                }
            }
            .navigationTitle("Plan")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    private func load() async {
        failed = false
        do {
            report = try await PlanService.fetchReport()
        } catch {
            failed = true
        }
    }

    private func title(for report: PlanReport) -> String {
        if report.subscription?.type == "comp" { return "Pro, complimentary" }
        return report.isPro ? "Pro" : "Free"
    }

    private func standing(for report: PlanReport) -> String? {
        guard report.isPro, let sub = report.subscription, sub.type == "pro" else { return nil }
        if let cancelsAt = sub.cancelsAt, let day = day(cancelsAt) { return "Pro ends on \(day)." }
        if let expiresAt = sub.expiresAt, let day = day(expiresAt) { return "Renews on \(day)." }
        return nil
    }

    private func day(_ iso: String) -> String? {
        guard let date = ISO8601DateFormatter.withFractionalSeconds.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        return date.formatted(date: .long, time: .omitted)
    }
}

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
