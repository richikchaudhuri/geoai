// GeoAI addition: deterministic coverage for the app's curated orb selection.

import XCTest
import ThinkingOrbsKit

final class OrbStylePaletteTests: XCTestCase {
    func testPaletteContainsExactlyTheSixCuratedStyles() {
        XCTAssertEqual(OrbStylePalette.styles, [
            .composing, .breathing, .weaving, .searching, .solving, .shaping
        ])
        XCTAssertEqual(Set(OrbStylePalette.styles).count, OrbStylePalette.styles.count)
    }

    func testRepeatedSelectionsStayInPaletteWithoutImmediateRepeats() {
        var generator = SeededGenerator(seed: 11)
        var previous: OrbState?
        var seen: Set<OrbState> = []

        for _ in 0..<2_000 {
            let selected = OrbStylePalette.next(excluding: previous, using: &generator)
            XCTAssertTrue(OrbStylePalette.styles.contains(selected))
            XCTAssertNotEqual(selected, previous)
            seen.insert(selected)
            previous = selected
        }

        XCTAssertEqual(seen, Set(OrbStylePalette.styles))
    }

    func testEveryPaletteMemberCanBeExcluded() {
        var generator = SeededGenerator(seed: 101)
        for excluded in OrbStylePalette.styles {
            for _ in 0..<200 {
                let selected = OrbStylePalette.next(excluding: excluded, using: &generator)
                XCTAssertNotEqual(selected, excluded)
                XCTAssertTrue(OrbStylePalette.styles.contains(selected))
            }
        }
    }

    func testSameSeedAndExclusionsProduceSameSequence() {
        var first = SeededGenerator(seed: 2026)
        var second = SeededGenerator(seed: 2026)
        var firstPrevious: OrbState?
        var secondPrevious: OrbState?

        for _ in 0..<1_000 {
            firstPrevious = OrbStylePalette.next(excluding: firstPrevious, using: &first)
            secondPrevious = OrbStylePalette.next(excluding: secondPrevious, using: &second)
            XCTAssertEqual(firstPrevious, secondPrevious)
        }
    }

    func testNonPaletteExclusionBehavesLikeNoExclusion() {
        let outsidePalette = OrbState.allCases.filter { !OrbStylePalette.styles.contains($0) }
        XCTAssertFalse(outsidePalette.isEmpty)

        for excluded in outsidePalette {
            var first = SeededGenerator(seed: 42)
            var second = SeededGenerator(seed: 42)
            for _ in 0..<100 {
                let selected = OrbStylePalette.next(excluding: excluded, using: &first)
                XCTAssertEqual(selected, OrbStylePalette.next(using: &second))
                XCTAssertTrue(OrbStylePalette.styles.contains(selected))
            }
        }
    }

    func testSystemGeneratorOverloadReturnsValidNonrepeatingSelections() {
        var previous = OrbStylePalette.next()
        XCTAssertTrue(OrbStylePalette.styles.contains(previous))
        for _ in 0..<100 {
            let selected = OrbStylePalette.next(excluding: previous)
            XCTAssertTrue(OrbStylePalette.styles.contains(selected))
            XCTAssertNotEqual(selected, previous)
            previous = selected
        }
    }
}

/// SplitMix64 gives these tests reproducible random input without shared state.
private struct SeededGenerator: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58476D1CE4E5B9
        value = (value ^ (value >> 27)) &* 0x94D049BB133111EB
        return value ^ (value >> 31)
    }
}
