import XCTest

/// What AgeGate makes of the range the system shares. Only the decision: asking needs the
/// system's sheet and an eligible account, which a test has neither of.
final class AgeGateTests: XCTestCase {
    func testRangesBelowEighteenAreTurnedAway() {
        XCTAssertEqual(AgeGate.underMinimum(lower: nil, upper: 17), true)
        XCTAssertEqual(AgeGate.underMinimum(lower: 13, upper: 17), true)
        XCTAssertEqual(AgeGate.underMinimum(lower: 0, upper: 12), true)
    }

    func testRangesFromEighteenAreLetIn() {
        XCTAssertEqual(AgeGate.underMinimum(lower: 18, upper: nil), false)
        XCTAssertEqual(AgeGate.underMinimum(lower: 21, upper: 25), false)
    }

    func testNoAgeIsNoAnswer() {
        XCTAssertNil(AgeGate.underMinimum(lower: nil, upper: nil))
    }

    /// Not one the system documents for a single gate at 18; let in rather than guessed at.
    func testARangeAcrossEighteenIsLetIn() {
        XCTAssertEqual(AgeGate.underMinimum(lower: 16, upper: 20), false)
    }

    func testTheMinimumIsTheTermsAge() {
        XCTAssertEqual(AgeGate.minimumAge, 18)
    }
}
