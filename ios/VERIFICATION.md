# Verification — September 17, 2026

The committed source is build 6. It includes the camera-startup changes prepared after a physical-device report of a black preview. **Those latest camera changes have not yet been installed or verified on an actual iPhone.** The device disconnected during the installation attempt; build 5 was the last verified installed version.

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
