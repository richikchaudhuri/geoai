# GEOAI · WebGIS

Civic dashboard for the GeoAI pavement-distress detection system. Renders
classified road-damage assessments from Supabase on a Leaflet map with
clustering, day/night detection, severity filtering, and a JARVIS-style
detail card for each marker.

## Live demo

Drop the folder onto [Netlify Drop](https://app.netlify.com/drop) — the
site is fully static (no build step) and mobile-responsive out of the box.

## Stack

- **Map**: Leaflet 1.9 + MapTiler tiles (light, dark, voyager, satellite,
  backdrop, toner)
- **Database**: Supabase Postgres — public anon read on `photos` and the
  `assessments` table (per the project's RLS policy)
- **Search**: Nominatim (OpenStreetMap) for free geocoding
- **No build step** — vanilla HTML/CSS/JS, all dependencies via CDN

## Files

| File | Purpose |
|---|---|
| `index.html` | Entry point — markup, layout, deferred CDN loads |
| `app.js` | All client logic: data fetching, clustering, filters, cards |
| `styles.css` | Liquid-glass design system, responsive media queries |
| `fonts/rostex.outline.ttf` | Custom outline font for the GEO mark |

## Features

- 🗺️ Multiple basemap styles, with dark-chrome auto-applied for dark maps
- 📍 Smart 14m clustering of overlapping markers
- 🎯 Click-to-fly with radar pulse + JARVIS card connector
- 🌅 Day/night classification (civil twilight) with dashed border for night
- 🔍 Filters: top locations by frequency · severity (Less/Moderate/Red Alert) · time of day
- 💾 Stale-while-revalidate cache (`localStorage`, 10-min TTL) — saves Supabase reads
- 📱 Fully responsive — works on phones

## Configuration

Edit the top of `app.js`:

```js
const MAPTILER_KEY        = 'YOUR_MAPTILER_KEY';
const SUPABASE_URL        = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY   = 'YOUR_ANON_JWT';
```

The anon key is safe in the browser as long as Supabase RLS is configured.
The MapTiler key should be locked down to your deployed origin in the
MapTiler dashboard.

## Companion mobile app

The capture-side mobile app (RoadSide) lives in a separate Android Studio
project. It writes to the same `photos` table; a Postgres trigger creates
the matching `assessments` row that the AI worker picks up.

## Authors

Suraj · Richik Chaudhuri · Sushant Deo — Capstone Project, BMSCE,
Bengaluru · April 2026
