import Foundation
import FirebaseAuth
import FirebaseFirestore
import FirebaseStorage
import UniformTypeIdentifiers
import AppKit
import SwiftUI
import PhotosUI

/// Service for uploading files and images to Firebase Storage and creating push documents
@MainActor
class UploadService: ObservableObject {

    static let shared = UploadService()

    @Published var isUploading = false
    @Published var uploadError: String?

    private let db = Firestore.firestore()
    private let storage = Storage.storage()

    private init() {}

    // MARK: - Public Upload Methods

    /// Upload a photo from PhotosPicker
    func uploadPhoto(_ photoItem: PhotosPickerItem, completion: @escaping (Bool) -> Void) {
        guard let userId = Auth.auth().currentUser?.uid else {
            uploadError = "Please sign in first"
            completion(false)
            return
        }

        isUploading = true
        uploadError = nil

        Task {
            do {
                // Try to load as Data with the original format
                if let data = try await photoItem.loadTransferable(type: Data.self) {
                    // Generate filename based on content type
                    let fileName = generatePhotoFileName(from: photoItem)

                    let pro = await PlanService.isPro(userId: userId)
                    if FileUploadUtils.exceedsMaxFileSize(data, isPro: pro) {
                        await MainActor.run {
                            uploadError = FileUploadUtils.tooLargeMessage("Photo", isPro: pro)
                            isUploading = false
                        }
                        completion(false)
                        return
                    }

                    await uploadFileData(data: data, fileName: fileName, userId: userId, completion: completion)
                } else {
                    await MainActor.run {
                        uploadError = "Failed to load photo"
                        isUploading = false
                    }
                    completion(false)
                }
            } catch {
                await MainActor.run {
                    uploadError = "Failed to load photo: \(error.localizedDescription)"
                    isUploading = false
                }
                completion(false)
            }
        }
    }

    /// Upload a file from file importer
    func uploadFile(from url: URL, completion: @escaping (Bool) -> Void) {
        guard let userId = Auth.auth().currentUser?.uid else {
            uploadError = "Please sign in first"
            completion(false)
            return
        }

        isUploading = true
        uploadError = nil

        // Start accessing security-scoped resource
        let accessing = url.startAccessingSecurityScopedResource()

        // Read the data synchronously while we have access
        let data: Data
        let fileName: String
        do {
            data = try Data(contentsOf: url)
            fileName = url.lastPathComponent
        } catch {
            if accessing {
                url.stopAccessingSecurityScopedResource()
            }
            uploadError = "Failed to read file: \(error.localizedDescription)"
            isUploading = false
            completion(false)
            return
        }

        // Release security-scoped access now that we have the data
        if accessing {
            url.stopAccessingSecurityScopedResource()
        }

        Task {
            // The tier's file size, which the Storage rules enforce; said here before the upload starts.
            let pro = await PlanService.isPro(userId: userId)
            if FileUploadUtils.exceedsMaxFileSize(data, isPro: pro) {
                uploadError = FileUploadUtils.tooLargeMessage("File", isPro: pro)
                isUploading = false
                completion(false)
                return
            }
            await uploadFileData(data: data, fileName: fileName, userId: userId, completion: completion)
        }
    }

    // MARK: - Private Upload Methods

    private func uploadFileData(data: Data, fileName: String, userId: String, completion: @escaping (Bool) -> Void) async {
        do {
            _ = try await FileUploadUtils.uploadFileAndCreateDocument(
                data: data,
                fileName: fileName,
                userId: userId,
                storage: storage,
                firestore: db
            )

            await MainActor.run {
                isUploading = false
            }
            completion(true)
        } catch {
            await MainActor.run {
                uploadError = "Upload failed: \(error.localizedDescription)"
                isUploading = false
            }
            completion(false)
        }
    }

    // MARK: - Helpers

    /// Generate a filename based on timestamp and content type
    private func generatePhotoFileName(from item: PhotosPickerItem) -> String {
        // Check supported content types to determine extension
        if let supportedType = item.supportedContentTypes.first {
            return FileUploadUtils.generateImageFileName(for: supportedType)
        }
        return FileUploadUtils.generateDefaultImageFileName()
    }
}
