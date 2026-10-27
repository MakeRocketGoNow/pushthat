import Foundation
import BackgroundTasks
import FirebaseFirestore
import FirebaseStorage
import SwiftData

/// Manages background retry of failed push uploads
class RetryManager {
    static let shared = RetryManager()
    static let taskIdentifier = "com.makerocketgonow.pushthat.retry"

    private let db = Firestore.firestore()

    private init() {}

    // MARK: - Background Task Registration

    /// Register the background task with the system
    /// Call this in AppDelegate didFinishLaunchingWithOptions
    func registerBackgroundTask() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: Self.taskIdentifier,
            using: nil
        ) { [weak self] task in
            self?.handleBackgroundTask(task: task as! BGProcessingTask)
        }
    }

    /// Schedule the next background retry task
    func scheduleBackgroundTask() {
        let request = BGProcessingTaskRequest(identifier: Self.taskIdentifier)
        request.requiresNetworkConnectivity = true
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // 15 minutes

        do {
            try BGTaskScheduler.shared.submit(request)
            print("Background retry task scheduled")
        } catch {
            print("Failed to schedule background task: \(error)")
        }
    }

    // MARK: - Task Handling

    private func handleBackgroundTask(task: BGProcessingTask) {
        // Schedule the next occurrence
        scheduleBackgroundTask()

        let operation = BlockOperation { [weak self] in
            self?.retryPendingPushes()
        }

        task.expirationHandler = {
            operation.cancel()
        }

        operation.completionBlock = {
            task.setTaskCompleted(success: !operation.isCancelled)
        }

        OperationQueue().addOperation(operation)
    }

    // MARK: - Retry Logic

    /// Retry all pending pushes stored in the local database.
    ///
    /// A prepared push is written as it was sealed: the same id and ciphertext on every
    /// attempt. One queued before the encryption update is sealed now under a new id, and
    /// waits while this device holds no key. A refusal by the rules is final (a key a
    /// reset replaced, a push over a limit): the push is dropped and a file's upload with
    /// it, unless the push turns out to exist already, which is an earlier attempt that
    /// landed after all and whose object must stay.
    func retryPendingPushes() {
        Task {
            do {
                let container = try ModelContainer(for: PendingPush.self)
                let context = ModelContext(container)

                let descriptor = FetchDescriptor<PendingPush>()
                let pendingPushes = try context.fetch(descriptor)

                for pending in pendingPushes {
                    do {
                        guard let push = try preparedPush(for: pending, in: context) else { continue }
                        do {
                            try await PushDocuments.create(push, firestore: db)
                        } catch where PushDocuments.isPermissionDenied(error) {
                            // Not known yet whether it landed: the row stays for the next run.
                            guard await dropRefused(push) else { continue }
                        }
                        context.delete(pending)
                        try context.save()
                    } catch {
                        print("Failed to retry push: \(error)")
                    }
                }
            } catch {
                print("Failed to fetch pending pushes: \(error)")
            }
        }
    }

    /// The push to write for a queued one, sealing a pre-update one in place so that its
    /// next attempt reuses the id; nil while there is no key to seal it with.
    private func preparedPush(for pending: PendingPush, in context: ModelContext) throws -> PreparedPush? {
        if let push = pending.preparedPush { return push }
        guard let userId = pending.userId, !userId.isEmpty, let keys = PushKeys.load(uid: userId) else { return nil }
        let push = try pending.prepareLegacy(keys: keys, pushId: db.collection("pushes").document().documentID)
        pending.pushId = push.pushId
        pending.prepared = try JSONEncoder().encode(push)
        pending.url = ""
        pending.title = ""
        try context.save()
        return push
    }

    /// After a refusal, read from the server: an earlier attempt whose reply was lost may
    /// have landed, and then this set was an update the rules refuse. That push exists and
    /// keeps its object; only one that never landed loses its upload. False when the read
    /// itself fails (offline, say): a failed read is not "never landed", and deleting on it
    /// could take the object of a push that exists, so the row waits for the next run.
    private func dropRefused(_ push: PreparedPush) async -> Bool {
        let exists: Bool
        do {
            exists = try await db.collection("pushes").document(push.pushId).getDocument(source: .server).exists
        } catch {
            return false
        }
        if !exists, push.type == "file", let objectPath = push.objectPath {
            try? await Storage.storage().reference(withPath: objectPath).delete()
        }
        return true
    }
}
