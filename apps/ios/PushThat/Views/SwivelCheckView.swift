import SwiftUI

/// Custom 3D flip checkbox that shows a favicon on the front and a checkmark on the back
/// Matches the Android SwivelCheckView behavior
struct SwivelCheckView: View {
    /// What the front shows.
    enum IconSource: Equatable {
        /// An image of ours, loaded as it is (the file-type icons on pushthat.link).
        case firstParty(URL)
        /// A pushed link: its site's own icon, found on the device (`FaviconResolver`).
        case site(URL)
    }

    let isChecked: Bool
    let icon: IconSource?
    var fallbackIcon: String = "link.circle.fill"

    @State private var rotation: Double = 0

    var body: some View {
        ZStack {
            // Front side - Favicon/Icon
            frontSide
                .opacity(rotation < 90 ? 1 : 0)

            // Back side - Checkmark
            backSide
                .opacity(rotation >= 90 ? 1 : 0)
                .scaleEffect(x: -1, y: 1) // Mirror to appear correct after flip
        }
        .rotation3DEffect(
            .degrees(rotation),
            axis: (x: 0, y: 1, z: 0),
            perspective: 0.5
        )
        .onChange(of: isChecked) { _, newValue in
            withAnimation(.easeInOut(duration: 0.32)) {
                rotation = newValue ? 180 : 0
            }
        }
        .onAppear {
            // Set initial state without animation
            rotation = isChecked ? 180 : 0
        }
    }

    // MARK: - Front Side (Favicon)

    private var frontSide: some View {
        Group {
            switch icon {
            case .site(let site):
                SiteIconView(site: site) { fallbackIconView }
            case .firstParty(let url):
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .empty:
                        ProgressView()
                            .frame(width: 40, height: 40)
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    case .failure:
                        fallbackIconView
                    @unknown default:
                        fallbackIconView
                    }
                }
            case nil:
                fallbackIconView
            }
        }
    }

    private var fallbackIconView: some View {
        Image(systemName: fallbackIcon)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .foregroundColor(.secondary)
            .padding(8)
    }

    // MARK: - Back Side (Checkmark)

    private var backSide: some View {
        Image(systemName: "checkmark.circle.fill")
            .resizable()
            .aspectRatio(contentMode: .fit)
            .foregroundColor(.pink200)
    }
}

#Preview {
    VStack(spacing: 20) {
        // Unchecked state
        SwivelCheckView(
            isChecked: false,
            icon: .site(URL(string: "https://example.com")!)
        )
        .frame(width: 40, height: 40)

        // Checked state
        SwivelCheckView(
            isChecked: true,
            icon: .site(URL(string: "https://example.com")!)
        )
        .frame(width: 40, height: 40)

        // With file icon
        SwivelCheckView(
            isChecked: false,
            icon: .firstParty(URL(string: "https://pushthat.link/files/pdf.png")!),
            fallbackIcon: "doc.fill"
        )
        .frame(width: 40, height: 40)

        // Interactive demo
        SwivelCheckViewDemo()
    }
    .padding()
}

struct SwivelCheckViewDemo: View {
    @State private var isChecked = false

    var body: some View {
        VStack {
            SwivelCheckView(
                isChecked: isChecked,
                icon: .site(URL(string: "https://example.org")!)
            )
            .frame(width: 64, height: 64)
            .onTapGesture {
                isChecked.toggle()
            }

            Text("Tap to toggle")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }
}
