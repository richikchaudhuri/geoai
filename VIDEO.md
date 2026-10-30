# GEOAI survey integration

This revision preserves the original glass map shell, logo/About link and expanding navigation pills. Video is a small camera icon until selected; the shared highlight is black in light mode and white in dark mode. Selecting other navigation collapses the pill while preserving the layer. Clicking selected Video again turns it off. Drive features below require a GIS source. With an explicit direct citizen source, Video explains that drive routes are not connected and makes no drive API requests.

## Default view and map preparation

Video is off by default. Enabling it adds drive paths, actual distressed segments and a small kilometres pill. It never pans, zooms, opens evidence or changes the basemap. While Video is enabled, walking/citizen markers and their photo cards are hidden, and the status pill reports drive distress. Tapping Map disables Video and restores the citizen layer with its saved filter preference. Loaded citizen data and explicit CSV export remain available; Top citizen locations is available in Map mode. Extra controls open only on request through the existing Filters, Settings and About surfaces.

The opening screen waits for citizen data readiness and current-viewport map preparation. Six styles share three retained vector renderers and a satellite layer. Switching reveals a prepared map; a candidate still loading keeps the current working map visible. Hidden maps remain aligned after movement. Primary attempts, fallback and the final opening deadline are bounded. If every primary provider fails, the standard street-map fallback is attempted. New areas and zoom levels still need network tiles. This is not offline map storage.

## Six additions

1. **Shared filters**: metadata-driven distress types, multiple severities, review states, high confidence, inclusive IST dates, citizen visibility and pending review. Day means 06:00–18:00 IST and night is the remaining hours; this client-side clock filter is explicitly labelled. A drive selection affects Video only. Top Locations reflects the current citizen results and clears during errors/loading.
2. **Evidence**: click a result for its supplied preview image, final labels, struck original labels when corrected, confidence including zero, authoritative review state, IST time and positional uncertainty. Video also shows drive/road, distance along route, gate and frame quality. Full resolution requires an explicit link. Missing images show placeholders. Selected-drive photos open inside the persistent right-hand card. Citizen and All drives evidence retain the anchored thumbnail cards, click-to-expand details and grouped View more list; phone groups show one preview plus View more. Every member of a coincident or maximum-zoom cluster remains individually selectable.
3. **Drive comparison**: show date, processing state, recorded distance, distressed metres and percentage; sort by date/metres/percentage. Selecting a drive in the menu below the total focuses and highlights it without hiding other routes; All drives restores the overview. The Focus route / Show all routes button can refit the view. These are whole-drive catalogue statistics, labelled separately from filtered viewport results.
4. **CSV export**: export the current map area and current filters with complete pagination, UTF-8 BOM and spreadsheet-formula protection. Changing the view, filters or layer invalidates an in-flight export. More than 20,000 rows asks for a narrower view; native exports also have a 10 MiB limit. Day/night video export uses the same client-filtered GeoJSON as the map; other video exports paginate the API CSV and validate totals before and after.
5. **Share view**: Settings copies a validated link encoding camera, zoom, style, layer state and filters. Clipboard denial exposes a selectable link. Android/iOS use native sharing with an explicit public dashboard URL, never an internal asset URL.
6. **Legend**: About contains the metadata legend, including colours, severity sizes, marker shapes and data caveats. The separate Map legend button has been removed from Settings.

The Filters panel uses collapsible rounded glass cards, severity/type selection pills, a sticky heading and Clear filters action. It adapts to light/dark themes and phone widths. Shared text actions use 16 px type and at least 44 px touch targets, including drive and replay controls. This presentation update preserves all filter defaults, data selection and counts.

Keyboard search and reduced-motion support remain available. No automatic playback, heatmap or ward overlay is introduced. Route replay and its captured-frame gallery open only on request, as described below.

## Route replay

Enable Video, then select **Replay drive**, or use Replay drive on a drive in Filters. The player opens inside the right-hand drive card and selects one drive. It starts paused and zooms to the car at street level, with room for the replay controls. Clicking Replay again returns to the car’s current position without resetting its progress. Play/Pause, Restart, 1×/4×/8×/16× speed and a distance slider control a moving car; Follow is optional and turns off when the map is dragged. Selecting a replay drive also selects that drive in the shared filters, so viewport counts and exports use that drive. All route lines remain visible and the total kilometres always cover all recorded drives.

The player loads complete filtered distress for the chosen drive, rather than only the current viewport. Camera badges are faded ahead and brighten once their `s0_m` is reached; clustered badges reflect progress across their members. Every badge remains clickable. Selecting an observation pauses replay and opens its photo/details inside the drive card, where Next and Play remain available. Video result counts and CSV exports use the current area; citizen counts use the whole filtered collection. Marker groups remain stable when panning and regroup when zoom changes. Filter changes pause and refresh the replay; closing it restores the ordinary overlay. Video off removes both replay and its marker state.

This is an animation of the recorded route, not continuous video playback or measured instantaneous vehicle speed. Recorded start/end times set the approximate total pace; absent times fall back to a clearly approximate pace. Distance is mapped over the valid track geometry. MultiLineString gaps are skipped without joining them into invented road. The player pauses when the browser is hidden, on page exit, when native apps background and when iOS leaves the survey tab. It does not resume automatically.

## Data semantics

- GIS mode uses `geoai.gis.v1`, `/gis/meta` styles and final labels for both layers. Direct citizen mode normalizes database rows to the same feature shape and uses the existing GIS taxonomy plus original RDD label styles bundled in `citizen-source.js`. Review state and expert-correction fields are authoritative; confidence alone does not imply a human reviewed a result.
- Video queries `vlm_class=distress`. Normal, pending, unknown, skipped and uncovered rows are not displayed as distress. Distressed rows with severity `None` are retained.
- Individual Video camera badges open photo evidence, inline when a drive is selected. Numbered clusters expand or expose all their members as described below. At street zoom, supplied footprints remain a noninteractive underlay. Missing positions are skipped. Individual badge colour follows metadata and size follows severity, scaled for visibility inside a 32 px click target; numbered cluster badges are 40 px. Drive LineString/MultiLineString gaps are preserved.
- Recorded distance sums `route_m` once per unique drive across the entire catalogue, including while one drive is selected or replaying. The sample totals 4,060.31 m (displayed 4.06 km). It does not depend on viewport or distress filters. Repeat passes count again: this is recorded travel, not unique road coverage or a live odometer. Missing or unknown drive distances show unavailable, not zero.
- The sample has 164 distressed segments, 140 awaiting review; all 813 video segments include 389 awaiting review. Seven distressed segments have severity `None`. Citizen defaults are 131 classified observations, or 344 when pending review is included.
- Hover/selection uncertainty uses `position_sigma_m`. Unmarked road is not confirmed Normal. About retains the model-recall/GPS caveats. Ellipsoidal height is never labelled as height above mean sea level.

## Map clustering

Citizen observations and Video distress each use a 40 px grouping radius at the current zoom. Groups are anchored to actual observations in projected world coordinates, so panning does not rearrange them. Zooming in separates nearby observations; zooming out gathers them into numbered badges. This replaces fixed-distance grouping that left overlapping markers at overview zoom. Citizen night styling and Video severity colours remain visible.

Clicking a cluster whose observations are spread apart fits its members and zooms closer, up to three levels at a time and within the map’s maximum zoom. Coincident observations, or groups already at maximum zoom, open evidence with every member available to inspect. Grouping never drops observations or changes result counts, exports, recorded distance or the displayed drive routes. Normal and other non-distress stored frames remain available in the complete replay gallery without becoming distress markers.

## Read-only GIS endpoints

```
GET /gis/meta
GET /gis/citizen/assessments.geojson
GET /gis/video/sessions?track=true&per_km=false
GET /gis/video/segments.geojson?vlm_class=distress&geom=point|footprint&bbox=...&limit=...&offset=...
GET /gis/video/summary
GET /gis/video/segments.csv
GET supplied preview/original URLs (original only on explicit click)
```

Metadata, citizen observations and the drive catalogue load at startup. Video segments wait until Video is enabled; CSV/summary are requested for export. Catalogue failure does not block citizen data. Separate error/retry states prevent one unavailable service from falsely emptying another layer.

Requests have deadlines, stale-response cancellation and strict paging/count/deduplication validation. Metadata/catalogue and the recent Video viewport cache last 60 seconds. More than 5,000 Video map matches requests a narrower view. Citizen requests load the whole filtered collection up to 5,000 and explicitly ask for narrower dates or filters when capped. Failed refreshes mark counts unavailable and identify previously loaded observations that remain visible; retries run after 30 seconds; successful layers do not poll. One shared canvas lets citizen and video features both receive clicks.

The default website uses these GIS endpoints. The explicit direct citizen mode below uses Supabase instead; neither mode silently substitutes the old snapshot or switches sources after a request fails. Existing native capture/upload and legacy snapshot tools remain separate.

## Direct citizen source

Set `GIS_CONFIG.dataSource` to `'supabase'`, with `supabaseUrl` and `supabaseAnonKey`, to read the original `photos` and `assessments` tables through the current map UI. Only a public publishable or anon key is accepted. This is an explicit source choice, not a fallback from a failed GIS connection. Android with no saved GIS server injects its existing public citizen configuration automatically; choosing a GIS server preserves the full GIS mode. The default standalone web `config.js` remains same-origin GIS mode.

The adapter reads both tables with stable ordering and exact-count pagination, rejecting incomplete/changing counts and duplicates rather than showing a first-page total. It joins the latest assessment per photo, suppresses obsolete assessments, respects reviewed corrections and preserves original label text. An explicit null capture time stays unknown; only older records lacking the capture-time field use upload time as a labelled proxy. Direct citizen date/day filters use that capture time. The usual `includeReview=false` default remains unchanged.

Counts show matching observations out of the complete available total, with explanations for awaiting expert review, awaiting assessment and missing locations. Unlocated records remain counted but are not plotted; map-area CSV exports contain located matching rows. Existing filters, zoom-aware clustering, persistent photo cards and CSV exports remain in use. Verified empty responses are shown as empty live results; errors are displayed without a frozen-data fallback.

This source supplies no drive catalogue, route geometry or video frames. Video shows an explicit not-connected message and disables replay. Connect a real video GIS server when available to enable those features. Public share links require the current website and matching source configuration at `shareBaseUrl`; rebuilding an app does not deploy that website.

## Run and deploy

Unzip the supplied ZIP next to this repository and run from the repo:

```sh
python3 ../gis_sample/mock_server.py --app .
```

Open `http://127.0.0.1:8765/gis/app/`. The sample is unchanged; clients use API URLs, not local sample paths.

For full drive surveys, use one HTTPS origin for `/gis/app/` and `/gis/`. Defaults in `config.js` are empty `apiBase` and `shareBaseUrl`, meaning same-origin GIS hosting. Separate hosting in GIS mode requires a configured HTTPS API and CORS; direct citizen hosting uses the public Supabase configuration above. Android's bundled WebView requires its chosen data service to permit `https://appassets.androidplatform.net`. iOS Video saves the deployed dashboard URL. No live drive API address was supplied or invented. The page declares `geoai-survey-ui-version=20261030` in an HTML meta tag. This is the mobile compatibility baseline for the all-drives menu, persistent frame card and zoom-aware clustering; keep the marker and its matching scripts/styles together when deploying.

Deploy `index.html`, `app.js`, `styles.css`, `basemaps.js`, `config.js`, `gis-core.js`, `citizen-source.js`, `video.js`, `video.css`, `survey.js`, `survey.css`, `drive-player.js`, `drive-player.css`, `drive-inspector.js`, `drive-inspector.css` and `fonts/`. Retain provider attribution. Rebuild Android after shared website changes so bundled files match. No push/deployment has been performed.

## Verification and release boundaries

- All 264 web regression tests pass, covering the dashboard/map/startup, Video and citizen clustering, Survey integration, route player, persistent photo cards and core behavior. Direct-source tests cover 357 observations across capped pages, canonical merging, review/capture semantics, failures, truthful totals, disabled drives and integration with the current UI. The core suite includes 1,440 independently evaluated filter combinations and 1,440 share-link round trips when the supplied sample is present. These automated tests make no production requests.
- 17 real local HTTP checks cover known counts, dates, paging, geometry, CSV, previews and invalid inputs. Run `node tools/verify-gis.cjs` while the mock runs.
- Actual desktop/375 px browser checks covered navigation, filters, drive focus, shared views, evidence and export. Route replay was also checked at desktop, 375×812 portrait and 812×375 landscape, including actual icon clicks, seeking and evidence-pause. All six basemaps were checked; earlier Android testing reached all six ready states. The final updated-WebView emulator run used Satellite with five styles unavailable; the cause is unconfirmed.
- Earlier Android 1.0.2 build 3 verification passed debug/release builds, 12 JVM tests, lint and both targeted API 36 map/replay tests; its 16 bundled assets matched that revision. The preceding build 2 full 10-test emulator run also passed. Those results remain historical GIS-mode evidence. Current direct-source builds and verification are recorded in `mobile/SURVEY_VERIFICATION.md`; the new `citizen-source.js` must be included in bundled-asset parity checks.
- iOS build 13: 34 core regression methods including 1,000 URL/origin property cases, native bridge/current-dashboard checks, Swift syntax and complete Mac Catalyst typechecking passed. It also compiled with Xcode 27.2 and launched on an iPhone 18 Pro simulator running iOS 27.0. The native Browse screen was visually verified with 361 live observations on October 30, 2026. This read-only check did not upload a photo or exercise a physical camera. Explicit reload revalidates website caches; hosted Video still requires the matching website deployment. See `ios/SURVEY_VERIFICATION.md`.

These checks cover automated client integration against fixtures plus the separately identified native iOS live-read preview. Hosted Video HTTPS/CORS/image access, production signing and physical camera/GNSS/upload checks remain release work. No live drive API, GPU pipeline or expert-review service is supplied by this repository.

## All-drives menu update — 30 October 2026

Every usable recorded route remains on the map during drive inspection and replay. The menu below the total lists every drive, including those without a usable track, and shows selected date, state, recorded distance and distress statistics. Focus and replay are disabled when a route is unavailable. Catalogue routes render before viewport distress requests finish and remain available if those requests fail.

The Android mobile refresh includes this menu in its bundled website. iOS loads the configured hosted website, which must receive this complete web revision before the new iOS build can use it.

## Video card presentation

The total distance is a separate glass pill above the drive inspection card. Its numeric value uses the bundled Rostex Outline logo font; units and controls use the larger Urbanist text. Enabling Video introduces the distance pill first, then the controls card 160 ms later. Reduced-motion preferences disable this entrance animation. Route loading, totals, drive selection and replay behavior are unchanged.

## Drive menu and inspection panel

The custom drive menu lists each recorded drive with its date and distance and supports keyboard selection. Selecting a drive highlights and fits its route while retaining every other recorded route. A panel below the desktop search/settings controls shows the recorded route outline, catalogue statistics, whole-drive filtered distress labels and individual observations. Selecting an observation shows its photo and details inside this same drive card. On phones, the panel uses a scrollable bottom sheet.

Panel observations are fetched for the selected drive without a viewport limit. They follow the active distress filters; catalogue statistics retain their whole-drive meaning. Label counts can overlap because a segment can have several labels. Up to 5,000 results are supported; a larger result asks for narrower filters. Loading, failure and an empty result have separate states. New selections cancel old requests, and map panning does not restart the panel request. Video off or All drives closes the panel. Existing viewport counts and exports retain their current-area scope.

## Replay inside the drive card and all stored frames

Replay controls now live inside the right-hand selected-drive card, with the same bottom sheet on phones. During replay the miniature route and duplicate summary actions yield space to the player; the main map still retains all drive routes. Opening Replay focuses the car with space reserved for this card. Closing Replay returns to the route overview and distress panel.

The Captured frames section loads every stored representative frame for the selected drive, including normal, pending and skipped classifications, independently of map bounds and distress filters. The sample has 230, 55 and 528 records across its three drives. This is the complete stored segment-frame collection exposed by the GIS API, not every raw video frame. Preview images follow distance during replay; previous/next and thumbnail selection pause and move to that frame’s distance. Photo details expands metadata in place inside the drive card. The gallery reveals twelve thumbnails at a time through Show more, with every record reachable. Missing or inaccessible photos have explicit placeholders, and a missing frame distance does not invent a map position.

`Client.driveFrames(session, meta, { signal, max: 20000 })` uses `/gis/video/segments.geojson` with session, point geometry and paging only, omitting the distress-class and other map filters. Responses are validated for pagination, duplicates and session identity. More than 20,000 records produces an explicit limit state rather than a partial gallery. Frame loading failures can be retried without disabling route playback. Drive switches and closing Replay cancel old requests. Supplied preview/thumbnail URLs are validated; full-resolution photos remain an explicit details action.

The initial in-card replay update was verified with 228 passing web tests and actual desktop, 375×568 portrait and 812×375 landscape browser checks. Live checks included 230/528-frame drive counts, frame stepping, thumbnail expansion, evidence opening, playback-synchronized preview and car visibility. No native app rebuild or production deployment was performed.

## Persistent photo inspection

Selected-drive map markers and distress rows now share the right-hand card with replay. Photo details expand in place and remain expanded while Previous/Next changes the frame. The preview has its own Play/Pause control, so inspecting a photo does not require closing another card or scrolling back to restart playback. Opening the current photo’s details preserves its exact replay progress. Clicking an observation pauses and moves to its recorded distance, without starting a second evidence card.

On desktop, expanded photo details use a wide side-by-side layout: the image retains its natural aspect ratio, with metadata alongside it. The photo navigation and Play/Pause controls stay available while browsing. On smaller screens the image and metadata stack inside the same card.

When replay is closed, a selected-drive photo appears inline with Previous/Next controls for the filtered distress observations. Closing this photo leaves the drive card open. Existing citizen/all-drives evidence behavior is unchanged. Inline metadata retains the existing authoritative review wording, capture time, confidence and supplied photo URLs. Full-size photos are an optional separate link.

The current photo layout and clustering update passes all 246 web tests, including zoom regrouping, stable groups during panning, cluster expansion and access to every coincident or maximum-zoom member. Current browser checks confirmed the two-column photo layout at 1280 px, no horizontal overflow at 375 px, and expanded details remaining open through Next and Play. Earlier browser checks verified repeated photo navigation, same-drive map-marker clicks, direct playback from the photo, and non-replay observation browsing while the drive card remains visible.


## Drive-only map mode

Video/drive mode hides the walking/citizen layer and closes its evidence cards. It retains all drive routes, clustered drive distress, the inspector and frame gallery. Citizen data and the user’s citizen visibility/filter choices are preserved; switching to Map restores them without an extra fetch. Citizen refreshes, filtering and zooming cannot bring walking markers back while drive mode is active. The status pill follows the active mode, and citizen Top Locations asks the user to return to Map.

Verification: all 251 web tests pass, including initial Video links, pending citizen responses, filter changes, evidence lifecycle and repeated mode switching. Browser checks verified Video-only markers, Map restoration and return to Video. Android 1.0.2 build 3 contains the same shared files; iOS build 13 receives them when its configured website is updated.
