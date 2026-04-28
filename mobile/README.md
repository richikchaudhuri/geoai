# GeoAI — Mobile Capture App

Native Android (Kotlin) capture client for the
[GeoAI WebGIS](https://github.com/richikchaudhuri/geoai). Citizens take
photos of road damage; the app uploads them to Cloudinary, writes a
`photos` row to Supabase, and the AI pipeline picks it up from there.
Classified results surface on the WebGIS map.

## Features

- **Camera** — CameraX preview with single-tap shutter, 5-second cooldown
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

- Kotlin · CameraX · OSMDroid · Google Play Services Location
- AndroidX Core, AppCompat, ConstraintLayout, ExifInterface
- OkHttp, kotlinx.coroutines

## Build

```bash
./gradlew assembleDebug      # debug APK
./gradlew assembleRelease    # release APK (debug-signed for sideloading)
```

Output: `app/build/outputs/apk/{debug,release}/app-{debug,release}.apk`

`minSdk = 34`, `targetSdk = 36`.

## Configuration

The Cloudinary preset and Supabase keys are baked into the source code.
If you fork, replace these in:

- `MainActivity.kt` / `CloudUploader.kt` for Cloudinary cloud + preset
- `SplashActivity.kt` and the network calls for Supabase URL + anon key

## Authors

Suraj · Richik Chaudhuri · Sushant Deo — Capstone Project, BMSCE,
Bengaluru · April 2026
