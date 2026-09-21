// GeoAI addition: a curated, stateless palette for varying loading visuals.

/// Selects complementary orb styles without repeating the preceding style.
/// Keep the selected value in the caller's state for the duration of an operation.
public enum OrbStylePalette {
    public static let styles: [OrbState] = [
        .composing, .breathing, .weaving, .searching, .solving, .shaping
    ]

    public static func next(excluding previous: OrbState? = nil) -> OrbState {
        var generator = SystemRandomNumberGenerator()
        return next(excluding: previous, using: &generator)
    }

    /// Uses the caller's generator so selection can be reproduced in tests.
    public static func next<R: RandomNumberGenerator>(
        excluding previous: OrbState? = nil,
        using generator: inout R
    ) -> OrbState {
        let candidates = styles.filter { $0 != previous }
        return candidates[Int.random(in: candidates.indices, using: &generator)]
    }
}
