//! geoai-snapshot — freeze the live Supabase photos + assessments tables
//! into a static file that can be checked in, cited, or loaded by the
//! WebGIS as an offline fallback.
//!
//! Two output formats:
//!
//! - `json` (default) — matches the WebGIS fetch shape
//!   `{photos, assessments, fetchedAt}`. Drop this at `data/snapshot.json`
//!   and the WebGIS can fall back to it when Supabase is unreachable.
//!
//! - `geojson` — a GeoJSON `FeatureCollection` where each `Feature` is a
//!   photo merged with its matching assessment. Opens directly in QGIS,
//!   ArcGIS, kepler.gl, or any standard GIS tool. Citable in the research
//!   report.
//!
//! `--both` writes both formats side-by-side.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use clap::{Parser, ValueEnum};
use serde_json::json;

// ---------- Embedded config (mirrors the WebGIS client) -------------------

const SUPABASE_URL: &str = "https://vtlkitpoffudiefuoijb.supabase.co";
const SUPABASE_ANON_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ0bGtpdHBvZmZ1ZGllZnVvaWpiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQyMDAzMjIsImV4cCI6MjA4OTc3NjMyMn0.wLrwTky4k8iAELOvFbNeo063Z1rjQKOzzq3QYFqR6CU";

const PHOTOS_SELECT: &str = "id,latitude,longitude,address,image_url,created_at";
const ASSESSMENTS_SELECT: &str = "id,photo_id,latitude,longitude,address,image_url,status,\
    distress_types,severity,stage2_confidence,stage1_confidence,description,\
    processed_at,created_at,expert_reviewed,expert_corrected_types,expert_corrected_severity";

const DEFAULT_LIMIT: usize = 10000;

// ---------- CLI ------------------------------------------------------------

#[derive(Parser, Debug)]
#[command(
    version,
    about = "Export live Supabase data to a static JSON / GeoJSON file"
)]
struct Args {
    /// Output path. Defaults to data/snapshot.json or data/snapshot.geojson
    /// depending on --format.
    #[arg(long)]
    output: Option<PathBuf>,

    /// Output format.
    #[arg(long, value_enum, default_value_t = OutputFormat::Json)]
    format: OutputFormat,

    /// Write BOTH json and geojson side-by-side.
    #[arg(long)]
    both: bool,

    /// Pretty-print (indented). Default: minified (smaller file).
    #[arg(long)]
    pretty: bool,

    /// Row limit per table. Default 10000 (Supabase REST cap).
    #[arg(long)]
    limit: Option<usize>,
}

#[derive(Clone, Copy, ValueEnum, Debug, PartialEq)]
enum OutputFormat {
    /// `{photos, assessments, fetchedAt}` — matches the WebGIS fetch shape.
    Json,
    /// GeoJSON FeatureCollection with photo+assessment merged into properties.
    Geojson,
}

// Raw row from Supabase. We use serde_json::Map so we're robust to schema
// additions — new columns just appear in the output unchanged.
type Row = serde_json::Map<String, serde_json::Value>;

// ---------- Main -----------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let limit = args.limit.unwrap_or(DEFAULT_LIMIT);
    if limit == 0 || limit > 10000 {
        return Err(anyhow!("--limit must be in 1..=10000"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .user_agent(concat!("geoai-snapshot/", env!("CARGO_PKG_VERSION")))
        .build()?;

    println!("Fetching from {SUPABASE_URL} …");
    let started = Instant::now();

    let (photos_res, assess_res) = tokio::join!(
        fetch_table(&client, "photos", PHOTOS_SELECT, limit),
        fetch_table(&client, "assessments", ASSESSMENTS_SELECT, limit),
    );
    let photos = photos_res.context("fetching photos")?;
    let assessments = assess_res.context("fetching assessments")?;
    let fetched_at = iso8601_now();

    let elapsed = started.elapsed().as_secs_f64();
    println!(
        "  photos: {} rows · assessments: {} rows · {elapsed:.2}s",
        photos.len(),
        assessments.len()
    );

    let want_json = args.format == OutputFormat::Json || args.both;
    let want_geojson = args.format == OutputFormat::Geojson || args.both;

    let primary_default: PathBuf = match args.format {
        OutputFormat::Json => "data/snapshot.json".into(),
        OutputFormat::Geojson => "data/snapshot.geojson".into(),
    };
    let primary_path = args.output.clone().unwrap_or(primary_default);

    if want_json {
        let path = if args.format == OutputFormat::Json {
            primary_path.clone()
        } else {
            primary_path.with_extension("json")
        };
        write_json_shape(&path, &photos, &assessments, &fetched_at, args.pretty)?;
        report_write(&path)?;
    }
    if want_geojson {
        let path = if args.format == OutputFormat::Geojson {
            primary_path.clone()
        } else {
            primary_path.with_extension("geojson")
        };
        write_geojson_shape(&path, &photos, &assessments, &fetched_at, args.pretty)?;
        report_write(&path)?;
    }
    Ok(())
}

// ---------- Supabase REST fetch -------------------------------------------

async fn fetch_table(
    client: &reqwest::Client,
    table: &str,
    select: &str,
    limit: usize,
) -> Result<Vec<Row>> {
    let url = format!(
        "{SUPABASE_URL}/rest/v1/{table}?select={select}&order=created_at.desc&limit={limit}"
    );
    let resp = client
        .get(&url)
        .header("apikey", SUPABASE_ANON_KEY)
        .header("Authorization", format!("Bearer {SUPABASE_ANON_KEY}"))
        .header("Accept", "application/json")
        .send()
        .await
        .with_context(|| format!("GET {table}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("{table} status {status}: {body}"));
    }
    let rows: Vec<Row> = resp.json().await.context("parse JSON")?;
    Ok(rows)
}

// ---------- JSON writers ---------------------------------------------------

fn write_json_shape(
    path: &Path,
    photos: &[Row],
    assessments: &[Row],
    fetched_at: &str,
    pretty: bool,
) -> Result<()> {
    let payload = json!({
        "photos": photos,
        "assessments": assessments,
        "fetchedAt": fetched_at,
        "_meta": {
            "tool": concat!("geoai-snapshot/", env!("CARGO_PKG_VERSION")),
            "source": SUPABASE_URL,
            "photo_count": photos.len(),
            "assessment_count": assessments.len(),
        }
    });
    write_json(path, &payload, pretty)
}

fn write_geojson_shape(
    path: &Path,
    photos: &[Row],
    assessments: &[Row],
    fetched_at: &str,
    pretty: bool,
) -> Result<()> {
    // Build photo_id → assessment AND image_url → assessment lookups.
    // The WebGIS uses both keys when merging — replicate that here so
    // the GeoJSON Feature properties match what the live UI sees.
    let mut by_photo_id: HashMap<String, &Row> = HashMap::new();
    let mut by_image_url: HashMap<String, &Row> = HashMap::new();
    for a in assessments {
        if let Some(pid) = a.get("photo_id").and_then(|v| v.as_str()) {
            by_photo_id.insert(pid.to_string(), a);
        }
        if let Some(url) = a.get("image_url").and_then(|v| v.as_str()) {
            by_image_url.insert(url.to_string(), a);
        }
    }

    let features: Vec<serde_json::Value> = photos
        .iter()
        .map(|p| {
            let lat = p.get("latitude").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let lng = p.get("longitude").and_then(|v| v.as_f64()).unwrap_or(0.0);

            // Start with the photo's columns, then overlay the assessment's.
            // Rename photo.id → photo_id first to avoid collision with assessment.id.
            let mut props = p.clone();
            if let Some(pid) = props.remove("id") {
                props.insert("photo_id".to_string(), pid);
            }

            let matched: Option<&Row> = p
                .get("photo_id")
                .and_then(|v| v.as_str())
                .and_then(|pid| by_photo_id.get(pid).copied())
                .or_else(|| {
                    p.get("image_url")
                        .and_then(|v| v.as_str())
                        .and_then(|u| by_image_url.get(u).copied())
                })
                .or_else(|| {
                    props
                        .get("photo_id")
                        .and_then(|v| v.as_str())
                        .and_then(|pid| by_photo_id.get(pid).copied())
                });

            if let Some(a) = matched {
                for (k, v) in a.iter() {
                    // GeoJSON spec: each Feature has a unique top-level id;
                    // we keep the assessment's id as `assessment_id` and
                    // let the photo_id we already inserted stand.
                    if k == "id" {
                        props.insert("assessment_id".to_string(), v.clone());
                    } else {
                        props.insert(k.clone(), v.clone());
                    }
                }
            }

            json!({
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lng, lat]   // GeoJSON spec: [lng, lat]
                },
                "properties": props
            })
        })
        .collect();

    let classified = features
        .iter()
        .filter(|f| {
            f.get("properties")
                .and_then(|p| p.get("status"))
                .and_then(|s| s.as_str())
                .map(|s| s.eq_ignore_ascii_case("classified"))
                .unwrap_or(false)
        })
        .count();

    let payload = json!({
        "type": "FeatureCollection",
        "metadata": {
            "generated_at": fetched_at,
            "source": SUPABASE_URL,
            "tool": concat!("geoai-snapshot/", env!("CARGO_PKG_VERSION")),
            "photo_count": photos.len(),
            "assessment_count": assessments.len(),
            "feature_count": features.len(),
            "classified_count": classified,
        },
        "features": features,
    });

    write_json(path, &payload, pretty)
}

fn write_json(path: &Path, value: &serde_json::Value, pretty: bool) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))?;
        }
    }
    let text = if pretty {
        serde_json::to_string_pretty(value)?
    } else {
        serde_json::to_string(value)?
    };
    std::fs::write(path, &text).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

fn report_write(path: &Path) -> Result<()> {
    let bytes = std::fs::metadata(path)?.len();
    let kb = bytes as f64 / 1024.0;
    if kb < 1024.0 {
        println!("  wrote {}  ({kb:.1} KB)", path.display());
    } else {
        println!("  wrote {}  ({:.2} MB)", path.display(), kb / 1024.0);
    }
    Ok(())
}

// ---------- ISO 8601 timestamp (no chrono dep) ----------------------------

fn iso8601_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (now / 86400) as i64;
    let secs_in_day = now % 86400;
    let h = secs_in_day / 3600;
    let m = (secs_in_day / 60) % 60;
    let s = secs_in_day % 60;
    let (y, mo, d) = days_to_ymd(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Days since 1970-01-01 (Unix epoch) → (year, month, day) in the proleptic
/// Gregorian calendar. Civil-from-days algorithm from Howard Hinnant:
/// https://howardhinnant.github.io/date_algorithms.html
fn days_to_ymd(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z / 146097 } else { (z - 146096) / 146097 };
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y_base = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m_civ = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m_civ <= 2 { y_base + 1 } else { y_base };
    (y, m_civ as u32, d as u32)
}
