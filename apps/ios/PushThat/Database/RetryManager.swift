import Foundation
import BackgroundTasks
import FirebaseFirestore
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

    /// Retry all pending pushes stored in local database
    func retryPendingPushes() {
        // This would use SwiftData to fetch pending pushes
        // For now, we'll implement a simple version

        Task {
            do {
                let container = try ModelContainer(for: PendingPush.self)
                let context = ModelContext(container)

                let descriptor = FetchDescriptor<PendingPush>()
                let pendingPushes = try context.fetch(descriptor)

                for push in pendingPushes {
                    do {
                        try await uploadPendingPush(push)
                        context.delete(push)
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

    private func uploadPendingPush(_ push: PendingPush) async throws {
        let data = push.toFirestoreData()
        _ = try await db.collection("pushes").addDocument(data: data)
    }
}
