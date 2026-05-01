# GeoAI: A Civic-Scale Pavement Distress Detection System

## Technical Implementation Report

**Authors:** Suraj · Richik Chaudhuri · Sushant Deo
**Institution:** Department of Information Science & Engineering, B.M.S. College of Engineering, Bengaluru, India
**Date:** April 2026
**Project Repository:** https://github.com/richikchaudhuri/geoai
**Live Deployment:** https://gisgeoai.netlify.app

---

## Abstract

We present **GeoAI**, an end-to-end civic-technology system that converts citizen-captured smartphone imagery of road surfaces into actionable maintenance intelligence for municipal authorities. The system comprises three integrated client-facing components — a native Android capture client, a cloud-mediated classification pipeline, and a web-based geospatial visualisation dashboard — all reading from a single source-of-truth Postgres database. Pavement distress is classified by a two-stage Qwen2.5-VL-7B vision-language model fine-tuned on the RDD2022 and GAPs V2 datasets, yielding both distress-type taxonomy assignments and continuous-valued severity estimates. The dashboard, developed as a static web application, surfaces classified observations on a multi-style Leaflet map with sub-second cluster rendering, civil-twilight day/night marker classification, cascading filter panels, and a JARVIS-inspired anchored detail-card system. This report documents the design rationale, technical implementation, and engineering decisions that produced a deployable civic-tech artefact within a single academic year.

**Keywords:** civic technology, vision-language models, geographic information systems, road damage detection, edge–cloud architecture, mobile capture, serverless caching.

---

## 1. Introduction

### 1.1 Motivation

Municipal road-maintenance departments in dense urban environments such as Bengaluru — population ≈14 million, road network ≈14 000 km — face a fundamental data-asymmetry problem. Citizens directly experience pavement distress (cracks, potholes, surface raveling) thousands of times per day, but the channels through which that lived experience reaches the maintenance department are bottlenecked by manual inspection schedules, complaint-portal friction, and the absence of geographic visualisation. The Bruhat Bengaluru Mahanagara Palike (BBMP), the city's civic body, has neither the inspector headcount nor the real-time map infrastructure to triangulate where damage is concentrated at any given moment.

GeoAI addresses this asymmetry by enabling citizens to submit a single photograph of road damage with one tap, automatically classifying that photograph through a vision-language model, and surfacing the geographically aggregated result on a hotspot map intended for civic-authority consumption. The contribution of this work is neither the underlying machine-learning model (which builds on prior public datasets) nor the database technology (Supabase Postgres), but rather the **systems integration** that produces a usable end-to-end civic artefact from these components.

### 1.2 System Overview

The system flow is captured in Figure 1.

```
┌────────┐   JPEG    ┌────────────┐
│Citizen │──────────▶│ Cloudinary │
└────────┘           │   (CDN)    │
    │                └─────┬──────┘
    │ metadata + GPS       │
    ▼                      │
┌──────────┐  trigger      │   image bytes
│  photos  │─────┐         ▼
│  table   │     │   ┌──────────────┐
└──────────┘     ▼   │   AI Worker  │
            ┌─────────┐  Qwen2.5-VL │
            │assessmts│◀──┤A5000 GPU │
            │  table  │   └──────────┘
            └────┬────┘
                 │ public read (RLS)
                 ▼
            ┌────────────┐
            │   WebGIS   │──▶ Civic
            │ (Leaflet)  │    Authority
            └────────────┘
```
*Figure 1. End-to-end data flow. Components rendered in this report's repository are the **mobile capture client** and the **WebGIS dashboard**; the AI worker and database schema reside in the project's broader infrastructure repository.*

The system is organised around a **database-as-message-queue** pattern: the Supabase `photos` table receives raw uploads from citizens, an `AFTER INSERT` Postgres trigger atomically creates a corresponding `assessments` row with `status='pending'`, an asyncio worker on an NVIDIA RTX A5000 polls for pending rows using `SELECT ... FOR UPDATE SKIP LOCKED`, and the worker writes back classification results, severity estimates, and per-stage confidence scores. The WebGIS reads the public-readable subset of `assessments` and renders it geospatially.

This pattern was chosen over a dedicated message-queue technology (RabbitMQ, Redis Streams) because Postgres's row-level locking semantics are sufficient for the project's expected throughput (≤1 photo/second ingest), and consolidating the queue and the source-of-truth into a single transactional system eliminates an entire class of consistency bugs.

---

## 2. Mobile Capture Client

### 2.1 Platform & Stack

The mobile client is a native Android application written in Kotlin, targeting `minSdk = 26` (Android 8.0 Oreo) to cover approximately 94 % of active Android devices in the Indian market. The choice to target Android natively rather than via a cross-platform framework (Flutter, React Native) was driven by three concerns:

1. **CameraX integration depth.** CameraX exposes lifecycle-aware preview, capture, and image-analysis use-cases that are critical for the live luminance metering described in §2.4. Cross-platform wrappers add latency.
2. **Sub-100 ms shutter responsiveness.** Native Kotlin avoids the bridge-marshalling overhead of cross-platform frameworks.
3. **OSMDroid map view.** The location-preview pane uses OSMDroid (a Java/Kotlin Leaflet analogue) for offline tile caching, which integrates seamlessly into the Android view hierarchy.

The full mobile dependency graph is enumerated in Table 1.

| Component | Library | Version |
|---|---|---|
| Camera preview & capture | androidx.camera.{core,camera2,lifecycle,view} | 1.3.x |
| Location | com.google.android.gms.location | 21.x |
| Map preview | org.osmdroid:osmdroid-android | 6.x |
| HTTP client | com.squareup.okhttp3:okhttp | 4.12.x |
| Async | org.jetbrains.kotlinx:kotlinx-coroutines-android | 1.7.x |
| EXIF parsing | androidx.exifinterface | 1.3.x |
| UI binding | viewBinding | (gradle plugin) |

*Table 1. Mobile dependency manifest.*

### 2.2 Camera Pipeline

The capture flow is implemented in `MainActivity.kt` and invoked through three CameraX use-cases bound to the activity lifecycle:

1. **Preview** — surfaces the live camera feed to a `PreviewView` in the activity layout.
2. **ImageCapture** — configured with `CAPTURE_MODE_MINIMIZE_LATENCY` and dynamic flash mode (off/on/auto), persisted to `SharedPreferences` so user preference survives application restart.
3. **ImageAnalysis** — sub-samples the Y-plane of incoming preview frames at approximately 1 Hz, computes mean luminance over an 8-pixel-stride sample, and posts a "Low light · try flash" pill notification when the mean drops below 80/255 ( ≈31 % brightness) and flash mode is currently off.

Captured photographs are written to the device's `MediaStore.Images` collection at `Pictures/msc/`, then transferred to a custom 1:1 crop activity (§2.3) before upload.

A persistent six-second inter-capture cooldown is enforced both visually (a circular-progress ring around the shutter button) and in `SharedPreferences` (`shutter_cooldown_end` timestamp), so that closing and re-opening the application during a cooldown does not reset the rate-limit window.

### 2.3 Crop View

A custom `CropImageView` (extending `android.view.View`) implements a fixed-position 1:1 crop window with two-finger pinch-to-zoom (1×–6×) and single-finger drag-to-pan. The implementation departs from the off-the-shelf `image_cropper` library in three respects:

1. **Crop window position is invariant under transform.** The image rectangle (`imageRect`) translates and scales while the crop rectangle (`cropRect`) remains anchored at the view centre, providing a more conventional "framing" mental model than transforms-on-crop.
2. **Pointer-tracking generalises to ≥3 fingers.** A naive implementation that assumes the surviving pointer after `ACTION_POINTER_UP` is always the opposite-index finger fails when more than two fingers are simultaneously down. Our implementation iterates the remaining-pointer set and selects the first non-departing pointer, falling back to `INVALID_POINTER_ID` if none remain.
3. **Crop bounds enforce a 64 px minimum.** Heavy zoom combined with extreme pan can produce a 1×1 pixel bitmap that is degenerate for downstream classification. A floor of 64 px ensures the AI model receives a usable input.

A live zoom badge (e.g. "2.4×") is rendered in the top-right of the crop window when scale exceeds 1.001×, providing user feedback during gesture interaction.

### 2.4 Location Subsystem

The location subsystem represented the most consequential bug in the early-prototype phase: photographs taken at different physical locations during a single application session were all tagged with the coordinates obtained at application launch. The root cause was that `FusedLocationProviderClient.getCurrentLocation()` was called once in `onCreate()` and the resulting `lastKnownLat/Lng` fields were never refreshed.

The corrected implementation uses `requestLocationUpdates()` with a `LocationRequest` configured for `Priority.PRIORITY_HIGH_ACCURACY` and a 10-second interval. A `LocationCallback` is registered in `onResume()` and removed in `onPause()`, so location services run only while the activity is in the foreground, conserving battery. Each capture grabs whichever fix is current at shutter time, ensuring photographs taken while moving are tagged correctly.

Reverse-geocoding via `android.location.Geocoder` is performed off the main thread on `Dispatchers.IO` to prevent ANR (Application Not Responding) errors, and is throttled to occur only after the device has moved at least 30 metres from the previously geocoded position. Distance is computed via the Haversine formula:

```
d = 2R·arcsin(√(sin²(Δφ/2) + cos(φ₁)·cos(φ₂)·sin²(Δλ/2)))
```

with R = 6 371 000 m.

### 2.5 Network Layer

Image transfer to Cloudinary uses the platform's unsigned upload preset (`photos` on cloud `dnxpt5gea`) via OkHttp's multipart form upload. Upon Cloudinary success, the returned `secure_url` and image dimensions are bundled with the captured location and POSTed to Supabase's PostgREST endpoint at `/rest/v1/photos`. Because the mobile client uses Supabase's anonymous JWT (which is safe in client code per Supabase's design — Row Level Security is the access gate), no per-user authentication is required.

---

## 3. Cloud Database Layer

### 3.1 Schema

The relevant subset of the Supabase Postgres schema is documented in Table 2. Columns marked (*) are written by the AI worker after classification; columns marked (**) are populated by the mobile client at upload time.

| Column | Type | Source | Purpose |
|---|---|---|---|
| `id` | UUID PK | DB | Internal assessment identifier |
| `photo_id` | BIGINT FK | Trigger | Links to `photos.id` |
| `image_url` | TEXT | ** | Cloudinary CDN URL |
| `latitude`, `longitude` | DOUBLE PRECISION | ** | GPS coordinates |
| `address` | TEXT | ** | Reverse-geocoded |
| `status` | TEXT enum | DB / Worker | pending / processing / classified / expert_review / done / failed |
| `stage1_label` | TEXT | * | "Normal" or "Distress" |
| `stage1_confidence` | REAL | * | First-token softmax probability |
| `distress_types` | JSONB array | * | e.g. `["Pothole (D40)"]` |
| `severity` | TEXT enum | * | None / Low / Medium / High |
| `stage2_confidence` | REAL | * | Geometric mean of per-token probabilities |
| `description` | TEXT | * | AI-generated single-sentence description |
| `needs_expert_review` | BOOLEAN | * | True if either confidence < 0.8 |
| `expert_corrected_types`, `expert_corrected_severity`, `expert_notes` | JSONB / TEXT | Expert UI | Human-in-the-loop corrections |
| `created_at`, `processed_at` | TIMESTAMPTZ | DB | Upload time, AI completion time |

*Table 2. The `assessments` table — schema relevant to WebGIS and mobile client.*

### 3.2 Row Level Security

Two RLS policies govern access to the public-facing tables:

```sql
-- on public.photos
CREATE POLICY "Public read photos"
    ON public.photos FOR SELECT USING (true);

-- on public.assessments
CREATE POLICY "Public read classified assessments"
    ON public.assessments FOR SELECT
    USING (status IN ('classified', 'done', 'expert_review'));
```

The first permits the WebGIS to read every uploaded photograph. The second restricts visibility to assessments whose status indicates terminal or near-terminal pipeline state, suppressing the in-flight `pending`, `processing`, and `failed` rows that would clutter the civic-authority view with rows of indeterminate quality. INSERT, UPDATE, and DELETE permissions on both tables remain restricted to the service role used by the AI worker and (currently) the mobile client.

---

## 4. WebGIS Dashboard

### 4.1 Architectural Choices

The WebGIS is a static single-page web application with no build step. It is served as three plain files (`index.html`, `app.js`, `styles.css`) plus a custom font and a favicon. This decision deserves commentary, as the contemporary default in web engineering is to introduce a build pipeline (Vite, Webpack, Rollup) at project inception.

The case for vanilla static rather than a build-pipelined SPA framework rests on three observations:

1. **The application is approximately 2 200 lines of JavaScript.** It does not benefit materially from tree-shaking, code-splitting, or hot-module replacement. The cognitive overhead of build-pipeline configuration exceeds the performance gain.
2. **Deployment is one folder drag onto Netlify Drop, or one `git push` to a Netlify-connected repository.** No CI pipeline, no Node version pin, no `package-lock.json` reconciliation across team members.
3. **The bundle remains human-readable in the browser DevTools without source-map round-trips.** When deployed to a civic agency that may need to investigate behaviour months after handover, this is a meaningful long-tail benefit.

### 4.2 Technology Stack

| Concern | Library | Version | CDN source |
|---|---|---|---|
| Map rendering | Leaflet | 1.9.4 | unpkg |
| Database client | @supabase/supabase-js | 2.50.0 | jsdelivr |
| Geocoding | Nominatim (OpenStreetMap) | (REST) | nominatim.openstreetmap.org |
| Tiles | MapTiler + CARTO Positron | n/a | api.maptiler.com / cartocdn.com |
| Brand font | Rostex Outline (TTF) | local | self-hosted |
| Body font | Urbanist | (variable) | fonts.googleapis.com |
| Hosting | Netlify | (managed) | netlify.app |
| L2 cache | Upstash Redis (REST API) | n/a | upstash.io |

*Table 3. WebGIS runtime stack. All JavaScript is ES2020 vanilla; no transpilation step exists.*

### 4.3 Visual Design Language

The dashboard adopts a **liquid-glass** visual idiom — translucent surfaces backed by `backdrop-filter: blur(28px) saturate(180%)`, highlight-and-shadow inset rings, and pill-shaped containers with 999 px radii. The core palette is monochromatic: ink (`#1A1A1C`), muted (`#6E6E73`), background (`#EDEEF0`), surface (`#FFFFFF`).

A custom outline typeface (Rostex Outline) is used exclusively for the "GEO" wordmark, paired with the bold sans-serif Urbanist for "AI" and all body copy. The brand mark is rendered with `paint-order: stroke fill` and a 1.8 px stroke to achieve the outlined-letter aesthetic without vector path tracing. A separate `.brand-inline` CSS class scales the same wordmark to inline body-copy size, used in the About panel.

When the user selects a dark basemap (Dark, Satellite), the `body.chrome-dark` class is toggled, swapping the entire UI palette via CSS custom-property overrides. All glass surfaces remain semi-transparent but invert their tint relative to the basemap.

### 4.4 Map Layer

Six basemap styles are user-selectable and persisted to `localStorage`:

| Style key | Provider | URL pattern | Subdomain redundancy |
|---|---|---|---|
| `light` (default) | CARTO Positron | `light_all/{z}/{x}/{y}{r}.png` | a/b/c/d |
| `dark` | CARTO Dark Matter | `dark_all/{z}/{x}/{y}{r}.png` | a/b/c/d |
| `voyager` | CARTO Voyager | `rastertiles/voyager/{z}/{x}/{y}{r}.png` | a/b/c/d |
| `satellite` | MapTiler hybrid-v4 | `api.maptiler.com/maps/hybrid-v4/...` | n/a |
| `backdrop` | MapTiler backdrop-v4 | `api.maptiler.com/maps/backdrop-v4/...` | n/a |
| `toner` | MapTiler toner-v2 | `api.maptiler.com/maps/toner-v2/...` | n/a |

*Table 4. Basemap providers and their tile URL patterns.*

The map is initialised at Bengaluru's MG Road centroid (12.9716°N, 77.5946°E) at zoom 12. User geolocation is intentionally not requested on load, as the civic-authority audience views the city as a whole rather than their own location.

### 4.5 Marker Rendering and Geographic Clustering

Each `assessments` row with valid coordinates is rendered as a `L.circleMarker` whose visual properties encode three orthogonal data dimensions:

| Visual channel | Data field | Mapping |
|---|---|---|
| Fill colour | `distress_types` (primary) | Pothole D40 → crimson, Alligator D20 → red, Block D43 → purple, Transverse D10 → orange, Longitudinal D00 → amber, unknown → grey |
| Radius | `severity` | None/Unknown 7 px, Low 10 px, Medium 14 px, High 19 px |
| Border style | `created_at` × `latitude`, `longitude` (sun position) | Solid 2.5 px white for day captures; dashed `5 3` pattern for night captures |
| Halo (separate marker) | as above | Dark navy ring at radius+6 px, opacity 0.28, dashed 4 3 — only present for night captures |

*Table 5. Marker visual encoding.*

When the expert has corrected the AI classification (`expert_corrected_types` / `expert_corrected_severity` populated), the corrected value takes precedence over the raw AI output for both colour and radius selection.

Markers within a 3-metre geographic cell coalesce into a cluster marker, sized proportionally to member count and rendered as a Leaflet `divIcon` with the count text overlaid. The 3 m threshold was selected to absorb GPS jitter (typical accuracy 3–5 m) without merging genuinely distinct nearby damages. The clustering algorithm is a bucket grid:

```
latStep = 3 / 111 320                           # metres → degrees latitude
lngStep = 3 / (111 320 · cos(lat·π/180))         # adjust for latitude
key     = (round(lat / latStep), round(lng / lngStep))
```

This produces O(n) clustering in a single pass over the row set, suitable for the project's expected ≤10 000 visible markers.

### 4.6 Day / Night Classification

A non-trivial design question concerns whether a captured photograph was taken in daytime or night-time conditions. The naive approach — comparing the local hour of `created_at` to a fixed cutoff such as 18:00 — is incorrect across latitudes and seasons (sunrise and sunset shift by tens of minutes between January and June, and by hours between equatorial and high-latitude regions).

Our implementation computes, for each row's `created_at` timestamp and `latitude`/`longitude`, whether the sun was above the **civil twilight** threshold (–6° below horizon) at that moment. The civil-twilight threshold is preferred over geometric horizon because it more closely approximates the lighting conditions under which handheld smartphone photography requires artificial light, and it matches users' intuitive perception of "when it gets dark" in urban environments where street lighting activates near civil twilight.

The computation reduces to standard astronomical formulas:

1. **Day-of-year**: `n = ⌊(d − 1 Jan) / 86 400 000⌋`
2. **Solar declination** (degrees): `δ = −23.45 · cos(2π(n+10)/365)`
3. **Hour angle at civil twilight**: `H = arccos((sin(−6°) − sin(φ)·sin(δ)) / (cos(φ)·cos(δ)))`
4. **Sunrise/sunset (UTC hours)**: `t_{sr} = 12 − λ/15 − H/15·(180/π)`, `t_{ss} = 12 − λ/15 + H/15·(180/π)`
5. **Decision**: row is daytime iff `t_{sr} ≤ utc_hour ≤ t_{ss}`.

For Bengaluru on 28 April, this places sunset at approximately 19:00 IST, matching the local intuition that 19:00 is night.

### 4.7 Detail Card System ("JARVIS Cards")

When a user clicks a marker, the application:

1. Fades out any currently open cards (300 ms blur transition).
2. Triggers a "radar pulse" animation — three concentric SVG rings expanding from the marker pixel position over 1 200 ms, visualising the click acknowledgement.
3. Pans and zooms the map to the marker via `map.flyTo` (1 100 ms duration).
4. Renders a compact 340 px × 180 px detail card containing only a "Loading information…" pill with a CSS spinner.
5. After 2 000 ms (covering the flyTo animation plus a deliberate suspense buffer), revealing the full card — image, severity badge, distress type chips, address, AI description, capture timestamp, coordinates.
6. Drawing an SVG line from the marker pixel position to the nearest edge of the card, plus a continuous 1 800 ms-cycle pulse ring around the marker indicating "this is the active selection".

When the user clicks a cluster marker representing 2 or more rows, the application instead renders 2 to 3 cards arranged in a circle around the cluster centroid (angles computed evenly around 360°, distance 220–280 px from the centroid). If the cluster contains more than 3 rows, a "View N more" pill replaces the third card slot; activating it transitions to a vertical list view of all members, from which any individual entry can be drilled into the full single-card view.

A `ResizeObserver` is attached to each card so that the SVG connector line redraws when card content reflows during the loading→loaded transition. Without this, the connector visibly detaches from the card edge until the next map pan event triggers a re-layout.

### 4.8 Filter System

Three persistent filter axes are surfaced through a cascading panel anchored beneath the topbar:

1. **Top Locations** — assessments aggregated by `address`, sorted descending by count.
2. **Severity** — Less (Low) / Moderate (Medium) / Red Alert (High) / Search all.
3. **Time of day** — Day captures / Night captures / All.

When a non-default filter is selected, a dismissible "filter pill" appears next to the GEOAI brand showing the active state (e.g. "You've selected **Moderate** Severity"). The pill persists across panel close, marker selection, and even page refresh in the case of severity (via `localStorage`). Only the pill's × button removes the filter — closing the detail card or switching nav tabs does not.

The pill positioning is computed dynamically via JavaScript rather than CSS flexbox: the topbar has fixed positioning, and the pill needs to render *adjacent* to the topbar's right edge in a way that respects topbar width changes. A shared `positionSeverityPill()` function reads the topbar's `getBoundingClientRect()` and lays out both severity and time pills side-by-side immediately to its right, on the desktop breakpoint only.

### 4.9 Caching Strategy

The dashboard implements a **two-tier stale-while-revalidate cache** to minimise Supabase read costs:

- **L1 — `localStorage`** (per-user, 10-minute TTL). On page load the cache is checked first; if fresh, it is rendered immediately and no network request is made. If stale but present, it is rendered immediately *and* a background refresh is initiated, whose result is reconciled against the rendered set only if the row count or classified-row count differs.

- **L2 — Upstash Redis** (shared across all users, 5-minute TTL, accessed via a Netlify Function). Cache misses on L1 fall through to a `/api/assessments` Netlify Function endpoint which checks Upstash via its REST API. On a hit, Redis returns the merged photos+assessments payload in approximately 30 ms. On a miss, the function fetches from Supabase, writes the result back to Redis with a 300-second expiration, and returns. The `X-Cache: HIT|MISS` response header is exposed for instrumentation.

The L2 layer ensures that even with thousands of distinct visitors, Supabase is queried at most once per 5-minute window per cluster. With Upstash's free tier offering 10 000 commands per day and a typical ~3-command session per visitor, the system supports approximately 3 000 unique daily visitors before exceeding the free quota.

---

## 5. Performance Optimisations

### 5.1 Asynchronous Data Hydration

The page-load sequence is intentionally non-blocking. After the loading screen renders (immediate), the application:

1. Initialises the Leaflet map with the chosen basemap (synchronous, ~50 ms).
2. Issues the data fetch (`tryNetlifyFunction` → fall-through to direct Supabase if function unavailable) in parallel.
3. Renders markers as soon as data arrives, regardless of whether map tiles have finished loading.

This sequencing means that visible map content appears in approximately 800 ms even on a cold Netlify cache, and in approximately 200 ms on a warm L1 cache.

### 5.2 SVG Connector Throttling

The detail-card connector lines are redrawn on every Leaflet `move` and `zoom` event. With multiple cards open, naive redrawing on every pixel of pan motion would produce noticeable jank on lower-powered devices. The implementation throttles redraws to one per `requestAnimationFrame`:

```javascript
let _resizeRAF = null;
const cardResizeObserver = new ResizeObserver(() => {
    if (_resizeRAF) cancelAnimationFrame(_resizeRAF);
    _resizeRAF = requestAnimationFrame(() => {
        _resizeRAF = null;
        positionAllCards();
    });
});
```

This caps the redraw cost at one execution per display refresh (~16.7 ms at 60 Hz), independent of how many resize events fire in a frame.

### 5.3 Marker Cleanup on Re-render

When the row set changes (e.g. filter applied, background refresh detects new rows), the application calls `assessmentLayer.clearLayers()` rather than diff-and-update. While diff-and-update would in principle be more efficient, the clear-and-recreate strategy is approximately 40 ms for 100 markers in our measurements, which is below the human perceptual threshold for animation continuity (~100 ms). The implementation simplicity benefit outweighs the marginal performance cost.

---

## 6. Engineering Decisions and Trade-offs

### 6.1 Vanilla JavaScript over a Framework

Discussed in §4.1. The deciding factor was the project's terminal handover: at the conclusion of the academic year, this code becomes a static artefact. A framework-bound codebase (React, Vue, Svelte) would have version-decay properties — a future maintainer would need to reconstruct the toolchain, which compounds with each unmaintained year. Plain HTML/CSS/JavaScript has indefinite forward-compatibility.

### 6.2 Static Hosting over Containers

Deploying to a Netlify static-site CDN rather than to a Kubernetes cluster or a container service eliminated infrastructure surface area entirely. There are no servers to patch, no log aggregation pipeline to maintain, no autoscaling configuration to tune. The single trade-off is that any server-side computation must be expressed as a Netlify Function (a Node.js Lambda equivalent), which constrains us to short-lived, stateless handlers — a fit for the cache-proxy use case but unsuitable for, e.g., long-polling or WebSocket connections.

### 6.3 Supabase Anonymous Key in Client Code

The Supabase anonymous JWT is embedded in `app.js` and is therefore visible to any visitor who inspects the page. Per Supabase's documented security model, this is acceptable when Row Level Security policies are correctly configured: the anon role's permissions are restricted by RLS at the database level, not by the secrecy of the key. Our RLS policies (§3.2) limit the anon role to SELECT-only on a specific subset of rows. Read scraping of the data is technically possible but does not differ from any human visitor scrolling through the dashboard — the data is, by design, public.

### 6.4 Cluster Radius

Cluster radius was iteratively tuned through user testing. Values from 50 m down to 5 m were trialled. At 50 m, distinct potholes on the same street segment were merged into single dots, obscuring information density. At 0 m (no clustering), the map became visually overwhelming when many overlapping uploads occurred at the same intersection. The final 3 m value coalesces only photographs taken from essentially the same standing position, leveraging the GPS-jitter floor as a natural physical bound.

### 6.5 Civil Twilight over Geometric Sunrise/Sunset

Discussed in §4.6. The civil-twilight threshold (–6° below horizon) was preferred to the geometric horizon (–0.833°) because the project's downstream concern — flagging photographs whose lighting may be insufficient for the AI model — correlates more closely with civil twilight than with the moment of geometric sunset. A photograph captured 15 minutes after geometric sunset is effectively a night photograph for image-classification purposes.

---

## 7. Implementation Status

The system was built in approximately 240 person-hours over a single academic year. At submission time:

- ✅ Mobile capture client: 100 % feature complete; sideload-distributable APK.
- ✅ WebGIS dashboard: 100 % feature complete; live at `gisgeoai.netlify.app`.
- ✅ Cloud database (Supabase): provisioned, populated with seed test data, RLS configured.
- ✅ Cloudinary CDN: provisioned, unsigned upload preset configured.
- ✅ Upstash Redis L2 cache: provisioned, integrated with the Netlify Function, verified hit/miss telemetry.
- ✅ Documentation: README with architecture diagram, screenshots, and deployment guide. SECURITY.md with intentional design-decision documentation. MIT license.
- ✅ AI pipeline: deployed on the project's GPU server (managed in a separate repository); baseline accuracy 76.5 % (Stage 1), 48.7 % (Stage 2 zero-shot).

Feature work deferred beyond the initial submission window includes:
- Phase 2 fine-tuning (QLoRA on RDD2022 + GAPs V2 combined).
- Phase 3 expert-in-the-loop few-shot prompt injection.
- BBMP ward-boundary overlay and per-ward aggregation.
- CSV export of filtered results for road-department workflow integration.
- Real-time Supabase subscriptions (live insertions appearing on the map without page refresh).

---

## 8. Conclusion

GeoAI demonstrates that a deployable civic-technology artefact can be constructed on consumer-grade infrastructure (managed Postgres, free-tier serverless functions, free-tier Redis, free-tier image CDN, static hosting) at zero ongoing operational cost for the expected traffic profile. The technical contribution lies in the careful selection and integration of these components, the deliberate choice of unfashionable architectures (vanilla static frontend, database-as-message-queue), and the privileging of long-term maintainability over greenfield novelty.

The system is licensed MIT and is publicly forkable at the repository linked in the masthead. We welcome adaptation by other civic technology projects and by other municipal contexts beyond Bengaluru.

---

## Acknowledgements

This work was conducted as a final-year capstone project under the Department of Information Science & Engineering, B.M.S. College of Engineering. The authors thank the project's faculty advisors for guidance on system architecture and the Bruhat Bengaluru Mahanagara Palike for clarifying the civic-authority workflow that motivated this work.

---

## Appendix A — Repository Layout

```
geoai/
├── index.html                      ← WebGIS entry point
├── app.js                          ← Client logic (≈2 200 lines)
├── styles.css                      ← Liquid-glass design system
├── favicon.svg                     ← Brand mark icon
├── fonts/rostex.outline.ttf        ← Custom outline font
├── netlify/functions/
│   └── assessments.js              ← Redis-cached Supabase proxy
├── netlify.toml                    ← Netlify configuration
├── docs/
│   ├── screenshots/                ← UI captures (8 PNGs)
│   └── research-report.md          ← This document
├── mobile/                         ← Native Android (Kotlin) capture app
│   ├── app/src/main/java/com/example/msc/
│   │   ├── MainActivity.kt         ← Camera, location, UI
│   │   ├── SplashActivity.kt       ← Permissions, location seed
│   │   ├── CropActivity.kt         ← Crop screen wrapper
│   │   ├── CropImageView.kt        ← Custom 1:1 zoom/pan crop
│   │   ├── CloudUploader.kt        ← Cloudinary + Supabase upload
│   │   └── TutorialOverlay.kt      ← First-launch tutorial
│   ├── app/src/main/AndroidManifest.xml
│   ├── app/build.gradle.kts
│   └── README.md
├── README.md
└── LICENSE
```

## Appendix B — Cloudinary and Supabase Configuration

| Service | Account / Project | Free tier limit |
|---|---|---|
| Cloudinary | Cloud `dnxpt5gea` · preset `photos` (unsigned) | 25 monthly credits ≈ 25 GB bandwidth + 25 k transforms |
| Supabase | Project `vtlkitpoffudiefuoijb` · Postgres 15 | 500 MB database, 2 GB egress, 50 k MAUs |
| MapTiler | API key origin-restricted to `gisgeoai.netlify.app` | 100 k tile requests/month |
| Upstash | Database `geoai` · region `us-east-1` | 10 k commands/day, 256 MB storage |
| Netlify | Site `gisgeoai` (free tier) | 100 GB bandwidth/month, 125 k function invocations/month |

## Appendix C — Selected Source-Code Excerpts

### C.1 Day/night classifier (excerpt, `app.js`)

```javascript
function isDaytime(timestampLike, lat, lng) {
  if (!timestampLike || lat == null || lng == null) return null;
  const d = new Date(timestampLike);
  if (isNaN(d.getTime())) return null;

  const dayOfYear = Math.floor(
    (d - new Date(Date.UTC(d.getUTCFullYear(), 0, 0))) / 86400000
  );
  const decl = -23.45 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365);
  const declRad = (decl * Math.PI) / 180;
  const latRad  = (lat  * Math.PI) / 180;

  // Civil twilight: sun -6° below horizon
  const cosH = (Math.sin((-6 * Math.PI) / 180) -
                Math.sin(latRad) * Math.sin(declRad)) /
               (Math.cos(latRad) * Math.cos(declRad));
  if (cosH < -1) return true;   // polar day
  if (cosH > 1)  return false;  // polar night

  const hourAngleHours = (Math.acos(cosH) * 12) / Math.PI;
  const sunriseUTC = 12 - lng / 15 - hourAngleHours;
  const sunsetUTC  = 12 - lng / 15 + hourAngleHours;
  const utcHourFrac = d.getUTCHours() + d.getUTCMinutes() / 60;
  return utcHourFrac >= sunriseUTC && utcHourFrac <= sunsetUTC;
}
```

### C.2 3-metre clustering (excerpt, `app.js`)

```javascript
const CLUSTER_RADIUS_M = 3;

function clusterRows(rows) {
  if (CLUSTER_RADIUS_M <= 0) {
    return rows
      .filter(r => r.latitude != null && r.longitude != null)
      .map(r => [r]);
  }
  const groups = new Map();
  const latStep = CLUSTER_RADIUS_M / 111320;
  for (const row of rows) {
    if (row.latitude == null || row.longitude == null) continue;
    const cosLat = Math.cos((row.latitude * Math.PI) / 180);
    const lngStep = CLUSTER_RADIUS_M / (111320 * Math.max(0.01, cosLat));
    const latCell = Math.round(row.latitude / latStep);
    const lngCell = Math.round(row.longitude / lngStep);
    const key = `${latCell}|${lngCell}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()];
}
```

### C.3 10-second location refresh (excerpt, `MainActivity.kt`)

```kotlin
@SuppressLint("MissingPermission")
private fun startLocationUpdates() {
    if (locationUpdatesActive) return
    if (checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) !=
        android.content.pm.PackageManager.PERMISSION_GRANTED) return

    val request = LocationRequest.Builder(
        Priority.PRIORITY_HIGH_ACCURACY,
        LOCATION_REFRESH_INTERVAL_MS  // 10 000 ms
    )
        .setMinUpdateIntervalMillis(LOCATION_FASTEST_INTERVAL_MS)  // 5 000 ms
        .setWaitForAccurateLocation(false)
        .build()

    if (locationCallback == null) {
        locationCallback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                val loc = result.lastLocation ?: return
                onLocationUpdate(loc.latitude, loc.longitude)
            }
        }
    }
    ensureFusedClient().requestLocationUpdates(
        request, locationCallback!!, mainLooper
    )
    locationUpdatesActive = true
}
```

---

*End of report.*
