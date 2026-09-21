# GeoAI vendoring notes

Source: https://github.com/Jakubantalik/Libraries.dev

Pinned commit: `2015f0ba79a9faec351719c4a6d590a1e6bfa243`.

Upstream directory: `packages/thinking-orbs/ports/ios/ThinkingOrbsKit`.
The package MIT notice is retained in `LICENSE` and also bundled in the app's
`ThirdPartyNotices.txt`. No JavaScript runtime, network calls, build plugins,
or remote package dependencies are added.

GeoAI changes:

- Animation scheduling is capped at 30 frames per second, preserving the previous
  app orb's rendering budget. Geometry and baked presets remain unchanged.
- Golden fixture loading is made self-contained for this local Swift package.
- Integration regression tests cover scaled rendering, themes and motion states.
- Snapshot capture selects UIKit on Mac Catalyst even when the SDK also exposes
  AppKit, keeping the existing cross-platform compile check compatible.
- `OrbStylePalette` is a small GeoAI addition for choosing among six visual styles
  without consecutive repeats for a retained operation. It is tested with a
  deterministic random generator and does not alter upstream geometry.

The app wrapper chooses the separately tuned 20-point preset at display sizes
of 32 points or below, and the 64-point preset for larger orbs. Vector drawing
scales to the existing control dimensions without changing layout or tap targets.
The wrapper hides decorative orb labels from VoiceOver; the enclosing control
or status text supplies the meaningful label. Animations stop for inactive work,
background scenes, disappearing views and Reduce Motion.

The full nine-state family remains in the upstream library. As of build 11,
GeoAI chooses among Composing, Breathing, Weaving, Searching, Solving and Shaping.
Each loading view retains its choice across body updates, theme changes and
background/resume. A fresh loading operation can select another style. Both
dashboard refresh indicators share the same selection and playback clock.
Actual operations are described by the surrounding status text, not by the
visual variant. No microphone feature or simulated AI progress is introduced.
