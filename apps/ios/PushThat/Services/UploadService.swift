import Foundation
import FirebaseAuth
import FirebaseFirestore
import FirebaseStorage
import UniformTypeIdentifiers
import UIKit
import SwiftUI
import PhotosUI
import Photos

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
                    // Try to get original filename from PhotoKit, fall back to generated name
                    let fileName = await getOriginalFileName(from: photoItem)
                        ?? generatePhotoFileName(from: photoItem)

                    let pro = (await PlanService.isPro(userId: userId)) ?? true
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
            let pro = (await PlanService.isPro(userId: userId)) ?? true
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

    /// Try to get the original filename from PhotoKit using the asset identifier
    private func getOriginalFileName(from item: PhotosPickerItem) async -> String? {
        guard let assetId = item.itemIdentifier else { return nil }

        let fetchResult = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)
        guard let asset = fetchResult.firstObject else { return nil }

        let resources = PHAssetResource.assetResources(for: asset)
        // Prefer the original filename from the primary resource
        if let originalResource = resources.first(where: { $0.type == .photo || $0.type == .video }) {
            return originalResource.originalFilename
        }
        return resources.first?.originalFilename
    }

    /// Fallback: generate a filename based on timestamp and content type
    private func generatePhotoFileName(from item: PhotosPickerItem) -> String {
        // Check supported content types to determine extension
        if let supportedType = item.supportedContentTypes.first {
            return FileUploadUtils.generateImageFileName(for: supportedType)
        }
        return FileUploadUtils.generateDefaultImageFileName()
    }

}
