//! geoai-import — bulk-import pavement-distress images.
//!
//! Walks a directory of JPEG/PNG images, reads EXIF GPS (or falls back to
//! CLI-supplied defaults), optionally reverse-geocodes the coordinates,
//! and uploads each image to Cloudinary + writes a row to the Supabase
//! `photos` table. The existing AI worker picks up each photo and creates
//! the corresponding `assessments` row asynchronously.
//!
//! v0.2 features:
//! - Reverse-geocoding via Nominatim (`--geocode`, opt-in, throttled to
//!   1 req/sec, results cached by rounded coords in the state file).
//! - Resumability via SHA-256 dedup in a JSON state file. Re-running on
//!   the same folder skips already-uploaded images (`--no-resume` opts out).
//! - Per-request retry with exponential backoff (`--retries N`). Only
//!   transient errors (network failures, HTTP 5xx, 429) are retried;
//!   4xx errors fail fast.
//!
//! Self-contained: no Python, no Node, no SDKs. Just direct HTTPS to
//! Cloudinary, Supabase, and Nominatim REST.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use clap::Parser;
use futures::stream::{self, StreamExt};
use indicatif::{ProgressBar, ProgressStyle};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

// ---------- Embedded config (mirrors the mobile app) -----------------------

const CLOUDINARY_CLOUD: &str = "dnxpt5gea";
const CLOUDINARY_PRESET: &str = "photos";
const SUPABASE_URL: &str = "https://vtlkitpoffudiefuoijb.supabase.co";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU";

// Nominatim usage policy: ≤1 request per second + UA must identify the app.
// https://operations.osmfoundation.org/policies/nominatim/
const NOMINATIM_URL: &str = "https://nominatim.openstreetmap.org/reverse";
const NOMINATIM_MIN_INTERVAL: Duration = Duration::from_millis(1100);

const DEFAULT_STATE_FILE: &str = ".geoai-import-state.json";
const STATE_FILE_VERSION: &str = "0.2";

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

    /// Enable reverse-geocoding via Nominatim (slow: 1 req/sec).
    /// Results are cached by rounded coords (4 decimals, ~11m) in the
    /// state file, so subsequent runs reuse them.
    #[arg(long)]
    geocode: bool,

    /// Path to the JSON state file (SHA-256 upload dedup + geocode cache).
    #[arg(long, default_value = DEFAULT_STATE_FILE)]
    state_file: PathBuf,

    /// Ignore the state file on startup. Re-upload everything.
    /// Successful uploads still get recorded in the state file.
    #[arg(long)]
    no_resume: bool,

    /// Retries per request on transient failures (network, 5xx, 429).
    /// Backoff is exponential: 1s, 2s, 4s, …
    #[arg(long, default_value_t = 2)]
    retries: u32,
}

// ---------- Data types -----------------------------------------------------

#[derive(Debug, Clone)]
struct ImageRecord {
    path: PathBuf,
    sha256: String,
    lat: f64,
    lng: f64,
    gps_source: GpsSource,
    address: String, // populated by geocoder (or coord-string fallback at upload time)
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

// ---------- State file -----------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct StateFile {
    #[serde(default = "default_state_version")]
    version: String,
    #[serde(default)]
    uploads: HashMap<String, UploadEntry>, // sha256 → entry
    #[serde(default)]
    geocode_cache: HashMap<String, String>, // "lat,lng" (4 decimals) → display_name
}

#[derive(Debug, Serialize, Deserialize)]
struct UploadEntry {
    path: String,
    image_url: String,
    lat: f64,
    lng: f64,
    uploaded_at: u64, // unix seconds
}

fn default_state_version() -> String {
    STATE_FILE_VERSION.to_string()
}

impl StateFile {
    fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self {
                version: STATE_FILE_VERSION.to_string(),
                ..Self::default()
            });
        }
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("read {}", path.display()))?;
        // Tolerate junk state — if the file is corrupt we just start fresh.
        match serde_json::from_str::<Self>(&text) {
            Ok(s) => Ok(s),
            Err(e) => {
                eprintln!(
                    "WARN: state file {} unreadable ({e}); starting fresh",
                    path.display()
                );
                Ok(Self {
                    version: STATE_FILE_VERSION.to_string(),
                    ..Self::default()
                })
            }
        }
    }

    fn save_atomic(&self, path: &Path) -> Result<()> {
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    fn has_upload(&self, sha: &str) -> bool {
        self.uploads.contains_key(sha)
    }

    fn record_upload(&mut self, sha: &str, path: &Path, image_url: &str, lat: f64, lng: f64) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.uploads.insert(
            sha.to_string(),
            UploadEntry {
                path: path.display().to_string(),
                image_url: image_url.to_string(),
                lat,
                lng,
                uploaded_at: now,
            },
        );
    }
}

// ---------- Errors ---------------------------------------------------------

#[derive(Debug)]
struct UploadErr {
    msg: String,
    retryable: bool,
}

impl std::fmt::Display for UploadErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.msg)
    }
}
impl std::error::Error for UploadErr {}

fn fatal(msg: impl Into<String>) -> UploadErr {
    UploadErr {
        msg: msg.into(),
        retryable: false,
    }
}
fn transient(msg: impl Into<String>) -> UploadErr {
    UploadErr {
        msg: msg.into(),
        retryable: true,
    }
}

// ---------- Main -----------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    if args.concurrency == 0 || args.concurrency > 32 {
        return Err(anyhow!("--concurrency must be in 1..=32"));
    }
    if args.retries > 8 {
        return Err(anyhow!("--retries must be ≤ 8"));
    }
    if !args.dir.is_dir() {
        return Err(anyhow!("not a directory: {}", args.dir.display()));
    }

    // Load state file (or fresh empty one if --no-resume).
    let mut state = if args.no_resume {
        println!("--no-resume: ignoring state file at startup");
        StateFile {
            version: STATE_FILE_VERSION.to_string(),
            ..Default::default()
        }
    } else {
        StateFile::load(&args.state_file).context("loading state file")?
    };

    // ----- Stage 1: discovery + hash + EXIF + dedup ---------------------
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

    println!("Stage 1: hash + EXIF + dedup");
    let bar1 = ProgressBar::new(files.len() as u64);
    bar1.set_style(spinner_style()?);

    let mut records: Vec<ImageRecord> = Vec::with_capacity(files.len());
    let mut skipped_dedup = 0usize;
    let mut skipped_no_gps = 0usize;

    for path in &files {
        bar1.set_message(short_name(path));
        let sha = sha256_file(path)?;
        if state.has_upload(&sha) {
            skipped_dedup += 1;
            bar1.inc(1);
            continue;
        }
        match extract_record(path, sha, args.default_lat, args.default_lng) {
            Ok(rec) => records.push(rec),
            Err(e) => {
                if args.skip_no_gps {
                    skipped_no_gps += 1;
                } else {
                    bar1.finish_and_clear();
                    return Err(e.context(format!("processing {}", path.display())));
                }
            }
        }
        bar1.inc(1);
    }
    bar1.finish_and_clear();

    let exif_count = records
        .iter()
        .filter(|r| r.gps_source == GpsSource::Exif)
        .count();
    println!(
        "  → {} new · {} EXIF / {} default · {} already-uploaded · {} no-GPS skipped",
        records.len(),
        exif_count,
        records.len() - exif_count,
        skipped_dedup,
        skipped_no_gps
    );

    if records.is_empty() {
        println!("Nothing to upload.");
        return Ok(());
    }

    // ----- Stage 2: reverse-geocoding (optional) ------------------------
    if args.geocode {
        println!("Stage 2: reverse-geocode via Nominatim (≤1 req/sec)");
        run_geocoding(&mut records, &mut state, &args.state_file).await?;
    }

    if args.dry_run {
        println!(
            "\n[DRY-RUN] Would upload {} image(s). First 5 records:",
            records.len()
        );
        for r in records.iter().take(5) {
            let addr = if r.address.is_empty() {
                format!("(coords: {:.4}, {:.4})", r.lat, r.lng)
            } else {
                short_addr(&r.address)
            };
            println!(
                "  {}  ({:.6}, {:.6})  source={:?}  addr=\"{}\"",
                r.path.display(),
                r.lat,
                r.lng,
                r.gps_source,
                addr
            );
        }
        return Ok(());
    }

    // ----- Stage 3: parallel uploads with retry -------------------------
    println!("Stage 3: uploading (concurrency={}, retries={})", args.concurrency, args.retries);
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
    let retries = args.retries;

    let mut stream = stream::iter(records.into_iter().map(|r| {
        let client = client.clone();
        async move {
            let result = process_with_retry(&client, &r, retries).await;
            (r, result)
        }
    }))
    .buffer_unordered(args.concurrency);

    while let Some((rec, result)) = stream.next().await {
        match result {
            Ok(image_url) => {
                ok += 1;
                bar.set_message(format!("✓ {}", short_name(&rec.path)));
                state.record_upload(&rec.sha256, &rec.path, &image_url, rec.lat, rec.lng);
                // Save after each success — cheap, gives crash-resume.
                if let Err(e) = state.save_atomic(&args.state_file) {
                    eprintln!("\nWARN: failed to save state: {e}");
                }
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

// ---------- Discovery + hashing -------------------------------------------

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

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)
        .with_context(|| format!("hash {}", path.display()))?;
    let digest = hasher.finalize();
    Ok(hex_lower(&digest))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

// ---------- EXIF extraction ------------------------------------------------

fn extract_record(
    path: &Path,
    sha256: String,
    def_lat: Option<f64>,
    def_lng: Option<f64>,
) -> Result<ImageRecord> {
    if let Some((lat, lng)) = read_exif_gps(path)? {
        return Ok(ImageRecord {
            path: path.to_path_buf(),
            sha256,
            lat,
            lng,
            gps_source: GpsSource::Exif,
            address: String::new(),
        });
    }
    match (def_lat, def_lng) {
        (Some(lat), Some(lng)) => Ok(ImageRecord {
            path: path.to_path_buf(),
            sha256,
            lat,
            lng,
            gps_source: GpsSource::Default,
            address: String::new(),
        }),
        _ => Err(anyhow!("no EXIF GPS and no --default-lat / --default-lng")),
    }
}

fn read_exif_gps(path: &Path) -> Result<Option<(f64, f64)>> {
    use exif::{In, Reader, Tag};

    let file = std::fs::File::open(path)
        .with_context(|| format!("open {}", path.display()))?;
    let mut buf = std::io::BufReader::new(&file);
    let reader = match Reader::new().read_from_container(&mut buf) {
        Ok(r) => r,
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

// ---------- Geocoding (Nominatim, 1 req/sec) -------------------------------

async fn run_geocoding(
    records: &mut [ImageRecord],
    state: &mut StateFile,
    state_path: &Path,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent(format!(
            "geoai-import/{} (capstone; +https://github.com/richikchaudhuri/geoai)",
            env!("CARGO_PKG_VERSION")
        ))
        .build()?;

    // Build the set of unique locations needing lookup.
    let mut unique: Vec<(String, f64, f64)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for rec in records.iter() {
        let key = round_key(rec.lat, rec.lng);
        if !state.geocode_cache.contains_key(&key) && seen.insert(key.clone()) {
            unique.push((key, rec.lat, rec.lng));
        }
    }
    let total_records = records.len();
    let cache_hits = total_records
        - records
            .iter()
            .filter(|r| !state.geocode_cache.contains_key(&round_key(r.lat, r.lng)))
            .count();
    println!(
        "  → {} unique locations to fetch · {} cache hits (across {} records)",
        unique.len(),
        cache_hits,
        total_records
    );

    if !unique.is_empty() {
        let bar = ProgressBar::new(unique.len() as u64);
        bar.set_style(
            ProgressStyle::with_template(
                "{elapsed_precise} [{bar:30.cyan/blue}] {pos}/{len}  {msg}",
            )?
            .progress_chars("=> "),
        );
        let mut last_request: Option<Instant> = None;
        for (i, (key, lat, lng)) in unique.iter().enumerate() {
            if let Some(prev) = last_request {
                let elapsed = prev.elapsed();
                if elapsed < NOMINATIM_MIN_INTERVAL {
                    tokio::time::sleep(NOMINATIM_MIN_INTERVAL - elapsed).await;
                }
            }
            last_request = Some(Instant::now());

            match geocode_one(&client, *lat, *lng).await {
                Ok(addr) => {
                    bar.set_message(format!("✓ {}", short_addr(&addr)));
                    state.geocode_cache.insert(key.clone(), addr);
                }
                Err(e) => {
                    bar.set_message(format!("✗ {key}  ({e})"));
                    // Don't cache failure — let the coord-string fallback kick in
                    // at upload time, and a future run can retry the geocode.
                }
            }
            bar.inc(1);

            // Periodic snapshot — every 10 lookups so we don't lose progress
            // on a crash.
            if i % 10 == 9 {
                let _ = state.save_atomic(state_path);
            }
        }
        bar.finish();
        state.save_atomic(state_path)?;
    }

    // Apply cached addresses back to records.
    for rec in records.iter_mut() {
        if let Some(addr) = state.geocode_cache.get(&round_key(rec.lat, rec.lng)) {
            rec.address = addr.clone();
        }
    }
    Ok(())
}

fn round_key(lat: f64, lng: f64) -> String {
    format!("{:.4},{:.4}", lat, lng)
}

async fn geocode_one(client: &reqwest::Client, lat: f64, lng: f64) -> Result<String> {
    let url = format!(
        "{NOMINATIM_URL}?lat={lat:.6}&lon={lng:.6}&format=json&zoom=18&addressdetails=0"
    );
    let resp = client
        .get(&url)
        .send()
        .await
        .context("nominatim GET failed")?;
    let status = resp.status();
    if !status.is_success() {
        return Err(anyhow!("nominatim status {status}"));
    }
    let body: serde_json::Value = resp.json().await.context("nominatim response not JSON")?;
    body.get("display_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("no display_name in nominatim response"))
}

// ---------- Upload pipeline with retry/backoff -----------------------------

async fn process_with_retry(
    client: &reqwest::Client,
    rec: &ImageRecord,
    retries: u32,
) -> Result<String, UploadErr> {
    let bytes = tokio::fs::read(&rec.path)
        .await
        .map_err(|e| fatal(format!("read {}: {e}", rec.path.display())))?;

    let image_url = with_retry(retries, "cloudinary", || async {
        cloudinary_upload(client, rec, &bytes).await
    })
    .await?;

    let address = if rec.address.is_empty() {
        format!("{:.4}, {:.4}", rec.lat, rec.lng)
    } else {
        rec.address.clone()
    };
    let payload = SupabaseInsert {
        image_url: &image_url,
        address,
        latitude: rec.lat,
        longitude: rec.lng,
    };
    with_retry(retries, "supabase", || async {
        supabase_insert(client, &payload).await
    })
    .await?;

    Ok(image_url)
}

async fn with_retry<F, Fut, T>(retries: u32, label: &str, mut f: F) -> Result<T, UploadErr>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, UploadErr>>,
{
    let mut attempt = 0u32;
    loop {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) if e.retryable && attempt < retries => {
                attempt += 1;
                // 1s, 2s, 4s, 8s …
                let backoff = Duration::from_millis(500 * (1u64 << attempt));
                tokio::time::sleep(backoff).await;
            }
            Err(e) => {
                let suffix = if attempt == 0 {
                    String::new()
                } else if attempt == 1 {
                    " (after 1 retry)".to_string()
                } else {
                    format!(" (after {attempt} retries)")
                };
                return Err(UploadErr {
                    msg: format!("{label}: {}{suffix}", e.msg),
                    retryable: false,
                });
            }
        }
    }
}

async fn cloudinary_upload(
    client: &reqwest::Client,
    rec: &ImageRecord,
    bytes: &[u8],
) -> Result<String, UploadErr> {
    let file_name = rec
        .path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("photo.jpg")
        .to_owned();
    let part = reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name(file_name)
        .mime_str("image/jpeg")
        .map_err(|e| fatal(format!("mime: {e}")))?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("upload_preset", CLOUDINARY_PRESET);

    let url = format!("https://api.cloudinary.com/v1_1/{CLOUDINARY_CLOUD}/image/upload");
    let resp = client
        .post(&url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| transient(format!("network: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("cloudinary {status}: {body}");
        return Err(if status.is_server_error() || status.as_u16() == 429 {
            transient(msg)
        } else {
            fatal(msg)
        });
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| fatal(format!("cloudinary JSON: {e}")))?;
    json.get("secure_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| fatal("no secure_url in cloudinary response"))
}

async fn supabase_insert(
    client: &reqwest::Client,
    payload: &SupabaseInsert<'_>,
) -> Result<(), UploadErr> {
    let resp = client
        .post(format!("{SUPABASE_URL}/rest/v1/photos"))
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {SUPABASE_ANON_KEY}"))
        .header("Content-Type", "application/json")
        .header("Prefer", "return=minimal")
        .json(payload)
        .send()
        .await
        .map_err(|e| transient(format!("network: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("supabase {status}: {body}");
        return Err(if status.is_server_error() || status.as_u16() == 429 {
            transient(msg)
        } else {
            fatal(msg)
        });
    }
    Ok(())
}

// ---------- Display helpers -----------------------------------------------

fn short_name(p: &Path) -> String {
    p.file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("?")
        .to_string()
}

fn short_addr(addr: &str) -> String {
    let truncated: String = addr.chars().take(60).collect();
    if addr.chars().count() > 60 {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn spinner_style() -> Result<ProgressStyle> {
    Ok(ProgressStyle::with_template(
        "{elapsed_precise} [{bar:30.cyan/blue}] {pos}/{len}  {msg}",
    )?
    .progress_chars("=> "))
}
