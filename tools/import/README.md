# geoai-import

A Rust CLI for bulk-importing pavement-distress images into the GeoAI
backend. Mirrors the mobile app's upload pipeline (Cloudinary unsigned
preset + Supabase `photos` insert) but does it for an entire directory
in parallel — with reverse-geocoding, dedup-on-rerun, and retry/backoff.

## Why

The mobile app captures one image at a time. For demos or research it's
useful to seed the WebGIS with a large batch — e.g. an RDD2022 subset,
a personally collected pavement set, or a historical photo folder.
This tool does that without spinning up the Android app or
hand-uploading.

## Build

```bash
cd tools/import
cargo build --release
# binary: ./target/release/geoai-import (or .exe on Windows)
```

Rust 1.75+ required (`rustup default stable`).

The release binary is statically linked (no OpenSSL — uses `rustls`) and
fully self-contained. Drop it anywhere and run it.

## Usage

```bash
# Basic — walk folder, use EXIF GPS where present, fall back to Bengaluru
./target/release/geoai-import \
  --dir ./bengaluru-batch \
  --default-lat 12.9716 \
  --default-lng 77.5946 \
  --concurrency 8

# With reverse-geocoding (slow: 1 req/sec via Nominatim)
./target/release/geoai-import \
  --dir ./bengaluru-batch \
  --default-lat 12.9716 --default-lng 77.5946 \
  --geocode

# Dry-run first to inspect what would happen
./target/release/geoai-import --dir ./bengaluru-batch --dry-run
```

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--dir` | (required) | Directory to walk recursively for `*.jpg`, `*.jpeg`, `*.png`. |
| `--default-lat` / `--default-lng` | none | Fallback coords for images without EXIF GPS. |
| `--concurrency` | 4 | Parallel uploads (max 32). |
| `--dry-run` | off | Run stages 1+2, print plan; skip uploads (stage 3). |
| `--skip-no-gps` | off | Skip files with no GPS instead of erroring out. |
| `--geocode` | off | Enable Nominatim reverse-geocoding (throttled to 1 req/sec). |
| `--state-file` | `.geoai-import-state.json` | Path to the JSON state file (dedup + geocode cache). |
| `--no-resume` | off | Ignore the state file on startup. Still writes to it on success. |
| `--retries` | 2 | Retries per request on transient failures (network, 5xx, 429). |

## Pipeline

```
┌─────────────┐   ┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ Stage 1     │   │ Stage 2      │   │ Stage 3 (parallel)                      │
│ walk + sha  │ → │ geocode      │ → │ cloudinary upload  →  supabase insert  │
│ + exif      │   │ (optional)   │   │ (retry w/ backoff)                      │
└─────────────┘   └──────────────┘   └──────────────────┘   └──────────────────┘
        ↓                ↓                                 ↓
        └────────────────┴──────────── state file ────────┘
                       (.geoai-import-state.json)
```

### Stage 1 — discovery, hashing, EXIF, dedup

For each image:

1. Compute **SHA-256** of the file contents.
2. If the hash matches an entry in the state file's `uploads`, **skip** the
   file (already uploaded in a prior run). Use `--no-resume` to override.
3. Read **EXIF** `GPSLatitude` / `GPSLongitude` (DMS rationals) + their
   refs (N/S/E/W). If missing and `--default-lat` / `--default-lng` are
   set, use those. Otherwise either skip (`--skip-no-gps`) or error.

### Stage 2 — reverse-geocoding (optional, `--geocode`)

For each unique location (rounded to 4 decimal places, ~11 m), look up
the address via [Nominatim](https://nominatim.openstreetmap.org).
**Throttled to 1 request per 1.1 seconds** to comply with Nominatim's
usage policy. Results are cached in the state file's `geocode_cache` so
subsequent runs hit the cache.

If `--geocode` is off (default), `address` is set to a `"12.9716, 77.5946"`-style
coord string at upload time.

### Stage 3 — parallel uploads with retry/backoff

For each record:

1. **Cloudinary** — multipart POST to
   `https://api.cloudinary.com/v1_1/{cloud}/image/upload` with the unsigned
   `photos` preset. Identical endpoint and preset to the mobile app.
2. **Supabase** — `POST /rest/v1/photos` with `image_url`, `address`,
   `latitude`, `longitude`. The existing AI worker picks the row up
   asynchronously and creates the corresponding `assessments` row.

**Retry rules:**

- **Transient** errors (network, HTTP 5xx, HTTP 429) → retry up to
  `--retries` times with exponential backoff (1s, 2s, 4s, …).
- **Fatal** errors (4xx other than 429, malformed responses) → fail
  immediately for that file. The rest of the batch continues.
- After each successful upload the state file is rewritten atomically
  (tmp + rename), so a Ctrl-C mid-run loses at most one image worth of
  progress.

## State file format

```json
{
  "version": "0.2",
  "uploads": {
    "<sha256 hex>": {
      "path": "C:/path/to/IMG_0001.jpg",
      "image_url": "https://res.cloudinary.com/dnxpt5gea/image/upload/v.../abc.jpg",
      "lat": 12.9716,
      "lng": 77.5946,
      "uploaded_at": 1747655280
    }
  },
  "geocode_cache": {
    "12.9716,77.5946": "St. Joseph's Indian High School, 1st Cross Road, D'Souza Layout, Bengaluru, Karnataka, 560001, India"
  }
}
```

Safe to delete: the next run starts fresh. Safe to commit (no secrets) —
though the gitignore excludes it by default.

## Sample output

```
Found 247 images in ./bengaluru-batch
Stage 1: hash + EXIF + dedup
  → 198 new · 173 EXIF / 25 default · 49 already-uploaded · 0 no-GPS skipped
Stage 2: reverse-geocode via Nominatim (≤1 req/sec)
  → 41 unique locations to fetch · 157 cache hits (across 198 records)
00:00:46 [==============================] 41/41   ✓ MG Road, Bengaluru, Karnataka…
Stage 3: uploading (concurrency=8, retries=2)
00:00:31 [==============================] 198/198  ✓ IMG_5729.jpg

✓ 198 imported · ✗ 0 failed · 31.4s wall  (6.3/s)
```

## Dependencies

| Crate | Purpose |
|---|---|
| `tokio` | async runtime |
| `reqwest` (rustls-tls) | HTTPS client, no OpenSSL |
| `clap` | CLI parsing with derive macros |
| `walkdir` | recursive directory traversal |
| `kamadak-exif` | EXIF reading |
| `serde` / `serde_json` | state file I/O |
| `sha2` | SHA-256 for content dedup |
| `indicatif` | progress bars |
| `futures` | `buffer_unordered` for parallel I/O |
| `anyhow` | error type erasure |

## Limitations

- **Re-running on the same folder with `--no-resume` re-uploads every
  file.** Cloudinary will issue a fresh URL each time. This is expected
  behaviour — `--no-resume` is for forcing a clean import.
- **Nominatim returns a single line of `display_name`.** The current
  GeoAI schema stores that in a single `address` column on the `photos`
  table. If you need structured locality / city / postcode fields, the
  request URL needs `&addressdetails=1` and the parser needs to pick
  components — not currently wired.
- **Anon JWT baked in.** Same key the mobile app and the WebGIS already
  ship — RLS on the `photos` table is what guards writes.
