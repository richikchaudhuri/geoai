# GeoAI — Android Capture and Survey App

Native Android (Kotlin) capture client for the
[GeoAI WebGIS](https://github.com/richikchaudhuri/geoai). Citizens take
photos of road damage; the app uploads them to Cloudinary, writes a
`photos` row to Supabase, and the AI pipeline picks it up from there.
Classified results surface on the WebGIS map. The **Map** action next to PHOTO
opens the same survey dashboard inside the app, with the current shared web
implementation bundled into each APK.

## Features

- **Survey map** — when a drive service is connected, all drive routes remain visible, with the total distance in
  a separate pill and a custom drive menu. Selecting a drive opens its route,
  distress summary and observations in one persistent inspector. Nearby citizen
  and video observations form numbered clusters that separate as you zoom;
  coincident observations remain accessible. Video mode hides walking/citizen
  observations; switching back to Map restores the citizen layer. Survey filters, drive focus,
  CSV export and share-view controls use the same shared dashboard.
- **Route replay and captured frames** — Replay opens inside the drive inspector
  and zooms to the car. Browse every stored frame, including normal and
  unclassified results, with thumbnails, Previous/Next, or Play. The photo and
  its details stay open while browsing; they sit side by side on wide screens
  and stack on phones. Replay supports a distance scrubber, speed selection and
  optional Follow. Native system UI/backgrounding pauses it and returning never
  resumes automatically. Its pace is approximate; stored frames are not the
  original survey video footage. The camera screen retains its capture controls.
- **Refined controls** — Filters use glass cards and larger, consistent action
  text. Settings no longer includes the Map legend button.
- **Citizen map opens automatically** — the Map action uses the same existing
  public Supabase project as photo capture. No new server setup is required.
  Settings has an optional drive-service connection and a **Citizen map**
  action to return to the existing source. A configured drive service is used
  explicitly; failed connections never silently switch data sources. No sample
  drives are substituted when a drive service is unavailable.
- **Native sharing and export** — shared-view links use Android's share sheet;
  CSV exports use the document picker, with no storage permission or unrestricted
  JavaScript-to-native interface. Files are limited to 10 MiB, server redirects
  are rejected, and cancel/retry paths keep the map available.
- **Camera** — CameraX preview with single-tap shutter, 6-second cooldown
  between captures (rate limiter), live luminance metering with a
  "Low light · try flash" pill that drops in when the scene gets dim
- **Flash toggle** — off / on / auto cycle next to the shutter, with a
  matching status pill instead of stock toasts
- **Live location** — `FusedLocationProviderClient.requestLocationUpdates`
  at a 10-second cadence (industry standard for moving-user mapping); each
  capture grabs the latest coordinates, so photos taken while walking or
  driving don't all cluster at the startup location
- **Reverse geocoding** — throttled to once per ~30 m of movement to save
  the platform geocoder
- **Crop** — custom 1:1 viewport with pinch-zoom (1×–6×) and drag-pan,
  rule-of-thirds grid overlay, and a live zoom-level badge inside the
  crop for tighter framing of small features (potholes)
- **Cloudinary upload** — unsigned upload preset
- **Supabase insert** — anon-key insert into `photos`; the project's
  Postgres trigger handles the queue handoff to the AI worker

## Stack

- Kotlin · CameraX · OSMDroid · Google Play Services Location · AndroidX WebKit
- AndroidX Core, AppCompat, ConstraintLayout, ExifInterface
- OkHttp, kotlinx.coroutines

## Build

Current application version: **1.0.4 (build 5)**.

```bash
./gradlew assembleDebug      # debug APK
./gradlew assembleRelease    # release APK (debug-signed for sideloading)
```

Output: `app/build/outputs/apk/{debug,release}/app-{debug,release}.apk`

`minSdk = 26`, `targetSdk = 36`. Android 8/9 request storage permission before
saving or opening the gallery; Android 10+ use scoped MediaStore storage.

```bash
bash gradlew testDebugUnitTest assembleDebug
bash gradlew connectedDebugAndroidTest  # requires an emulator or test device
```

The instrumented crop tests verify that saving/recycling a crop leaves the
preview usable and allows another save attempt. They do not use the camera or
contact the upload services. Failed crop writes retain the original photo and
remove incomplete replacements; capture coordinates stay with the photo through
crop review and upload.

Verified on October 27, 2026: debug APK build, JVM unit task, and Android lint
passed (lint has existing resource/style warnings and no errors). All four
instrumented tests, including the three crop/URI regressions, passed on an
isolated API 36 emulator via AndroidJUnitRunner. Android 8/9 hardware storage
and actual camera/upload behavior still require device verification.

The survey update is covered by URL/origin regression tests and Android
instrumentation tests for connection setup, recreation, bundled assets,
the native message bridge and configurable mock API access. See
[`SURVEY_VERIFICATION.md`](SURVEY_VERIFICATION.md) for the current results.

## Data connections and shared web assets

The app serves bundled assets from `https://appassets.androidplatform.net` using
`WebViewAssetLoader`. Gradle's `syncSurveyAssets` copies the root HTML,
JavaScript, CSS, favicon and fonts on every build. Update the shared website,
then rebuild Android; there is no second copy of the survey UI to maintain.

By default, the Map action reads citizen `photos` and `assessments` directly
from the existing configured Supabase project, using its existing public client
key and permissions. Those public settings are shared with photo capture in
`PublicBackendConfig.kt`. This restores the original data connection instead
of requiring a newly deployed `/gis` service. The shared adapter presents the
results through the current map, filters and evidence UI. Video is explicitly
unavailable in this mode; no drives or routes are fabricated.

**Optional drive service:** open the toolbar connection settings and enter an
HTTPS server origin. It must expose the read-only `/gis/*` API and permit CORS
from `https://appassets.androidplatform.net`. That mode uses the selected server
for citizen and video data, and shares views at its `/gis/app/` dashboard. A
failed configured service shows its error; it never falls back to another data
source. Choose **Citizen map** in the same dialog to clear the drive connection.
The choice survives relaunches and overrides a build-time drive default.

Citizen-mode share links use the existing `https://gisgeoai.netlify.app/`
dashboard. That site needs the matching shared UI deployment to reproduce new
filters exactly; building an APK does not deploy the site. Native sharing accepts
only the chosen dashboard origin and path. Citizen CSV is bounded inline data;
URL-based video exports require an explicitly configured drive server.

Set an optional drive default at build time:

```sh
bash gradlew assembleDebug -PgeoaiSurveyOrigin=https://YOUR_GIS_SERVER
```

Without that property, first launch opens the existing citizen map. Release
builds accept HTTPS only. Debug builds additionally permit HTTP on `localhost`,
`127.0.0.1` and emulator host `10.0.2.2`; other cleartext hosts remain blocked.
For the supplied local drive mock, forward the port with `adb reverse tcp:8765 tcp:8765`, then connect to `http://127.0.0.1:8765` in a debug build.

Native tests use `-PgeoaiCitizenTestOrigin=http://127.0.0.1:18766` with a local
Supabase-shaped fixture, plus `surveyTestOrigin` for the separate GIS sample.
This override is debug-only, restricted to explicit loopback development hosts,
and injects a synthetic public key. Release builds ignore it. Final debug APKs
are rebuilt with the override empty, so no test address or fixture is shipped.
The regular native tests never read or upload production observations. A separate
explicit read-only startup check can use `surveyLiveReadSmoke=true`; it is not
part of the default test run and never uploads data.

Map tiles and live data require network access. The app does not bypass TLS
errors or expose an unrestricted native JavaScript interface. Store release
still needs the owner's signing configuration and device capture/upload checks.
See [`SURVEY_VERIFICATION.md`](SURVEY_VERIFICATION.md) for actual build and test
results, including the limits of verification.

## Configuration

The Cloudinary preset and Supabase keys are baked into the source code.
If you fork, replace these in:

- `CloudUploader.kt` for the Cloudinary cloud and unsigned preset
- `PublicBackendConfig.kt` for the shared public Supabase URL and anon key

## Authors

Suraj · Richik Chaudhuri · Sushant Deo — Capstone Project, BMSCE,
Bengaluru · April 2026
