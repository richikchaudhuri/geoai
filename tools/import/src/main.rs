//! geoai-import — bulk-import pavement-distress images.
//!
//! Walks a directory of JPEG/PNG images, reads EXIF GPS (or falls back to
//! CLI-supplied defaults), uploads each image to Cloudinary using the same
//! unsigned preset the mobile app uses, and inserts a row into the Supabase
//! `photos` table. The existing AI worker picks up each photo and creates
//! the corresponding `assessments` row asynchronously.
//!
//! Self-contained: no Python, no Node, no SDKs. Just direct HTTPS to
//! Cloudinary and Supabase REST.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use futures::stream::{self, StreamExt};
use indicatif::{ProgressBar, ProgressStyle};
use serde::Serialize;
use walkdir::WalkDir;

// ---------- Embedded config (mirrors the mobile app) -----------------------

const CLOUDINARY_CLOUD: &str = "dnxpt5gea";
const CLOUDINARY_PRESET: &str = "photos";
const SUPABASE_URL: &str = "https://vtlkitpoffudiefuoijb.supabase.co";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU";

// ---------- CLI ------------------------------------------------------------

#[derive(Parser, Debug, Clone)]
#[command(
    version,
    about = "Bulk-import pavement images to Cloudinary + Supabase",
    long_about = None
)]
struct Args {
    /// Directory containing JPEG/PNG images (walked recursively).
    #[arg(long)]
    dir: PathBuf,

    /// Fallback latitude for images without EXIF GPS (decimal degrees).
    #[arg(long)]
    default_lat: Option<f64>,

    /// Fallback longitude for images without EXIF GPS (decimal degrees).
    #[arg(long)]
    default_lng: Option<f64>,

    /// Number of parallel uploads (1..=32, default 4).
    #[arg(long, default_value_t = 4)]
    concurrency: usize,

    /// Dry-run: extract metadata + print plan, do NOT upload.
    #[arg(long)]
    dry_run: bool,

    /// Skip files with no GPS instead of erroring out.
    #[arg(long)]
    skip_no_gps: bool,
}

// ---------- Data types -----------------------------------------------------

#[derive(Debug, Clone)]
struct ImageRecord {
    path: PathBuf,
    lat: f64,
    lng: f64,
    gps_source: GpsSource,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum GpsSource {
    Exif,
    Default,
}

#[derive(Serialize, Debug)]
struct SupabaseInsert<'a> {
    image_url: &'a str,
    address: String,
    latitude: f64,
    longitude: f64,
}

// ---------- Main -----------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    if args.concurrency == 0 || args.concurrency > 32 {
        return Err(anyhow!("--concurrency must be in 1..=32"));
    }
    if !args.dir.is_dir() {
        return Err(anyhow!("not a directory: {}", args.dir.display()));
    }

    // ----- Stage 1: discovery + metadata --------------------------------
    let files = collect_images(&args.dir)?;
    if files.is_empty() {
        println!("No images found in {}", args.dir.display());
        return Ok(());
    }
    println!(
        "Found {} image{} in {}",
        files.len(),
        if files.len() == 1 { "" } else { "s" },
        args.dir.display()
    );

    let mut records = Vec::with_capacity(files.len());
    let mut skipped = 0usize;
    for path in files {
        match extract_record(&path, args.default_lat, args.default_lng) {
            Ok(rec) => records.push(rec),
            Err(e) => {
                if args.skip_no_gps {
                    eprintln!("  skip  {} — {e}", path.display());
                    skipped += 1;
                } else {
                    return Err(e.context(format!("processing {}", path.display())));
                }
            }
        }
    }
    if records.is_empty() {
        println!("No usable images (all missing GPS).");
        return Ok(());
    }
    let exif_count = records
        .iter()
        .filter(|r| r.gps_source == GpsSource::Exif)
        .count();
    println!(
        "  {} via EXIF · {} via --default · {} skipped",
        exif_count,
        records.len() - exif_count,
        skipped
    );

    if args.dry_run {
        println!(
            "\n[DRY-RUN] Would upload {} image(s). Showing first 5 records:",
            records.len()
        );
        for r in records.iter().take(5) {
            println!(
                "  {}  ({:.6}, {:.6})  source={:?}",
                r.path.display(),
                r.lat,
                r.lng,
                r.gps_source
            );
        }
        return Ok(());
    }

    // ----- Stage 2: parallel upload -------------------------------------
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("geoai-import/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let bar = ProgressBar::new(records.len() as u64);
    bar.set_style(
        ProgressStyle::with_template(
            "{elapsed_precise} [{bar:30.cyan/blue}] {pos}/{len}  {msg}",
        )?
        .progress_chars("=> "),
    );

    let started = Instant::now();
    let mut ok = 0usize;
    let mut fail = 0usize;

    let mut stream = stream::iter(records.into_iter().map(|r| {
        let client = client.clone();
        async move {
            let result = upload_one(&client, &r).await;
            (r, result)
        }
    }))
    .buffer_unordered(args.concurrency);

    while let Some((rec, result)) = stream.next().await {
        match result {
            Ok(()) => {
                ok += 1;
                bar.set_message(format!("✓ {}", short_name(&rec.path)));
            }
            Err(e) => {
                fail += 1;
                bar.set_message(format!("✗ {}", short_name(&rec.path)));
                eprintln!("\nFAIL  {}  →  {e}", rec.path.display());
            }
        }
        bar.inc(1);
    }
    bar.finish();

    let elapsed = started.elapsed().as_secs_f64();
    let rate = ok as f64 / elapsed.max(0.001);
    println!(
        "\n✓ {ok} imported · ✗ {fail} failed · {elapsed:.1}s wall  ({rate:.1}/s)"
    );
    if fail > 0 {
        std::process::exit(1);
    }
    Ok(())
}

// ---------- Discovery ------------------------------------------------------

fn collect_images(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for entry in WalkDir::new(dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.into_path();
        let ext = p
            .extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase);
        if matches!(ext.as_deref(), Some("jpg") | Some("jpeg") | Some("png")) {
            out.push(p);
        }
    }
    out.sort();
    Ok(out)
}

// ---------- EXIF extraction ------------------------------------------------

fn extract_record(
    path: &Path,
    def_lat: Option<f64>,
    def_lng: Option<f64>,
) -> Result<ImageRecord> {
    if let Some((lat, lng)) = read_exif_gps(path)? {
        return Ok(ImageRecord {
            path: path.to_path_buf(),
            lat,
            lng,
            gps_source: GpsSource::Exif,
        });
    }
    match (def_lat, def_lng) {
        (Some(lat), Some(lng)) => Ok(ImageRecord {
            path: path.to_path_buf(),
            lat,
            lng,
            gps_source: GpsSource::Default,
        }),
        _ => Err(anyhow!(
            "no EXIF GPS and no --default-lat / --default-lng"
        )),
    }
}

fn read_exif_gps(path: &Path) -> Result<Option<(f64, f64)>> {
    use exif::{In, Reader, Tag};

    let file = std::fs::File::open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let mut buf = std::io::BufReader::new(&file);
    let reader = match Reader::new().read_from_container(&mut buf) {
        Ok(r) => r,
        // PNGs and JPEGs without EXIF return errors — that's not fatal here.
        Err(_) => return Ok(None),
    };

    let lat_f = reader.get_field(Tag::GPSLatitude, In::PRIMARY);
    let lat_r = reader.get_field(Tag::GPSLatitudeRef, In::PRIMARY);
    let lng_f = reader.get_field(Tag::GPSLongitude, In::PRIMARY);
    let lng_r = reader.get_field(Tag::GPSLongitudeRef, In::PRIMARY);

    let (lat, lng) = match (lat_f, lat_r, lng_f, lng_r) {
        (Some(la), Some(lar), Some(ln), Some(lnr)) => {
            let lat = parse_dms(&la.value)?;
            let lng = parse_dms(&ln.value)?;
            let lat_sign = if dir_char(&lar.value).eq_ignore_ascii_case("S") {
                -1.0
            } else {
                1.0
            };
            let lng_sign = if dir_char(&lnr.value).eq_ignore_ascii_case("W") {
                -1.0
            } else {
                1.0
            };
            (lat * lat_sign, lng * lng_sign)
        }
        _ => return Ok(None),
    };
    Ok(Some((lat, lng)))
}

fn parse_dms(v: &exif::Value) -> Result<f64> {
    if let exif::Value::Rational(rats) = v {
        if rats.len() >= 3 {
            let to_f64 = |r: &exif::Rational| -> f64 {
                if r.denom == 0 {
                    0.0
                } else {
                    r.num as f64 / r.denom as f64
                }
            };
            let d = to_f64(&rats[0]);
            let m = to_f64(&rats[1]);
            let s = to_f64(&rats[2]);
            return Ok(d + m / 60.0 + s / 3600.0);
        }
    }
    Err(anyhow!("malformed GPS DMS triple"))
}

fn dir_char(v: &exif::Value) -> String {
    if let exif::Value::Ascii(strs) = v {
        if let Some(first) = strs.first() {
            return String::from_utf8_lossy(first).to_string();
        }
    }
    String::new()
}

// ---------- Upload pipeline ------------------------------------------------

async fn upload_one(client: &reqwest::Client, rec: &ImageRecord) -> Result<()> {
    // Read the file off-thread (tokio handles the spawn_blocking).
    let bytes = tokio::fs::read(&rec.path)
        .await
        .with_context(|| format!("read {}", rec.path.display()))?;
    let file_name = rec
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("photo.jpg")
        .to_owned();

    // ----- Cloudinary upload -----
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("image/jpeg")?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("upload_preset", CLOUDINARY_PRESET);

    let url = format!("https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD}/image/upload");
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .context("cloudinary POST failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("cloudinary status {status}: {body}"));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .context("cloudinary response not JSON")?;
    let image_url = json
        .get("secure_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("no secure_url in cloudinary response"))?;

    // ----- Supabase insert -----
    let payload = SupabaseInsert {
        image_url,
        address: format!("{:.4}, {:.4}", rec.lat, rec.lng),
        latitude: rec.lat,
        longitude: rec.lng,
    };

    let resp = client
        .post(format!("{SUPABASE_URL}/rest/v1/photos"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {SUPABASE_ANON_KEY}"))
        .header("Content-Type", "application/json")
        .header("Prefer", "return=minimal")
        .json(&payload)
        .send()
        .await
        .context("supabase POST failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("supabase status {status}: {body}"));
    }
    Ok(())
}

fn short_name(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string()
}
