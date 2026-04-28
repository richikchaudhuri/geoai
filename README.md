# GeoAI

End-to-end pavement-distress detection system. Citizens take photos of
road damage on the **GeoAI mobile app**; the photos run through a
two-stage AI pipeline (Qwen2.5-VL-7B fine-tuned on RDD2022 + GAPs V2);
classified hotspots surface on the **GeoAI WebGIS** for civic
authorities (BBMP).

This monorepo holds the two client-facing pieces of that system.

## Layout

```
.
├── index.html / app.js / styles.css   ← WebGIS (this repo's root is the deployable site)
├── fonts/                              ← Rostex Outline (custom brand font)
├── mobile/                             ← Native Android capture app (Kotlin)
│   ├── app/
│   ├── gradle/
│   └── README.md                       ← App-specific docs
├── README.md                           ← (you are here)
└── .gitignore
```

The AI pipeline, FastAPI server, expert-review UI, and Supabase schema
are not in this repo — they live in the team's main capstone repository
on the GPU server.

## WebGIS (root)

Static civic dashboard. Drag the repo onto
[Netlify Drop](https://app.netlify.com/drop) or connect the repo to
Netlify / GitHub Pages — no build step.

**Stack**: Leaflet 1.9 · MapTiler · Supabase Postgres · Nominatim ·
vanilla HTML/CSS/JS (no framework, no bundler).

**Features**: multi-style basemap, dark-chrome auto-flip, 14 m geographic
clustering, JARVIS-style anchored detail cards, civil-twilight day/night
detection with visual badge, cascading filters (top locations / severity /
time-of-day), persistent filter pills, and a `localStorage`
stale-while-revalidate cache that saves Supabase reads.

Configuration sits at the top of `app.js` — the Supabase anon key + URL
and the MapTiler key. The anon key is safe in the browser as long as RLS
is configured; the MapTiler key should be locked to the deployed origin
in the MapTiler dashboard.

## Mobile (`mobile/`)

Native Android (Kotlin) capture client. CameraX preview, pinch-zoom 1:1
crop, flash toggle, live luminance metering, 10-second
`requestLocationUpdates` cadence so photos taken while moving don't
cluster at the launch coordinates. Uploads to Cloudinary (unsigned
preset) and inserts a `photos` row into Supabase; the project's Postgres
trigger picks it up.

```bash
cd mobile
./gradlew assembleDebug      # debug APK
./gradlew assembleRelease    # release APK (debug-signed for sideloading)
```

See [`mobile/README.md`](mobile/README.md) for full details.

## Authors

Suraj · Richik Chaudhuri · Sushant Deo — Capstone Project, BMSCE,
Bengaluru · April 2026
