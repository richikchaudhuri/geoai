# geoai-import

A Rust CLI for bulk-importing pavement-distress images into the GeoAI
backend. Mirrors the mobile app's upload pipeline (Cloudinary unsigned
preset + Supabase `photos` insert) but does it for an entire directory
in parallel.

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
# Walk a folder, use EXIF GPS when present, fall back to Bengaluru center
./target/release/geoai-import \
  --dir ./bengaluru-batch \
  --default-lat 12.9716 \
  --default-lng 77.5946 \
  --concurrency 8

# Dry-run first (parses EXIF, prints plan, uploads nothing)
./target/release/geoai-import --dir ./bengaluru-batch --dry-run
```

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--dir` | (required) | Directory to walk recursively for `*.jpg`, `*.jpeg`, `*.png`. |
| `--default-lat` / `--default-lng` | none | Fallback coords for images without EXIF GPS. |
| `--concurrency` | 4 | Parallel uploads (max 32). |
| `--dry-run` | off | Extract metadata + print plan; skip uploads. |
| `--skip-no-gps` | off | Skip files with no GPS instead of erroring out. |

## What it does per image

1. **Read EXIF** — pull `GPSLatitude` / `GPSLongitude` (DMS rationals) and
   their refs (N/S/E/W). If missing and `--default-lat` / `--default-lng`
   are set, use those. Otherwise either skip (`--skip-no-gps`) or error.
2. **Upload to Cloudinary** — multipart POST to
   `https://api.cloudinary.com/v1_1/{cloud}/image/upload` with the unsigned
   `photos` preset. Identical endpoint and preset to the mobile app.
3. **Insert to Supabase** — `POST /rest/v1/photos` with `image_url`,
   `address` (formatted lat/lng), `latitude`, `longitude`. The existing AI
   worker picks the row up asynchronously and creates the corresponding
   `assessments` row.

Per-file errors don't kill the batch. The tool keeps going and exits with
status 1 if any uploads failed.

## Sample output

```
Found 247 images in ./bengaluru-batch
  201 via EXIF · 46 via --default · 0 skipped

  00:00:38 [==============================] 247/247  ✓ IMG_5729.jpg

✓ 247 imported · ✗ 0 failed · 38.4s wall  (6.4/s)
```

## Limitations

- **No reverse-geocoding.** Address is `"12.9716, 77.5946"`-style. A future
  `--geocode` flag could call Nominatim with the standard 1 req/sec rate
  limit, but most callers don't need it (the WebGIS displays coords fine).
- **No retry beyond the per-request timeout.** Failed uploads are reported
  but not re-attempted in the same run. Re-running the tool on the same
  folder will re-upload everything (Cloudinary returns a fresh URL each
  time), which is fine for seeding but not for resumability.
- **Anon JWT baked in.** Same key the mobile app and the WebGIS already
  ship — RLS on the `photos` table is what actually guards writes.

## How it's wired internally

```
┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ WalkDir →   │    │ tokio + reqwest  │    │ Cloudinary REST  │
│ EXIF parse  │ →  │ buffer_unordered │ →  │ ↓ secure_url     │
│             │    │ (concurrency N)  │    │ Supabase REST    │
└─────────────┘    └──────────────────┘    └──────────────────┘
```

Concurrency is implemented via `futures::stream::iter(...).buffer_unordered(N)`,
which keeps exactly N requests in flight at once. The default of 4
balances Cloudinary's free-tier rate limits against pipeline efficiency;
the max of 32 is plenty for one-time imports.
