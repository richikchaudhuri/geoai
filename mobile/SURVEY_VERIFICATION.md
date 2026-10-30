# Android survey verification

Updated 30 October 2026 for **1.0.4 (build 5)**.

## Restored startup and data source

Map now opens the existing citizen database automatically, using the same public
Supabase project settings as the unchanged photo upload flow. The prior survey
integration incorrectly required a new `/gis` server even though the original
project read citizen results directly from Supabase. That setup gate is removed.

Settings now offers an **optional drive connection**. An explicitly configured
GIS service supplies `/gis/*` data and never silently falls back on failure.
**Citizen map** clears that selection and returns to the existing citizen data;
the choice persists across recreation and overrides a build-time GIS default.
Without a connected drive service, Video clearly reports that drive routes are
not connected. It never substitutes sample routes or frames.

The shared dashboard retains glass filters, larger action text, clustering,
and citizen evidence. With a drive service connected, it retains all routes,
the separate distance pill, custom drive menu, persistent right-hand inspector,
all stored frames and embedded replay that zooms to the car. Video hides citizen
markers; Map restores them. Native backgrounding and dialogs pause replay.

Sharing uses the chosen dashboard origin; citizen CSV remains a bounded inline
export, and URL-based video exports require a configured GIS service. The
existing Netlify dashboard must deploy the matching UI for shared links to
reproduce every new filter. This APK build does not deploy that site.

## Verification results

- Debug and release APKs built successfully with JDK 17, Android SDK 36 and
  Gradle 8.13, including release vital lint. Application ID remains
  `com.example.msc`; version is 1.0.4, code 5.
- All **17 bundled web assets** in both APKs match the final shared source
  byte for byte, including `citizen-source.js` and the latest `app.js` comment.
  Both final builds have empty test and GIS-origin overrides.
- **15 JVM checks passed**, none skipped. Android lint reports
  **0 errors and 125 warnings**.
- All **11 unique native instrumentation cases** have successful coverage
  across the retained fixture runs: crop/URI/package checks, configured GIS
  access, the complete map, filters/clustering, persistent all-frame replay,
  native CSV rejection/cancellation, bundled injection, default citizen startup,
  and optional connection/return behavior. No fixture case remains failing.
- The default-citizen test proves no setup panel, usable citizen data, no invented
  drive sessions, explicit Video unavailability, reload and recreation. The
  source-switch test proves failed GIS stays selected until the user chooses
  Citizen map, which restores data and persists across recreation.
- A separate authorized **read-only live startup test passed** using the final
  default APK: **148 displayed citizen observations out of 361 available**, no
  setup dialog, no drive sessions, and successful reload/recreation. No record
  was created, updated or uploaded.
- The shared web test suite passed **264 tests** (reported by the web owner).

The first fixture run encountered a malformed local fixture response, then an
emulator-initiated WebView update killed the test process. The fixture was fixed.
Two later checks evaluated JavaScript during a page replacement; the test now
waits for the native page-load indicator before examining the replacement page.
The affected checks passed on rerun without changing application behavior to
hide failures. Initial failure logs and successful reruns are preserved.

## Artifacts and signing

- `geoai-android-1.0.4-debug.apk`: default citizen connection, with debug-only
  local development connection support.
- `geoai-android-1.0.4-sideload.apk`: release variant, HTTPS connections only.

Both signatures verified with the existing Android Debug certificate, allowing
in-place upgrades over the earlier supplied APKs. The release variant is for
sideloading, not Play Store distribution.

Debug APK SHA-256:
`884b4f1a27876942d859ccc321e61300a9bb29ab0c686344973ee68f0123e92a`

Sideload APK SHA-256:
`8f2404a0d76479ec2932a2c4ec7ee6df4ba4bed4f498a5652cbc00cc52aee4c9`

## Remaining deployment/device checks

No physical phone was changed, no photo was uploaded, and no remote service was
deployed. Real camera/GNSS, Android 8/9 storage, low-memory hardware and final
share/save destinations still need physical-device verification. Drive data
requires a real compatible GIS service when one becomes available. Map tiles
and live citizen data require network access. Store release requires the owner's
production signing setup. Rebuild after future shared website edits before
distributing another APK.
