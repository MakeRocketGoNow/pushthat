import SwiftUI

struct PushRowView: View {
    let item: PushItem
    let isSelectionMode: Bool
    let isSelected: Bool
    let onToggleSelection: () -> Void
    let onTap: () -> Void
    let onLongPress: () -> Void
    let onCopy: () -> Void

    @State private var showCopiedToast = false

    var body: some View {
        HStack(spacing: 12) {
            // Swivel checkbox / favicon
            SwivelCheckView(
                isChecked: isSelected,
                imageURL: faviconURL,
                fallbackIcon: item.type == .file ? "doc.fill" : "link.circle.fill"
            )
            .frame(width: 40, height: 40)
            .onTapGesture {
                if isSelectionMode {
                    onToggleSelection()
                }
            }

            // Content
            VStack(alignment: .leading, spacing: 4) {
                Text(displayTitle)
                    .font(.body)
                    .lineLimit(2)
                    .foregroundColor(.primary)

                HStack(spacing: 8) {
                    if item.type == .file && !item.isLocked {
                        Label(item.ext?.uppercased() ?? "FILE", systemImage: "doc")
                            .font(.caption2)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.secondary.opacity(0.2))
                            .cornerRadius(4)
                    }

                    Text(relativeTime)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            Spacer()

            // Selection indicator
            if isSelectionMode {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(isSelected ? .pink200 : .secondary)
                    .font(.title2)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            if isSelectionMode {
                onToggleSelection()
            } else {
                onTap()
            }
        }
        .onLongPressGesture {
            onLongPress()
        }
        .contextMenu {
            if !item.isLocked {
                Button(action: onTap) {
                    Label("Open", systemImage: "safari")
                }
            }

            // An encrypted file push has no URL; its name is what there is to copy. A
            // locked push has nothing.
            if item.copyText != nil {
                Button(action: {
                    onCopy()
                    showCopiedToast = true
                }) {
                    Label(item.url.isEmpty ? "Copy name" : "Copy URL", systemImage: "doc.on.doc")
                }
            }

            if !isSelectionMode {
                Button(action: onLongPress) {
                    Label("Select", systemImage: "checkmark.circle")
                }
            }
        }
        .overlay(alignment: .bottom) {
            if showCopiedToast {
                Text("Copied to clipboard")
                    .font(.caption)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.8))
                    .foregroundColor(.white)
                    .cornerRadius(8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            withAnimation {
                                showCopiedToast = false
                            }
                        }
                    }
            }
        }
        .animation(.easeInOut(duration: 0.2), value: showCopiedToast)
    }

    // MARK: - Computed Properties

    private var displayTitle: String {
        item.displayTitle
    }

    private var relativeTime: String {
        guard let date = item.createdAt else { return "" }
        return date.relativeFormatted()
    }

    private var faviconURL: URL? {
        // A locked push shows the placeholder: there is no URL or name to show one for.
        if item.isLocked { return nil }

        // Check for file extension icon first
        if let ext = item.ext, FileTypeIcons.supported.contains(ext.lowercased()) {
            return URL(string: "https://pushthat.link/files/\(ext.lowercased()).png")
        }

        // Fall back to Google favicon service
        guard let urlHost = URL(string: item.url)?.host else { return nil }
        return URL(string: "https://www.google.com/s2/favicons?domain=\(urlHost)&sz=256")
    }
}

#Preview {
    VStack {
        PushRowView(
            item: PushItem(
                id: "1",
                url: "https://github.com",
                userId: "user1",
                createdAt: Date(),
                title: "GitHub: Let's build from here",
                type: .url
            ),
            isSelectionMode: false,
            isSelected: false,
            onToggleSelection: {},
            onTap: {},
            onLongPress: {},
            onCopy: {}
        )

        PushRowView(
            item: PushItem(
                id: "2",
                url: "https://example.com/file.pdf",
                userId: "user1",
                createdAt: Date().addingTimeInterval(-3600),
                title: "Important Document.pdf",
                type: .file,
                ext: "pdf"
            ),
            isSelectionMode: true,
            isSelected: true,
            onToggleSelection: {},
            onTap: {},
            onLongPress: {},
            onCopy: {}
        )
    }
    .padding()
}
