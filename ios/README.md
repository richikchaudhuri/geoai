# GeoAI for iOS

A native SwiftUI and MapKit client for the GeoAI road-damage platform. It includes a map dashboard, severity filters, horizontal assessment cards, road and distress icons, and camera reports with capture time and location metadata.

## Run

1. Open `GeoAI.xcodeproj` with **Xcode 26 or newer**. The app targets **iOS 17+**.
2. Select the **GeoAI** scheme and an iPhone simulator, then Run.
3. For a physical iPhone, select your development team in Signing & Capabilities, use a unique bundle identifier as needed, and choose the connected device. No personal signing team is committed.

This build is configured for the supplied GeoAI Supabase project and Cloudinary `dnxpt5gea` cloud with unsigned preset `photos`. It refreshes live observations at launch, retaining the bundled demo and last successful metadata load for fallback. Apple Maps, place search and remote photos need internet access; maps and photos are not fully available offline.

Camera reporting requires a physical device. The simulator shows an explicit message instead of attempting camera startup. Build 11, with a curated mix of loading orbs, is installed and launch-verified on the iPhone 17. See [verification](VERIFICATION.md). **Live camera preview, capture and a real upload still require hands-on verification.**

## Experience

- Native Map, Filters, Report and Browse tabs, with Liquid Glass and the selected-tab pill on iOS 26+; earlier releases use system material styling.
- Six map appearances, clustered severity dots, night-capture outlines and a pulse on selection.
- A road overview card that swipes above the tab bar and collapses behind it.
- Assessment cards slide horizontally with Next, Previous or swiping; opening a marker retains the upward entrance.
- Vector road artwork with pothole, crack, alligator-crack, bleeding and surface-wear symbols. Unknown observations keep a neutral road icon.
- Camera-only reporting, protected drafts, image resizing, coordinate review and retry/reconciliation handling.
- Debounced place search, paginated data loads, expert-correction precedence and explicit demo/saved/live indicators.
- Larger default text (Dynamic Type starts at Extra Large and honors larger accessibility settings), 44–60 point controls, and responsive scrolling cards.
- Native loading orbs choose from Composing, Breathing, Weaving, Searching, Solving and Shaping. Each loading view keeps its choice through redraws, theme changes and background/resume. The two live-refresh indicators share one style, changing on the next refresh without an immediate repeat. Status text describes the actual operation. Reduce Motion is respected and orbs pause when inactive, offscreen or in the background. No artificial processing delay or extra feature is added.

![Historical Report screen — build 5; the larger build 7 layout awaits a device screenshot](docs/report.png)

## Connect live data

All four service values in `GeoAI/Resources/Configuration.plist` are configured for this build. They are public client settings, including a legacy `anon` key, and will be present in the installed app. `Configuration.example.plist` remains a blank reset template. No privileged server credentials are used.

| Field | Value |
|---|---|
| `SupabaseURL` | HTTPS Supabase project URL |
| `SupabasePublicKey` | Publishable key (`sb_publishable_…`) or legacy `anon` JWT |
| `CloudinaryCloudName` | Cloudinary cloud name |
| `CloudinaryUploadPreset` | Unsigned image-upload preset |

MapKit requires no additional map API key. Keep service-role keys, database passwords, Cloudinary secrets and AI-provider keys on the backend; the iOS client rejects privileged Supabase keys.

The backend must provide public-role reads for the intended `photos` and `assessments` rows, permitted inserts into `photos`, receipt lookups by image URL, the existing assessment trigger/worker, and a suitable unsigned Cloudinary image preset. The bundled `Backend/001_photos_captured_at.sql` migration was applied to the configured project on September 21, 2026; public reads and insert grants were verified. Existing permissions and triggers were preserved. Other projects still need the [capture timestamp setup](Backend/README.md). Publishing this source does not apply migrations automatically.

New photo inserts contain `image_url`, `latitude`, `longitude`, `address` and nullable `captured_at`. The existing `created_at` upload timestamp and FIFO queue ordering remain unchanged. The app uses direct Supabase/Cloudinary interfaces, not the FastAPI expert-review service.

## Capture and draft behavior

Capture time is recorded in the shutter callback. GPS is accepted only if it is within 15 seconds of that event, has valid coordinates and reports accuracy of 150 metres or better. Missing permission or a fresh fix leaves coordinates available for manual entry. Capture time and reviewed coordinates are uploaded; GPS accuracy, fix time and provenance remain in the local draft.

The resized JPEG is at most 1,600 pixels along its longest edge and under 2 MB. Timestamp and geotag are separate report metadata, not a watermark or embedded EXIF in that resized image. The removed library picker cannot import new images; legacy imported drafts remain readable.

The camera waits for an active app, visible view and rendering preview before enabling its shutter. Temporary interruptions pause and resume. A protected local `Library/Application Support/camera-diagnostics.json` snapshot records session/preview state, bounds and error codes only; it contains no media or location data and is excluded from backup.

A single protected draft survives app launches and is excluded from backup. Closing Report saves it. Discarding removes the local draft, not any already-uploaded asset. Interrupted database submissions become **Check submission** and query for an existing receipt before an explicit retry. Full duplicate prevention still requires server-side uniqueness; an interrupted Cloudinary response may leave an unused asset. Keep the app open during submission; background/resumable transfers are not implemented.

Known capture times determine day/night. Explicit null remains unknown. Older schemas/snapshots that omit `captured_at` retain the historical upload-time fallback. The migration does not reconstruct capture times for old records.

## Development and validation

`project.yml` is the XcodeGen source. Run `xcodegen generate` after adding source files outside Xcode. The generated project and shared scheme are committed. `Packages/GeoAICore` contains Foundation-only models, parsing, filtering and REST behavior. `Packages/ThinkingOrbsKit` vendors Jakub Antalik's MIT-licensed native SwiftUI animations at a pinned revision; it has no external runtime dependencies. See its `VENDORED.md` for provenance and local changes.

From this directory, with full Xcode selected:

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun swift test --package-path Packages/GeoAICore
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  bash Scripts/verify-capture.sh
```

Additional scripts: `Scripts/check-catalyst.sh` and `Scripts/check-core.sh`. See [VERIFICATION.md](VERIFICATION.md) for actual checks and remaining hardware/backend work. Complete backend authentication, abuse controls, privacy disclosures and App Store requirements before distribution.

`python3 Scripts/check-services.py` checks public read access and sends deliberately invalid image bytes to Cloudinary to test preset validation without creating an asset. It does not send a real photo or create database rows, and it does not establish end-to-end camera or AI-worker operation.

Based on this repository's design and the [GeoAI backend](https://github.com/Suraj-B12/GeoAI). Original font and snapshot licensing is retained in `UPSTREAM-LICENSE`.
