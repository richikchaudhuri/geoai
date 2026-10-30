# GEOAI product implementation plan

This document preserves the original plan and historical implementation checkpoints. The final **Current mobile refresh** section records the latest behavior and verification; earlier test counts and release limitations describe their own checkpoints.

The existing website layout stays: GEOAI logo opens About, the navigation retains its expanding pills, and enabling Video shows drive paths, distress and kilometres. Extra controls and evidence open only on request.

## Shared data foundation

- Move citizen observations to the read-only GIS API so both layers use the handoff's final labels, metadata colours, severity sizes and authoritative review flags.
- Share filter normalization, inclusive IST dates, pagination, exports and view links across web and mobile.
- Keep citizen counts, video segment counts and recorded drive distance distinct.
- Preserve working maps while preparing all six styles; handle unavailable services and stale responses without false success.

Sample acceptance: 131 default citizen observations, 344 including pending review, 164 distressed video segments and 4.06 km across unique drives.

## Six additions

1. **Unified filters:** grouped distress types, multiple severities, review state, high confidence, inclusive IST dates, clearly defined day/night hours, citizen visibility and pending review. A drive filter affects Video only. Top Locations uses the current results.
2. **Evidence on selection:** preview, final labels, original labels when corrected, zero-inclusive confidence, review state, IST time and positional uncertainty. Video adds road/drive, distance from start, gate and quality. Full resolution requires an explicit link. Missing and failed images show readable placeholders. The repository’s anchored thumbnail previews expand into the original photo/details cards; grouped observations use the original View more list. Phone groups show one preview and a View more control.
3. **Drive comparison:** road/date/state, recorded kilometres, distressed metres and percentage of surveyed length; sort by metres, percentage or date. Explicit focus moves the map; toggling Video does not.
4. **Exact CSV export:** use current map area and filters, complete pagination, UTF-8 BOM and spreadsheet-formula protection. Do not emit a stale export after the view changes.
5. **Shareable views:** validated map position, zoom, style, layers and filters. Native hosts use system sharing. Never share an app-internal asset URL as a public link.
6. **On-demand legend:** metadata colours, sizes, marker shapes and uncertainty caveats inside About.

Supporting fixes: keyboard search results, reduced-motion support, the original spinner-to-card reveal sequence, no automatic original-image requests, bounded retry and stale-request cancellation.

## Android

Preserve camera, crop and upload. Add a Map entry with the shared website bundled at build time, a restricted asset origin and saved HTTPS API connection. Validate native share/export messages, offer retry and Back, and allow map access when camera permission is denied.

Verify unit tests, debug build, asset parity and available emulator checks. Production signing and physical-device checks remain release gates.

## iOS

Preserve native Map, Browse and reporting. Add a retained Video tab using the deployed shared dashboard, saved HTTPS connection, loading/retry/browser fallback, and validated native sharing/CSV exports.

Verify core tests, bridge tests, Swift source and project configuration. A full app build and simulator/device run require Xcode and the iOS SDK; source checks must not be reported as device testing.

## Verification sequence

1. Run existing map/navigation/video regression tests.
2. Compare over 1,000 distinct deterministic filters with the sample API's independent Python implementation and round-trip their share links.
3. Exercise the real sample HTTP API: known counts, IST dates, paging, geometry, CSV equality/BOM, previews, invalid inputs and missing images.
4. Integration-test controls, counts, markers, evidence, exports, sharing, empty results, abort races, unavailable services and recovery.
5. Inspect desktop and phone layouts in the browser, all basemaps, selected-drive focus and evidence images.
6. Build Android, verify bundled asset parity, run available iOS checks and audit native bridge/connection lifecycle.
7. Fix failures, rerun affected checks and the combined suite, then deliver source, build artifacts and a verification report.

## Hosting and boundaries

Recommended hosting is one HTTPS origin serving the existing GIS API under /gis/ and the static website under /gis/app/. No live server or release credentials were supplied. Test against the unchanged sample, provide saved server setup, and never invent a production connection.

The original scope deferred automatic playback, thumbnail strips, permanent statistics dashboards, heatmaps and ward overlays. Later requests added explicit drive replay and a gallery of captured frames, as recorded below. No backend, expert-review writes or invented condition scores are added.

## Historical delivery checkpoint — 30 October 2026

All six client additions above are implemented. Browser checks covered the original navigation, dark/light Video states, all map styles, combined filters, selected-drive focus, shared-view restoration, clickable canvas evidence, mobile layout and CSV export.

Final verification: 200 web tests passed with no skips, including 19 route-player tests, 1,440 independent filter scenarios and 1,440 share-link round trips. The 17 actual HTTP checks and 1,664 sample-file integrity checks from the shared data integration remain recorded. Android’s earlier full suite passed 12 JVM and 10 emulator tests, with build/lint and parity of all 14 web assets. The original-card restoration was then verified by a focused native replay/card rerun, unit/build/lint checks and final asset parity. iOS core/bridge and source checks passed; the full iOS build was pending at this checkpoint. The final Android emulator used Satellite fallback with five styles unavailable for an unconfirmed reason; earlier web/Android checks reached all six.

This checkpoint covered local implementation and tests. Its outstanding release checks were live HTTPS/CORS/image access, release signing, physical camera/GNSS/upload and a full iOS build/simulator/device run. The current section below records subsequent verification; publishing source alone does not verify deployment or physical-device behavior.

## Historical extension — camera badges and route replay

Drive distress now uses camera badges that open the same photo/details cards as citizen dots, using the original thumbnail fan and View more list for nearby overlapping observations. Explicit route replay adds a moving car, Play/Pause, Restart, distance seeking, speed and optional Follow. Reached distress brightens while upcoming markers remain clickable. The replay is approximate animation of the recorded route, not continuous video. Selected-drive state stays shared with filters, kilometres and exports; lifecycle events pause without automatic resumption. Native apps receive the same web feature, with explicit background/tab pause hooks.

Route-extension verification: **200 web tests pass with no skips**, including 19 player tests. Actual browser checks verified movement, speed, seeking, camera-card pause, portrait and landscape layouts. Android and iOS lifecycle hooks pause playback without automatic resumption.

## Historical preview-card restoration

Both layers now reuse the original repository card functions and styling: anchored thumbnail previews, click/keyboard expansion, connector lines and the grouped View more list. On phones, one preview plus View more keeps grouped results reachable. Full GIS details and confidence threshold stay in the expanded card. Selection, accuracy circles and card cleanup remain synchronized; opening a card pauses and hides the player, and closing it or pressing Escape restores the paused player. Cards stay clear of the navigation and the result-count chip.

Restoration verification: **200 web tests passed, none skipped**, including 17 original-card tests and 37 Survey integration tests. Browser checks covered citizen groups/list selection, drive preview and expanded photos, pointer close, Escape, dark/light and 375 px phone scrolling. Android’s focused card/replay regression was rerun; the previous full 10-test emulator suite is retained as earlier evidence.

## Historical map interaction repair

Compared the working website against the then-current GitHub revision `306b20d8eb4ebde7bb51ffba7eeb982a5db6ecc6` and ran that unchanged source in a separate local browser. Restored the original 3 m geographic citizen grouping, cluster sizes, night halos/dashes, repeat-selection suppression and single Top Locations focus. Citizen data now loads as a full filtered collection, capped at 5,000 with an explicit narrowing notice; dragging and zooming do not refetch, regroup or erase citizen markers. CSV remains scoped to the current view. Video uses local geographic groups and keeps loaded routes/icons while viewport queries run, marking failed refreshes explicitly.

Original initial zoom, wheel/pinch defaults and click-to-street-zoom behavior were unchanged; the regression was broad screen-sized clusters feeding that original camera flight. The original 2-second spinner/reveal sequence is restored after the flight, with reduced motion still respected. Toner contrast also matches the original stylesheet.

Final verification: **200 tests pass with no skips**. Browser checks confirmed local groups, stable counts and markers during zoom/drag, repeated selection without a new flight, Video toggle without camera movement, and replay/card pause. Android received the same source; native checks are recorded in its verification file.


## Current mobile refresh — 30 October 2026

This refresh supersedes the historical fixed-distance grouping and separate replay-photo card described above. Both observation layers use zoom-aware, pan-stable clusters. Replay and every stored frame remain inside the persistent drive card with Next/Play, a natural-aspect photo and adjacent desktop details. All recorded routes remain available. Drive mode hides citizen markers; returning to Map restores them with their saved filters. Filters use larger controls, and the legend remains inside About.

The shared web suite passes **267 tests with no failures or skips**, including complete citizen pagination, latest-assessment merging, review/capture semantics, source failures, current-UI integration and three static-publication checks. The sample-backed tests include 1,440 independent filter comparisons and 1,440 share-link round trips; that oracle test is explicitly skipped if the sample is absent.

**Android 1.0.4 (build 5)** bundles all **17** current website assets, with byte-for-byte parity verified in the debug and direct-install release APKs. Builds succeeded, **15 JVM tests passed**, and lint reported **0 errors and 125 warnings**. All **11 unique instrumentation cases passed across retained runs**; initial fixture, WebView-update and test-navigation interruptions are documented in [mobile/SURVEY_VERIFICATION.md](mobile/SURVEY_VERIFICATION.md). The existing Android debug certificate is preserved for direct installation; these are not Play Store signing builds.

Android now opens citizen observations through the original public Supabase configuration when no GIS server is saved. A saved GIS server remains an explicit choice, and its errors do not silently switch sources. The read-only live check showed **148 displayed observations out of 361 available**, with no setup dialog, working reload/recreation and no fabricated drive routes. Review filters and missing locations explain differences between matched and total counts. Video requires a connected GIS drive source; static hosting alone does not supply it.

**iOS 1.0.0 build 13** retains the configured hosted website, revalidates explicit reloads and rejects an older or incomplete dashboard. Its 34 core regression methods, injected bridge/current-UI checks, Swift syntax and full app Mac Catalyst typecheck passed. Xcode **27.2** was subsequently installed, and the complete Debug iOS Simulator build succeeded. Build 13 was installed and launched on an **iPhone 18 Pro / iOS 27.0** simulator. Native Map tiles/clusters and Browse photo previews were visually checked; Browse showed **361 observations · live data**. These checks performed no upload or database write. See [ios/SURVEY_VERIFICATION.md](ios/SURVEY_VERIFICATION.md).

Netlify and GitHub Pages stage an explicit citizen-source configuration into an allowlisted 17-asset `dist/` directory. The original public client settings are reused, private/service keys are rejected, and the source GIS configuration stays unchanged. Pages uses its own public base URL for shared views; neither static host supplies a drive API.

Production website/API deployment verification, store signing, physical-device camera/GNSS/upload checks, native iOS share/download interactions and the full hosted iOS Video flow remain separate release steps. No signed physical-device IPA is included. Source publication and app builds do not establish that the hosted website or drive API is deployed.
