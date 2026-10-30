# iOS survey integration verification

Current update: **1.0.0 build 13 — October 30, 2026**. This update now has a successful iOS Simulator build and launch, in addition to the earlier source checks. It is not a signed IPA or physical-device build.

## Implemented

- Video tab added to the existing native tab bar; native Map, Filters, Report and Browse remain intact.
- One retained WKWebView uses the same deployed website and read-only GIS API as web/Android. No parallel, divergent survey calculations are introduced.
- Configurable dashboard URL, local persistence, explicit disconnected/setup screen, capability validation, loading deadline, retry and browser fallback.
- Native share sheet for current view links and filtered CSV exports. Origin/redirect validation, bounded downloads, safe filenames, temporary-file cleanup, stale-request cancellation and weak message handling.
- Generated Xcode project includes the new Swift source and Debug-only local-networking plist. Release transport rules remain unchanged.
- Build 13 consumes the completed shared dashboard: every drive route, custom drive menu, persistent captured-frame/replay card, zoom-to-car behavior and zoom-aware citizen/video clustering. Explicit open/reload revalidates cached HTML; tabs retain the existing WKWebView. The site's versioned script/style references fetch the matching implementation.
- Compatibility validation requires document revision `geoai-survey-ui-version >= 20261030`, the Video control and the required GIS, video, survey, drive-player and drive-inspector assets. Old or incomplete deployments produce an update-and-retry message. Validation does not depend on the asynchronous map, API or dynamic inspector having finished initializing.
- Opening an external preview or native share/export sheet pauses replay without destroying the persistent photo card. Replay stays paused on return.
- The current shared website also includes the polished responsive Filters cards and larger action text, with the Settings Map legend button removed. Build 13 receives these changes when the versioned website assets are deployed; the native binary is unchanged by this presentation update. Its bridge/revision checks were rerun successfully against the current HTML.

## Checks actually executed in this workspace

- `xcodegen generate --spec ios/project.yml`: succeeded; source/project membership checked.
- `swiftc -frontend -parse` for changed app Swift files: passed. This verifies syntax, not an iOS SDK build.
- `bash ios/Scripts/check-core.sh <verification-directory>`: **34 regression methods passed**, using the actual XCTest method bodies and the repository's Command Line Tools fallback runner.
- Those checks include **1,000 distinct route/origin property cases** for the survey URL contract, secure transport requirements, debug loopback restriction, preserved URL state, same-origin download rules and hostile address rejection. Existing citizen decoding, filtering, pagination and expert correction checks still pass.
- `node ios/Scripts/check-survey-bridge.cjs`: passed actual injected-script checks for native sharing, CSV body/URL exports, oversize handling, invalid events and current-view sharing. It also executes the actual compatibility script against the shipped root `index.html`, verifies rejection of missing/old/malformed revisions and each missing required asset, accepts future revisions, and verifies that a still-loading map is accepted. Run `npm ci` in the repository root before this check if its jsdom development dependency is not installed.
- `bash ios/Scripts/check-catalyst.sh`: **passed**. GeoAICore, ThinkingOrbsKit and all app Swift files typechecked against the installed Mac Catalyst support SDK. This is a compile-time check, not an iOS build or runtime test.
- The tests use local/mock data only and create no remote uploads or database records.

## Simulator verification — October 30, 2026

- Xcode 27.2 (27B52) installed from the Mac App Store; built with the iOS 27.2 Simulator SDK.
- `xcodebuild -project ios/GeoAI.xcodeproj -scheme GeoAI -configuration Debug -sdk iphonesimulator -destination platform=iOS\ Simulator,id=74997A16-00DC-4316-B120-8770812AE0CF CODE_SIGNING_ALLOWED=NO build`: **BUILD SUCCEEDED**.
- Installed and launched `com.geoai.ios` build 13 on iPhone 18 Pro / iOS 27.0.
- Native Map tiles and clustered observations displayed. Browse visibly showed **361 observations · live data**, with road-photo previews. These were read-only live service requests; no photos were uploaded and no records were changed.
- Screenshots and the build log are in the current delivery verification folder.

## Remaining device release checks

The native Map/Browse preview is verified. Hosted Video, native sharing/download interactions, physical-device capture and App Store readiness are not established by that preview. In Xcode 26+, run the GeoAI scheme and verify:

1. An unconfigured Video tab shows connection setup; native capture and maps still work.
2. Deploy the complete root website from this same source package to the HTTPS `/gis/app/` address backed by the GIS API, then connect the app. iOS loads that hosted website rather than bundled local assets. For a simulator, the Debug-only loopback URL can use the supplied mock server. Check that an old/unmarked deployment produces the update message and Retry accepts the newly published page.
3. Confirm all six survey map styles, all drive routes and the complete kilometre total match the website. Check both citizen and video clusters separate on zoom. Navigate away and back without losing the selected view or repeating initial map preparation.
4. Apply combined filters, choose each drive, inspect its route/distress card, and verify Replay focuses the car. Browse all stored captured frames; Next/Previous and Play must keep the detail card open. Check phone stacking and wide-screen side-by-side image/details. Export CSV and compare exported rows/counts with the filtered API response.
5. Share the current view, reopen its link and confirm equivalent filters and camera. Confirm native share sheet cancellation removes the temporary CSV.
6. Exercise offline launch, invalid URL, old dashboard URL, unavailable API, background/foreground, preview/share/export presentation, WebKit process termination and retry. Replay should remain paused when returning from another tab or native interface; explicit Play continues within the same card.
7. Confirm Release rejects HTTP, native export rejects a different host/port and oversized content, and browser links cannot invoke arbitrary URL schemes.

A deployed GIS origin and normal iOS signing/device access are external prerequisites. This repository does not include a production GIS server or a distribution certificate. Build 13 has been installed in the simulator only; earlier physical-device build 11 launch evidence in `VERIFICATION.md` is historical.

## Route replay extension

The shared website includes clustered camera badges, persistent photo/frame navigation and on-demand route replay inside the selected drive card. iOS sends `geoai:app-pause` when the survey tab disappears, the scene becomes inactive, the connection sheet opens, or native previews/sharing/export presentation starts. The route does not resume automatically. Source checks above cover the updated integration; physical-device validation and the complete hosted Video flow remain pending.
