import SwiftUI

/// Full-screen overlay showing a spinning logo during upload
/// Matches the UI of the share extension
struct UploadingOverlayView: View {
    @State private var isRotating = false

    var body: some View {
        ZStack {
            // Black background matching share extension
            Color.black
                .ignoresSafeArea()

            VStack(spacing: 24) {
                // Spinning logo
                Image("Logo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 144, height: 144)
                    .rotationEffect(.degrees(isRotating ? 360 : 0))
                    .animation(
                        .linear(duration: 1.5)
                        .repeatForever(autoreverses: false),
                        value: isRotating
                    )

                Text("Uploading...")
                    .font(.headline)
                    .foregroundColor(.white.opacity(0.8))
            }
        }
        .onAppear {
            isRotating = true
        }
    }
}

#Preview {
    UploadingOverlayView()
}
