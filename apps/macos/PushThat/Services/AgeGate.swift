import SwiftUI
import DeclaredAgeRange

/// PushThat is for people 18 and older. This asks the system for the user's declared age
/// range once per launch (Apple's Declared Age Range API) and keeps one fact from it: whether
/// the person using this device is under 18. California's Digital Age Assurance Act (AB 1043,
/// Civil Code 1798.500 and on) requires every app to request the operating system's or the
/// store's age signal when it is downloaded and launched, from January 2027, and treats what
/// comes back as actual knowledge of the user's age. Knowing a user is under the age the Terms
/// and Privacy Policy set, and carrying on regardless, would make both documents untrue (and
/// under 13, would be collecting a child's email and pushes without the parental consent
/// COPPA wants, which PushThat has no way to get). So such a device is signed out and stops
/// at `AgeGateView`, and the share extension turns shares away. The Android app does the same
/// with Google Play's signal (`AgeGate.kt`).
///
/// Only the verdict is stored (`AccountKeyStore.isUnderMinimumAge`), never the age range or
/// how it was declared: nothing else in the app needs them, and nothing about them leaves the
/// device.
///
/// Every failure lets the person in: an OS before 26.2, the API erroring, the person declining
/// to share. The law asks for the request, not for refusing service when no answer comes, and
/// a gate that shut on errors would lock adults out for reasons that have nothing to do with
/// their age.
///
/// This file is the same in `apps/ios` and `apps/macos`.
@MainActor
final class AgeGate: ObservableObject {
    /// The age the Terms (Registration) require to form the contract, and the Privacy Policy
    /// says the app is not intended for anyone under. A change here is a change to those
    /// documents too (apps/web), and to the Android app's `AgeGate.MINIMUM_AGE`. The share
    /// extensions' refusal says the number in words of its own.
    static let minimumAge = 18

    /// Once per process, which is once per launch. Not once per install: the law says "when
    /// the application is downloaded and launched", and a child's age range can be set after
    /// the app is already on the device.
    private static var checkedThisLaunch = false

    /// Set while a check waits on the system. Each window runs its own check (two scenes on
    /// an iPad, a second window on the Mac), and without this each would ask, and could put
    /// up the system's sheet, at once. A second caller returns rather than waiting: the
    /// verdict is published, so its window follows the first one's answer.
    private static var checking = false

    /// Whether the last answer said the person using this device is under `minimumAge`.
    @Published private(set) var isBlocked = AccountKeyStore.isUnderMinimumAge

    /// Lets the next check ask again, when the gate is shut. The gate's screen says PushThat
    /// checks each time it opens, and on iOS coming back from the background is not a launch:
    /// someone who corrected their age in Settings and switched back would otherwise stay at
    /// the gate until they force-quit the app. Only when shut: for anyone let in, one check
    /// per launch is what the law asks for. The Android gate does the same on resume.
    func askAgainIfBlocked() {
        if isBlocked { Self.checkedThisLaunch = false }
    }

    /// This launch's answer, unless one has been had already. A check that learns nothing
    /// leaves the stored verdict as it was.
    @available(iOS 26.2, macOS 26.2, *)
    func checkOnce(_ requestAgeRange: DeclaredAgeRangeAction) async {
        guard !Self.checkedThisLaunch, !Self.checking else { return }
        Self.checking = true
        defer { Self.checking = false }
        let answer = await Self.ask(requestAgeRange, blocked: isBlocked)
        // Marked only once the system has answered (or failed to): a check cancelled because
        // its view went away runs again from the next one, rather than never this launch.
        guard !Task.isCancelled else { return }
        Self.checkedThisLaunch = true
        guard let underMinimum = answer else { return }
        AccountKeyStore.setUnderMinimumAge(underMinimum)
        isBlocked = underMinimum
    }

    /// Whether the system says the user is under `minimumAge`, or nil when it gave no age.
    ///
    /// Only asked where `isEligibleForAgeFeatures` says the age assurance laws apply to this
    /// person (California from January 2027, and the states and countries before it), which
    /// is how Apple means the property to be used: elsewhere the request puts up the system's
    /// "share your age range?" sheet, and nothing in PushThat changes with the answer for
    /// anyone of age. Before 26.2 there is no way to tell, so there is no check at all
    /// (`checksAge(with:)`), rather than that sheet for every adult. A device already blocked
    /// is asked wherever it is, so that a wrong age corrected since, or a move out of the
    /// region, can open the gate again.
    @available(iOS 26.2, macOS 26.2, *)
    private static func ask(_ requestAgeRange: DeclaredAgeRangeAction, blocked: Bool) async -> Bool? {
        do {
            guard try await AgeRangeService.shared.isEligibleForAgeFeatures || blocked else { return nil }
            switch try await requestAgeRange(ageGates: minimumAge) {
            case .sharing(let range):
                return underMinimum(lower: range.lowerBound, upper: range.upperBound)
            case .declinedSharing:
                return nil
            @unknown default:
                return nil
            }
        } catch let error as AgeRangeService.Error {
            // The case only (not available, invalid request): it says which failure this
            // was, and nothing about the user.
            print("Age range unavailable: \(error)")
            return nil
        } catch {
            print("Age range check failed: \(type(of: error))")
            return nil
        }
    }

    /// With one age gate at `minimumAge` the system answers with a range below it (no lower
    /// bound or a lower one, an upper bound of 17) or one from it up (18, no upper bound);
    /// both ends nil means no age was shared. A range whose top is under `minimumAge` is
    /// turned away. A range that straddles it would be one Apple has not documented, and is
    /// let in rather than guessed at.
    nonisolated static func underMinimum(lower: Int?, upper: Int?) -> Bool? {
        if lower == nil && upper == nil { return nil }
        if let upper, upper < minimumAge { return true }
        return false
    }
}

/// The request needs the environment's `requestAgeRange`, which exists only from 26.0, and the
/// check runs only from 26.2 (`AgeGate.ask`); a view modifier is how a property of a newer OS
/// sits in a view that has to build for older ones.
@available(iOS 26.2, macOS 26.2, *)
private struct AgeRangeCheck: ViewModifier {
    @Environment(\.requestAgeRange) private var requestAgeRange
    @Environment(\.scenePhase) private var scenePhase
    let gate: AgeGate
    @State private var wasInBackground = false

    func body(content: Content) -> some View {
        content
            .task { await gate.checkOnce(requestAgeRange) }
            // Again on the way back from the background (AgeGate.askAgainIfBlocked). From the
            // background only, not from `.inactive`: the system's own sheet makes the scene
            // inactive while it shows, and asking again as it closed would put it straight
            // back up. A new task rather than `.task(id:)`, which would cancel a request
            // whose sheet is showing as soon as the phase moved.
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background:
                    wasInBackground = true
                case .active where wasInBackground:
                    wasInBackground = false
                    gate.askAgainIfBlocked()
                    Task { await gate.checkOnce(requestAgeRange) }
                default:
                    break
                }
            }
    }
}

extension View {
    /// Asks for this launch's age range from this view, which the system presents its sheet
    /// over. Put it on a view that stays for the whole launch (the window's root), since a
    /// view that goes cancels the request with it.
    @ViewBuilder
    func checksAge(with gate: AgeGate) -> some View {
        if #available(iOS 26.2, macOS 26.2, *) {
            modifier(AgeRangeCheck(gate: gate))
        } else {
            self
        }
    }
}

/// The screen for a device the system says belongs to someone under `AgeGate.minimumAge`:
/// what PushThat is for and why it stops here, with nothing to press. Whoever was signed in
/// has been signed out (`PushThatApp`), so nothing more is read or sent for them.
struct AgeGateView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Image("Logo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 96, height: 96)

                Text("PushThat is for people \(AgeGate.minimumAge) and older")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)

                Text("Your Apple Account says the person using this device is under \(AgeGate.minimumAge), so PushThat can't be used here. If that's not right, the age can be corrected in the Apple Account's settings, and PushThat checks again each time it opens.")
                    .multilineTextAlignment(.center)
            }
            .padding(32)
            .padding(.top, 48)
            .frame(maxWidth: 400)
            .frame(maxWidth: .infinity)
        }
    }
}
