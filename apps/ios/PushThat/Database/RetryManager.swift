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
    /// it. `PushDocuments.create` has already told a refusal from an earlier attempt that
    /// landed after all (which returns as written, and whose object stays) and from one it
    /// could not check (`PushError.unconfirmed`, which leaves the row for the next run).
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
                            // Read back and missing: this push never landed.
                            if push.type == "file", let objectPath = push.objectPath {
                                try? await Storage.storage().reference(withPath: objectPath).delete()
                            }
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
}
