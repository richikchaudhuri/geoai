<div align="center">

# 🛣️ GeoAI

**Pavement Distress Detection System**

*Citizens snap photos of damaged roads — AI classifies each one — civic authorities see hotspots in real time.*

[![License: MIT](https://img.shields.io/badge/License-MIT-FACC15.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Web%20%7C%20Android-22C55E?style=flat-square)](#)
[![Stack](https://img.shields.io/badge/stack-Leaflet%20%7C%20Supabase%20%7C%20Kotlin-DC2626?style=flat-square)](#stack)
[![Capstone](https://img.shields.io/badge/Capstone-BMSCE%202026-1A1A1C?style=flat-square)](#authors)

[**Live Demo**](https://gisgeoai.netlify.app) · [**Web Dashboard**](#-web-dashboard) · [**Mobile App**](#-mobile-app) · [**Architecture**](#-architecture)

</div>

---

## 📍 Overview

GeoAI is an end-to-end civic-tech system that turns citizen smartphone photos into actionable road-maintenance intelligence. A two-stage vision-language model (Qwen2.5-VL-7B fine-tuned on RDD2022 + GAPs V2) classifies each photo into a **distress type** (longitudinal crack, transverse crack, alligator crack, pothole, block crack) with **severity** (Less / Moderate / Red Alert) and a **confidence score** read directly from raw model logits — not from string matching.

This repo holds the **two client-facing pieces** of that system:

| | What it does |
|---|---|
| 🗺️ **WebGIS** *(this repo's root)* | Civic-authority hotspot map. Renders classified assessments from Supabase on a Leaflet map with smart clustering, severity & day/night filtering, and JARVIS-style detail cards. |
| 📱 **Mobile** *(`mobile/`)* | Native Android (Kotlin) capture client. CameraX preview, pinch-zoom 1:1 crop, flash toggle, low-light hint, 10-second live location refresh. Uploads to Cloudinary + writes to Supabase. |

The AI pipeline, FastAPI server, expert-review UI, and Supabase schema live in the team's GPU-server repository — they're not in this repo.

---

## 🏗️ Architecture

```mermaid
flowchart LR
    Citizen([👤 Citizen]) -->|opens| App[📱 GeoAI Mobile App]
    App -->|JPEG| Cloud[☁️ Cloudinary CDN]
    App -->|metadata + GPS| Photos[(🗄️ Supabase<br/>photos)]
    Photos -.->|trigger| Asses[(🗄️ Supabase<br/>assessments)]
    Asses -->|claim batch| Worker[🤖 AI Worker<br/>Qwen2.5-VL-7B<br/>A5000 GPU]
    Worker -->|results + confidence| Asses
    Asses -->|low confidence| Expert[🧑‍🔬 Expert UI]
    Expert -->|corrections| Worker
    Asses -->|public read| WebGIS[🗺️ GeoAI WebGIS]
    WebGIS --> BBMP([🏛️ BBMP / Civic])

    classDef inRepo fill:#1A1A1C,stroke:#22C55E,stroke-width:2px,color:#FFFFFF;
    class App,WebGIS inRepo;
```

> Components highlighted in green border are in **this** repo. Everything else is the team's broader system.

---

## 🗺️ Web Dashboard

Vanilla HTML/CSS/JS — **no build step**. Drop the repo onto Netlify or push to GitHub Pages and you're live.

### What's in it

- 🎨 **6 basemap styles** — light, dark, voyager, satellite, minimal, toner. UI chrome auto-flips to a dark theme on dark maps.
- 📍 **14m geographic clustering** of overlapping markers, with multi-card cluster expansion (up to 3 cards + view-more)
- 🎯 **JARVIS-style anchored detail cards** — pinch-aware connectors, radar pulse on click, 2s spinner→reveal animation
- 🌅 **Civil-twilight day/night detection** per-marker — uses real sun-position math, not a hardcoded clock. Dashed border on night captures.
- 🔍 **Cascading filters** — top locations by frequency, severity (Less / Moderate / Red Alert), time of day. Active filters drop pills next to the brand.
- 💾 **Stale-while-revalidate `localStorage` cache** with 10-min TTL — saves Supabase reads, page loads from cache instantly
- 📱 **Fully responsive** — mobile breakpoints throughout, touch-friendly Leaflet, viewport-aware card placement

### Tech

`Leaflet 1.9` · `MapTiler` · `Supabase JS v2` · `Nominatim` · vanilla ES2020

### Configuration

Edit the top of [`app.js`](app.js):

```js
const MAPTILER_KEY        = 'YOUR_MAPTILER_KEY';
const SUPABASE_URL        = 'https://your-project.supabase.co';
const SUPABASE_ANON_KEY   = 'YOUR_ANON_JWT';
```

The anon key is safe in the browser as long as Supabase RLS is configured. The MapTiler key should be locked to your deployed origin in the MapTiler dashboard.

---

## 📱 Mobile App

Native Android (Kotlin) capture client. See [`mobile/README.md`](mobile/README.md) for full docs.

### What's in it

- 📷 **CameraX preview** with single-tap shutter and persistent **6-second cooldown** between captures (survives app close)
- 🔆 **Flash toggle** — off / on / auto cycle, with an animated status pill
- 💡 **Low-light hint** — `ImageAnalysis` reads live preview luminance; drops a "Low light · try flash" pill when the scene gets dim and flash is off
- 🌍 **10-second live location refresh** via `FusedLocationProviderClient.requestLocationUpdates` — every capture grabs the latest fix, so photos taken while moving don't cluster at the launch coordinates
- ✂️ **Custom 1:1 crop with pinch-zoom (1×–6×) and drag-pan** — rule-of-thirds grid, live zoom-level badge, snaps to integer pixel boundaries

### Build

```bash
cd mobile
./gradlew assembleDebug      # debug APK
./gradlew assembleRelease    # debug-signed release APK for sideloading
```

`minSdk = 26` (Android 8.0 Oreo, ~94% of devices) · `targetSdk = 36` (Android 16)

---

## 📂 Repo Layout

```
geoai/
├── index.html                      # WebGIS entry point
├── app.js                          # All client logic (data, clusters, filters, cards)
├── styles.css                      # Liquid-glass design system
├── fonts/rostex.outline.ttf        # Custom outline font for the GEO mark
│
├── mobile/                         # Native Android capture app
│   ├── app/src/main/
│   │   ├── java/com/example/msc/   # Kotlin sources
│   │   ├── res/                    # Layouts, drawables, themes
│   │   └── AndroidManifest.xml
│   ├── build.gradle.kts
│   └── README.md                   # Mobile-specific docs
│
├── README.md                       # ← you are here
├── LICENSE                         # MIT
└── .gitignore
```

---

## 🧭 Project Roadmap

| Phase | Status | What |
|---|---|---|
| 1 | ✅ Done | Two-stage AI pipeline · real-time worker · expert UI · baseline eval |
| 2 | ✅ Done | **GeoAI WebGIS** (this repo) · civic hotspot map |
| 3 | ✅ Done | **GeoAI Mobile** (this repo) · citizen capture client |
| 4 | 🚧 Next | QLoRA fine-tuning on RDD2022 + GAPs V2 combined dataset |
| 5 | 🚧 Next | Expert-in-the-loop few-shot prompt injection + LoRA incremental retraining |

---

## 🚀 Deploy

The WebGIS deploys to **Netlify** with no build step. Either drag the repo onto [Netlify Drop](https://app.netlify.com/drop) for a one-shot deploy, or connect this GitHub repo for auto-deploys on every push to `main`.

**Build command:** *(empty)* · **Publish directory:** `.`

---

## 👥 Authors

**Suraj** · **Richik Chaudhuri** · **Sushant Deo**

Capstone Project · **B.M.S. College of Engineering**, Bengaluru · April 2026

---

## 📄 License

[MIT](LICENSE) — feel free to fork, learn from, and adapt for your own civic-tech projects.
