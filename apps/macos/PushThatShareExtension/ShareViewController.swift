import Cocoa
import UniformTypeIdentifiers
import FirebaseCore
import FirebaseAuth
import FirebaseFirestore
import FirebaseStorage

class ShareViewController: NSViewController {

    private lazy var db: Firestore = {
        let firestore = Firestore.firestore()
        return firestore
    }()
    private lazy var storage = Storage.storage()

    private var logoImageView: NSImageView!
    /// Whether the account is Pro, read once per share before anything is sized: the tier picks the largest file.
    private var isPro = false
    private var rotationAngle: CGFloat = 0
    private var rotationTimer: Timer?

    override func loadView() {
        self.view = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 200))
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        // Configure Firebase for extension
        if FirebaseApp.app() == nil {
            FirebaseApp.configure()

            // Configure Firebase Auth to use shared keychain for app extension support
            let keychainAccessGroup = "$(TeamIdentifierPrefix)com.makerocketgonow.pushthatapp"
            do {
                try Auth.auth().useUserAccessGroup(keychainAccessGroup)
            } catch {
                print("Failed to configure shared keychain for Auth: \(error)")
            }

            // Disable Firestore persistence in share extension to avoid LevelDB lock conflicts
            // when both the main app and extension try to access the database
            let settings = FirestoreSettings()
            settings.cacheSettings = MemoryCacheSettings()
            Firestore.firestore().settings = settings
        }

        setupUI()
        processSharedContent()
    }

    // MARK: - UI Setup

    private func setupUI() {
        // Black background to match Android
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.black.cgColor

        // Load logo image
        if let logoImage = NSImage(named: "Logo") {
            logoImageView = NSImageView(image: logoImage)
            logoImageView.imageScaling = .scaleProportionallyUpOrDown
        } else {
            // Fallback if image not found
            logoImageView = NSImageView()
            logoImageView.wantsLayer = true
            logoImageView.layer?.backgroundColor = NSColor.systemGray.cgColor
            logoImageView.layer?.cornerRadius = 36
        }

        logoImageView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(logoImageView)

        NSLayoutConstraint.activate([
            logoImageView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            logoImageView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            logoImageView.widthAnchor.constraint(equalToConstant: 72),
            logoImageView.heightAnchor.constraint(equalToConstant: 72)
        ])

        // Start spinning animation
        startRotation()
    }

    private func startRotation() {
        logoImageView.wantsLayer = true
        rotationTimer = Timer.scheduledTimer(withTimeInterval: 0.016, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.rotationAngle += 4 // degrees per frame
            if self.rotationAngle >= 360 {
                self.rotationAngle = 0
            }
            self.logoImageView.layer?.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            self.logoImageView.layer?.position = CGPoint(
                x: self.logoImageView.frame.midX,
                y: self.logoImageView.frame.midY
            )
            self.logoImageView.layer?.transform = CATransform3DMakeRotation(
                self.rotationAngle * .pi / 180,
                0, 0, 1
            )
        }
    }

    private func stopRotation() {
        rotationTimer?.invalidate()
        rotationTimer = nil
    }

    // MARK: - Content Processing

    private func processSharedContent() {
        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = extensionItem.attachments, !attachments.isEmpty else {
            completeWithError("No content to share")
            return
        }

        // Check if user is authenticated
        guard let userId = Auth.auth().currentUser?.uid else {
            completeWithError("Please sign in to PushThat first")
            return
        }

        // Process all attachments
        // The tier first, since every size check below depends on it; then the attachments.
        Task {
            self.isPro = await PlanService.isPro(userId: userId)
            self.processAttachments(attachments, userId: userId, index: 0)
        }
    }

    private func processAttachments(_ attachments: [NSItemProvider], userId: String, index: Int) {
        guard index < attachments.count else {
            // All attachments processed successfully
            completeSuccessfully()
            return
        }

        let itemProvider = attachments[index]

        // Determine the type and handle accordingly
        // Check for PDF first since Safari may provide PDFs with both URL and PDF type identifiers
        if itemProvider.hasItemConformingToTypeIdentifier(UTType.pdf.identifier) {
            handlePDF(itemProvider: itemProvider, userId: userId) { [weak self] success in
                if success {
                    self?.processAttachments(attachments, userId: userId, index: index + 1)
                }
            }
        } else if itemProvider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            handleURL(itemProvider: itemProvider, userId: userId) { [weak self] success in
                if success {
                    self?.processAttachments(attachments, userId: userId, index: index + 1)
                }
            }
        } else if itemProvider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            handleText(itemProvider: itemProvider, userId: userId) { [weak self] success in
                if success {
                    self?.processAttachments(attachments, userId: userId, index: index + 1)
                }
            }
        } else if itemProvider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            handleImage(itemProvider: itemProvider, userId: userId) { [weak self] success in
                if success {
                    self?.processAttachments(attachments, userId: userId, index: index + 1)
                }
            }
        } else if itemProvider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            handleMovie(itemProvider: itemProvider, userId: userId) { [weak self] success in
                if success {
                    self?.processAttachments(attachments, userId: userId, index: index + 1)
                }
            }
        } else if itemProvider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            handleFile(itemProvider: itemProvider, userId: userId) { [weak self] success in
                if success {
                    self?.processAttachments(attachments, userId: userId, index: index + 1)
                }
            }
        } else if itemProvider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            handleFile(itemProvider: itemProvider, userId: userId) { [weak self] success in
                if success {
                    self?.processAttachments(attachments, userId: userId, index: index + 1)
                }
            }
        } else {
            completeWithError("Unsupported content type")
        }
    }

    // MARK: - URL Handling

    private func handleURL(itemProvider: NSItemProvider, userId: String, completion: @escaping (Bool) -> Void) {
        itemProvider.loadItem(forTypeIdentifier: UTType.url.identifier) { [weak self] data, error in
            guard let self = self else { return }

            if let error = error {
                self.completeWithError("Failed to load URL: \(error.localizedDescription)")
                completion(false)
                return
            }

            guard let url = data as? URL else {
                self.completeWithError("Failed to load URL")
                completion(false)
                return
            }

            // If it's a file URL, handle as file upload
            if url.isFileURL {
                do {
                    let fileData = try Data(contentsOf: url)
                    let fileName = url.lastPathComponent

                    if FileUploadUtils.exceedsMaxFileSize(fileData, isPro: self.isPro) {
                        self.completeWithError(FileUploadUtils.tooLargeMessage("File", isPro: self.isPro))
                        completion(false)
                        return
                    }

                    self.uploadFile(data: fileData, fileName: fileName, userId: userId, type: "file", completion: completion)
                } catch {
                    self.completeWithError("Failed to read file: \(error.localizedDescription)")
                    completion(false)
                }
                return
            }

            // Otherwise it's a web URL
            self.saveURLPush(url: url.absoluteString, userId: userId, completion: completion)
        }
    }

    // MARK: - PDF Handling

    private func handlePDF(itemProvider: NSItemProvider, userId: String, completion: @escaping (Bool) -> Void) {
        itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.pdf.identifier) { [weak self] url, error in
            guard let self = self else { return }

            if let error = error {
                self.completeWithError("Failed to load PDF: \(error.localizedDescription)")
                completion(false)
                return
            }

            guard let url = url else {
                self.completeWithError("Failed to load PDF")
                completion(false)
                return
            }

            do {
                let pdfData = try Data(contentsOf: url)

                // Check file size
                if FileUploadUtils.exceedsMaxFileSize(pdfData, isPro: self.isPro) {
                    self.completeWithError(FileUploadUtils.tooLargeMessage("PDF", isPro: self.isPro))
                    completion(false)
                    return
                }

                // Use original filename or suggestedName, or generate one
                let fileName: String
                if !url.lastPathComponent.isEmpty && !url.lastPathComponent.hasPrefix(".") {
                    fileName = url.lastPathComponent
                } else if let suggested = itemProvider.suggestedName, !suggested.isEmpty {
                    // Add .pdf extension if missing
                    if (suggested as NSString).pathExtension.lowercased() != "pdf" {
                        fileName = suggested + ".pdf"
                    } else {
                        fileName = suggested
                    }
                } else {
                    fileName = "document_\(Int(Date().timeIntervalSince1970)).pdf"
                }

                self.uploadFile(data: pdfData, fileName: fileName, userId: userId, type: "file", completion: completion)
            } catch {
                self.completeWithError("Failed to read PDF: \(error.localizedDescription)")
                completion(false)
            }
        }
    }

    private func handleText(itemProvider: NSItemProvider, userId: String, completion: @escaping (Bool) -> Void) {
        itemProvider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { [weak self] data, error in
            guard let self = self else { return }

            if let error = error {
                self.completeWithError("Failed to load text: \(error.localizedDescription)")
                completion(false)
                return
            }

            guard let text = data as? String else {
                self.completeWithError("Failed to load text")
                completion(false)
                return
            }

            // Check if text is a valid URL
            var urlString = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !urlString.hasPrefix("http://") && !urlString.hasPrefix("https://") {
                urlString = "https://\(urlString)"
            }

            guard URL(string: urlString) != nil else {
                self.completeWithError("Invalid URL")
                completion(false)
                return
            }

            self.saveURLPush(url: urlString, userId: userId, completion: completion)
        }
    }

    // MARK: - Image Handling

    private func handleImage(itemProvider: NSItemProvider, userId: String, completion: @escaping (Bool) -> Void) {
        // Try specific image types for better quality
        let imageTypes = [UTType.png, UTType.jpeg, UTType.heic, UTType.gif, UTType.webP]

        for imageType in imageTypes {
            if itemProvider.hasItemConformingToTypeIdentifier(imageType.identifier) {
                itemProvider.loadFileRepresentation(forTypeIdentifier: imageType.identifier) { [weak self] url, error in
                    guard let self = self else { return }

                    if let error = error {
                        self.completeWithError("Failed to load image: \(error.localizedDescription)")
                        completion(false)
                        return
                    }

                    guard let url = url else {
                        self.completeWithError("Failed to load image")
                        completion(false)
                        return
                    }

                    do {
                        let imageData = try Data(contentsOf: url)

                        // Check file size
                        if FileUploadUtils.exceedsMaxFileSize(imageData, isPro: self.isPro) {
                            self.completeWithError(FileUploadUtils.tooLargeMessage("Image", isPro: self.isPro))
                            completion(false)
                            return
                        }

                        // Use original filename from URL, or suggestedName, or generate one
                        let fileName: String
                        if !url.lastPathComponent.isEmpty && !url.lastPathComponent.hasPrefix(".")  {
                            fileName = url.lastPathComponent
                        } else if let suggested = itemProvider.suggestedName, !suggested.isEmpty {
                            // Add extension if missing
                            if (suggested as NSString).pathExtension.isEmpty {
                                fileName = suggested + "." + (imageType.preferredFilenameExtension ?? "jpg")
                            } else {
                                fileName = suggested
                            }
                        } else {
                            fileName = FileUploadUtils.generateImageFileName(for: imageType)
                        }

                        self.uploadFile(data: imageData, fileName: fileName, userId: userId, type: "file", completion: completion)
                    } catch {
                        self.completeWithError("Failed to read image: \(error.localizedDescription)")
                        completion(false)
                    }
                }
                return
            }
        }

        // Fallback to generic image type
        itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { [weak self] url, error in
            guard let self = self else { return }

            if let error = error {
                self.completeWithError("Failed to load image: \(error.localizedDescription)")
                completion(false)
                return
            }

            guard let url = url else {
                self.completeWithError("Failed to load image")
                completion(false)
                return
            }

            do {
                let imageData = try Data(contentsOf: url)

                // Check file size
                if FileUploadUtils.exceedsMaxFileSize(imageData, isPro: self.isPro) {
                    self.completeWithError(FileUploadUtils.tooLargeMessage("Image", isPro: self.isPro))
                    completion(false)
                    return
                }

                let fileName: String
                if !url.lastPathComponent.isEmpty && !url.lastPathComponent.hasPrefix(".") {
                    fileName = url.lastPathComponent
                } else if let suggested = itemProvider.suggestedName, !suggested.isEmpty {
                    fileName = suggested + ".jpg"
                } else {
                    fileName = FileUploadUtils.generateDefaultImageFileName()
                }

                self.uploadFile(data: imageData, fileName: fileName, userId: userId, type: "file", completion: completion)
            } catch {
                self.completeWithError("Failed to read image: \(error.localizedDescription)")
                completion(false)
            }
        }
    }

    // MARK: - Movie/Video Handling

    private func handleMovie(itemProvider: NSItemProvider, userId: String, completion: @escaping (Bool) -> Void) {
        // Try specific video types
        let videoTypes = [UTType.mpeg4Movie, UTType.quickTimeMovie, UTType.movie]

        for videoType in videoTypes {
            if itemProvider.hasItemConformingToTypeIdentifier(videoType.identifier) {
                itemProvider.loadFileRepresentation(forTypeIdentifier: videoType.identifier) { [weak self] url, error in
                    guard let self = self else { return }

                    if let error = error {
                        self.completeWithError("Failed to load video: \(error.localizedDescription)")
                        completion(false)
                        return
                    }

                    guard let url = url else {
                        self.completeWithError("Failed to load video")
                        completion(false)
                        return
                    }

                    // Copy file to temp location since the URL is only valid during this callback
                    let tempURL = FileManager.default.temporaryDirectory
                        .appendingPathComponent(UUID().uuidString)
                        .appendingPathExtension(url.pathExtension)

                    do {
                        try FileManager.default.copyItem(at: url, to: tempURL)
                        let videoData = try Data(contentsOf: tempURL)

                        // Check file size
                        if FileUploadUtils.exceedsMaxFileSize(videoData, isPro: self.isPro) {
                            try? FileManager.default.removeItem(at: tempURL)
                            self.completeWithError(FileUploadUtils.tooLargeMessage("Video", isPro: self.isPro))
                            completion(false)
                            return
                        }

                        let fileName = url.lastPathComponent.isEmpty ? "video_\(Int(Date().timeIntervalSince1970)).\(url.pathExtension)" : url.lastPathComponent
                        self.uploadFile(data: videoData, fileName: fileName, userId: userId, type: "file") { success in
                            try? FileManager.default.removeItem(at: tempURL)
                            completion(success)
                        }
                    } catch {
                        self.completeWithError("Failed to process video: \(error.localizedDescription)")
                        completion(false)
                    }
                }
                return
            }
        }

        completeWithError("Unsupported video format")
        completion(false)
    }

    // MARK: - File Handling

    private func handleFile(itemProvider: NSItemProvider, userId: String, completion: @escaping (Bool) -> Void) {
        let typeIdentifier = itemProvider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier)
            ? UTType.fileURL.identifier
            : UTType.data.identifier

        itemProvider.loadItem(forTypeIdentifier: typeIdentifier) { [weak self] data, error in
            guard let self = self else { return }

            if let error = error {
                self.completeWithError("Failed to load file: \(error.localizedDescription)")
                completion(false)
                return
            }

            var fileData: Data?
            var fileName: String = "file"

            if let url = data as? URL {
                fileName = url.lastPathComponent
                fileData = try? Data(contentsOf: url)
            } else if let data = data as? Data {
                fileData = data
                fileName = "shared_file"
            }

            guard let data = fileData else {
                self.completeWithError("Failed to load file data")
                completion(false)
                return
            }

            // Check file size
            if FileUploadUtils.exceedsMaxFileSize(data, isPro: self.isPro) {
                self.completeWithError(FileUploadUtils.tooLargeMessage("File", isPro: self.isPro))
                completion(false)
                return
            }

            self.uploadFile(data: data, fileName: fileName, userId: userId, type: "file", completion: completion)
        }
    }

    // MARK: - Firebase Operations

    private func saveURLPush(url: String, userId: String, completion: @escaping (Bool) -> Void) {
        FileUploadUtils.createURLPushDocument(firestore: db, url: url, userId: userId) { [weak self] result in
            switch result {
            case .success:
                completion(true)
            case .failure(let error):
                self?.completeWithError("Failed to save: \(error.localizedDescription)")
                completion(false)
            }
        }
    }

    private func uploadFile(data: Data, fileName: String, userId: String, type: String, completion: @escaping (Bool) -> Void) {
        FileUploadUtils.uploadFileAndCreateDocument(
            data: data,
            fileName: fileName,
            userId: userId,
            type: type,
            storage: storage,
            firestore: db
        ) { [weak self] result in
            switch result {
            case .success:
                completion(true)
            case .failure(let error):
                self?.completeWithError("Upload failed: \(error.localizedDescription)")
                completion(false)
            }
        }
    }

    // MARK: - Completion

    private func completeSuccessfully() {
        DispatchQueue.main.async {
            // Keep logo spinning, just close after a brief delay
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.stopRotation()
                self.extensionContext?.completeRequest(returningItems: nil)
            }
        }
    }

    private func completeWithError(_ message: String) {
        DispatchQueue.main.async {
            // Stop the spinning animation
            self.stopRotation()

            // Show alert with error message
            let alert = NSAlert()
            alert.messageText = "Error"
            alert.informativeText = message
            alert.alertStyle = .warning
            alert.addButton(withTitle: "OK")

            alert.beginSheetModal(for: self.view.window!) { _ in
                let error = NSError(domain: "PushThat", code: 0, userInfo: [NSLocalizedDescriptionKey: message])
                self.extensionContext?.cancelRequest(withError: error)
            }
        }
    }
}
