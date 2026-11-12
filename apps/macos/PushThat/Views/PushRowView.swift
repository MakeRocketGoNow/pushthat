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
                image: icon,
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

    /// What the row draws, all of it already on the device: nothing is fetched to draw a
    /// row (docs/e2ee.md, "Icons"). A URL push draws the icon that came in it, else the
    /// icon for its `ext` from the asset catalog (a link to a file has no page to take an
    /// icon from); a file push draws its type's icon. Nil draws the placeholder a locked
    /// push draws, also for an icon that does not decode. The order is the same on every
    /// client.
    ///
    /// This was Google's favicon service for every link, which learned the host of each
    /// pushed link whenever the list was drawn, and pushthat.link for file types, whose logs
    /// learned the type of each encrypted file.
    private var icon: Image? {
        // A locked push shows the placeholder: there is nothing it can be known by.
        if item.isLocked { return nil }
        if item.type == .url, let icon = item.icon, let image = PushIcon.image(icon) {
            return Image(decorative: image, scale: 1)
        }
        return FileTypeIcons.assetName(for: item.ext).map { Image($0) }
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
