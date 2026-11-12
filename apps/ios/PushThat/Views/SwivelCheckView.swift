import SwiftUI

/// Custom 3D flip checkbox that shows a favicon on the front and a checkmark on the back
/// Matches the Android SwivelCheckView behavior
///
/// It takes an image the caller already holds, not a URL: drawing a row fetches nothing
/// (docs/e2ee.md, "Icons"). `fallbackIcon` is drawn when there is none.
struct SwivelCheckView: View {
    let isChecked: Bool
    let image: Image?
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
            if let image {
                image
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
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
        // Unchecked state, with no icon: the placeholder
        SwivelCheckView(isChecked: false, image: nil)
            .frame(width: 40, height: 40)

        // Checked state
        SwivelCheckView(isChecked: true, image: nil)
            .frame(width: 40, height: 40)

        // With file icon
        SwivelCheckView(isChecked: false, image: Image("file-pdf"), fallbackIcon: "doc.fill")
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
            SwivelCheckView(isChecked: isChecked, image: Image("file-zip"))
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
