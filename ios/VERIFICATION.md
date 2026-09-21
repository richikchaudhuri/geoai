# Verification — September 22, 2026

## Build 11 — coordinated random orb styles, installed on iPhone

Each new loading view selects one of six curated styles: Composing, Breathing,
Weaving, Searching, Solving or Shaping. Selection is stored in SwiftUI state, not
performed in the drawing loop. It remains stable across status-label changes,
body updates, theme changes and background/resume. Both dashboard refresh
indicators share one style and clock; a new refresh excludes the previous style.
Individual newly created loaders may independently choose the same style by
chance. No stacked graphics, extra controls or artificial delays were added.

Validation:

- Six palette tests passed, covering 2,000 chained selections, every style's
  exclusion, seeded reproducibility and exclusion of styles outside the palette.
- Full native package suite: 13 passed, two optional snapshot exports skipped,
  zero failures. Existing rendering, theme, paused-frame, display-bound and
  golden checks passed (72 cases / 70,115 reference values).
- Signed iPhone build succeeded without compiler warnings in the final build log;
  strict deep signature verification passed. Diff whitespace checks passed.
- Build 11 was installed over build 10 on the connected iPhone 17. Device tools
  confirmed version 1.0.0 / build 11 and successfully launched the app. Receipts
  are under `DerivedData/PhoneBuild11/`.

The operation-selection lifecycle was code-reviewed; native raster checks cover
the styles themselves. No live photo upload, backend mutation or device
accessibility-setting change was performed for this update.

## Build 10 — Composing throughout the app, installed on iPhone

The app-level orb wrapper now selects `.composing` unconditionally. Per-screen
style overrides were removed from map refresh, location/place search, draft
loading, photo preparation, submission and remote-image placeholders. Actual
status text and typed submission stages remain unchanged. Existing dimensions,
dark/light rendering, reduced-motion behavior and lifecycle pausing are retained.

The signed iPhone build and strict deep code-signature verification passed.
Golden geometry plus all five renderer assertions passed again (six executed
checks, zero failures; the optional contact-sheet export was skipped). Source
inspection confirms there are no remaining per-screen style overrides.

Build 10 was installed over build 8 on the connected iPhone 17. Device tools
confirmed GeoAI version 1.0.0 / build 10 and successfully launched it. Installation,
version and launch receipts are in `DerivedData/PhoneBuild10/`. No database writes
or real photo upload were performed for this UI-only change.

## Build 9 — native thinking-orb family

Replaced the gradient sphere with the native SwiftUI ThinkingOrbsKit from
Jakub Antalik's Libraries.dev, pinned to commit
`2015f0ba79a9faec351719c4a6d590a1e6bfa243`. The MIT license is retained in the
local package and bundled in the app. No JavaScript engine, remote dependency,
new network service, or artificial waiting period is introduced.

The app uses Composing for photo preparation, Searching for place/GPS requests,
Connecting for live data and report details, Weaving for uploads, Solving for
receipt checks, Working for draft operations and Breathing for remote image
loading. Listening and Shaping are supported by the library but not forced into
unrelated app workflows. Submission stages are typed; request order, retry logic,
and stored metadata are unchanged.

Completed checks:

- iOS 27 simulator build succeeded and build 9 launched on the iPhone 17 simulator.
- Signed arm64 iPhone build succeeded; strict deep signature verification passed.
- Existing Mac Catalyst compile check passes with both local modules and all app
  sources. Upstream snapshot capture was adjusted to select UIKit on Catalyst.
- All 24 GeoAICore tests and 17 mocked capture/network/configuration/metadata checks
  passed. These tests do not upload real photos or insert report rows.
- All 72 upstream golden geometry cases passed: 70,115 values within 0.0001.
- All nine native package tests passed with zero failures, including actual
  SwiftUI raster checks for every design in both themes, changing animation
  frames, automatic theme selection and exact 20/28/32/44/64/88-point bounds.
  Paused rendering repeatedly matches its deterministic static frame.
- Generated and visually reviewed the native contact sheet and generated 144
  fixed-time snapshots under `DerivedData/OrbVerification9/`. No blank/clipped
  orbs were found in the reviewed sheet. This is native-render verification,
  not a claim of live phone interaction for every transient upload stage.
- Integration review found the previous image-width fix and existing larger
  typography/tap targets preserved. Only decorative indicators changed.

Animation is capped at 30 fps. The app wrapper stops animation for inactive work,
background scenes and disappearing views; the native renderer uses a static
frame for Reduce Motion. The Reduce Motion branch was source-reviewed, not
verified by toggling the device's accessibility setting; its shared paused/static
rendering branch was exercised by the native tests.

At this checkpoint build 9 was not installed on the physical phone; build 8 remained installed.
No real photo submission or backend mutation was performed for this UI update.

## Build 8 — observation sheet width fix

The reported clipping was reproduced in build 7 using the live reviewed `Pothole (D40)` observation. The photo's aspect-fill layout expanded the vertical scroll view beyond the screen, clipping text and cards on both sides. `RoadImage` now lays out inside a bounded container, and the observation content uses the current viewport width with 22-point side margins. The larger text settings are preserved.

The corrected simulator build was visually checked on an iPhone 17 running iOS 27: the same photo, badge, title, confidence card and assessment notes stay inside the screen with wrapping text. Both simulator and signed physical-device builds succeeded, and strict deep signature verification passed.

A deterministic UIKit/SwiftUI harness compiled the actual view source with an injected loaded photo. All 24 combinations of 320/393/402-point widths, regular/XXXL/accessibility3/accessibility5 text, and landscape/portrait images passed: content and scroll widths exactly match the viewport. The old landscape-image layout measured about 542 points across all three viewport widths. Local measurements and harness notes are under `DerivedData/LayoutRegression8/`.

Build 8 was installed over build 7 on the connected iPhone 17. Device tools confirmed version 1.0.0 / build 8 and successfully launched it. Installation and launch receipts are under `DerivedData/PhoneBuild8/`. Camera capture/upload behavior was not changed or newly verified in this fix.

## Build 7 — larger UI and live service configuration

The current source is build 7. Supabase uses the supplied `https://vtlkitpoffudiefuoijb.supabase.co` URL and public anon key; Cloudinary uses cloud `dnxpt5gea` and unsigned preset `photos`.

Completed September 21:

- Xcode 27.0 (27A266a) installed. The arm64 iPhone build succeeded using the existing development team and iPhoneOS 27 SDK; strict deep code-signature verification passed.
- Build 7 installed over build 5 on the connected iPhone 17 running iOS 27.0. Apple device tools confirmed `com.geoai.ios` version 1.0.0 / build 7 and successfully launched it. Local installation and launch receipts are under `DerivedData/PhoneBuild7/` (ignored build artifacts).
- The unsigned arm64 iPhone simulator build also succeeded. This build result does not establish visual or camera behavior.
- All app Swift files typechecked against the installed Mac Catalyst SDK (MacOSX26.5), including the redesigned views. This is not a signed iOS build.
- All 24 core regression checks and 17 mocked capture/configuration/metadata checks passed.
- The Supabase capture-time migration was applied through the authenticated SQL editor. `photos.captured_at` is nullable `timestamp with time zone`, visible through the public REST API.
- Public-key REST queries for every column used by the app succeeded: 79 visible photo rows, 54 visible assessment rows at verification time. Counts depend on the role's existing policies.
- Read-only SQL inspection confirmed `anon` photo SELECT/INSERT grants, insert permission for `captured_at`, the existing anonymous INSERT policy, and `trg_sync_photo_to_assessment`. No grants, policies, existing row values or triggers were changed.
- Cloudinary's configured unsigned endpoint returned `Invalid image file` for intentionally invalid JPEG bytes. No media asset or test report was created. This is a configuration probe, not a complete upload test.
- Swift syntax, property-list/project validity and diff whitespace checks passed. A native SwiftUI sizing harness confirmed the overview scroll area grows to its content and respects its height cap.

The UI now has larger scalable typography, accessible tap targets, scrollable assessment cards, a content-sized photo placeholder, adaptive field layouts, and gradient orbs only during active work. Reduced motion and background pause are supported. The overview drag gesture is attached only to its header so content can scroll independently.

Build 7 is installed and launch-verified on the phone. Visual inspection on actual iPhone sizes, camera preview/shutter/GPS checks, and one real photo submission through assessment processing still need to be exercised on the device. Build commands used `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` without changing the system-wide developer selection. The historical results below remain specific to older builds.

## Historical build 6 verification — September 17

At the September 17 checkpoint, the source was build 6. It included the camera-startup changes prepared after a physical-device report of a black preview. **Those camera changes have not yet been installed or verified on an actual iPhone.** The device disconnected during the installation attempt; build 5 was the last verified installed version.

## Completed checks

| Check | Result |
|---|---|
| Build 6 iOS simulator build | Passed with Xcode 27 / iOS 26.4 simulator |
| Build 6 signed arm64 device build | Passed with Xcode 27 / iPhoneOS 27 SDK, iOS 17 deployment target |
| Build 6 code signature | Strict deep verification passed |
| Capture HTTP, configuration, draft and metadata harness | All 17 checks passed again for build 6; requests mocked, no uploads |
| GeoAICore XCTest suite | 24 passed with zero failures for build 2; core sources unchanged since that check |
| Horizontal card navigation | Next, Previous and swipe checked in build 4; recorded frames confirmed horizontal motion without vertical re-entry |
| Overview drawer and native tabs | Swipe-up/down drawer, native glass bar and selected-tab pill checked in build 3 |
| Road-focused artwork | Report, distress icons, neutral pending icons, Browse and photo placeholders checked in build 5 |
| Previous device installation | Builds 3–5 installed and launched on an iPhone 17 running iOS 27 |
| Live configuration and migration | Client values blank; migration supplied but not applied to a live database |

The local build logs, device installation receipts and recording were development evidence, not portable source files. [The Report preview](docs/report.png) shows build 5's design, which is retained in build 6.

## Camera changes and limits

Build 6 defers presentation/start until the app and camera view are active and visible. Session configuration occurs once, input is added before validating output, and preview attachment follows committed configuration. Shutter readiness requires a running, uninterrupted session, nonempty layer bounds, an active connection and `AVCaptureVideoPreviewLayer.isPreviewing`. A bounded preview wait shows a useful status when no frames arrive. Temporary interruptions pause/resume; one media-services-reset restart is allowed. Errors preserve their underlying code.

A local protected diagnostic snapshot at `Library/Application Support/camera-diagnostics.json` contains state, bounds and connection flags only. It contains no photo, audio, location or identifiers and is excluded from backup.

These changes address observed lifecycle flaws. **They do not establish the cause or resolution of the reported black preview until the next device check.** Actual shutter operation, denied permissions, GPS accuracy and interruption recovery remain unverified. The original physical photo test was skipped. No photo upload was performed.

The harness verifies capture-time serialization and preservation, explicit null semantics, old-draft decoding, GPS age/accuracy/range rejection, missing-migration errors, upload/receipt/error handling and retry behavior. Core tests cover capture time versus upload time, legacy-schema fallback, pagination, pending records and expert corrections.

Historical scratch tests of ImageIO metadata parsing passed 6 of 8 cases. Two malformed imported-GPS checks failed because ImageIO normalized corrupt hemisphere strings. This affects legacy imported metadata validation; new camera photos use CoreLocation, and new library imports are no longer offered.

## Reproduce and finish validation

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun swift test --package-path Packages/GeoAICore
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  bash Scripts/verify-capture.sh
```

- Install build 6 on a physical iPhone, open Report → Take photo and verify live preview; inspect the diagnostic snapshot if it stays black.
- Test capture, permission denial, returning from interruptions, GPS availability and draft restoration after restart.
- Apply the migration to the intended development Supabase instance and configure public service values before checking real RLS, upload receipts and AI queue processing.
- Check additional sizes, large accessibility text, VoiceOver and distribution privacy disclosures.

No live database writes, cloud changes or App Store submission were part of this validation.
