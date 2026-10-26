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

use std::collections::{HashMap, HashSet};
use std::io::{BufWriter, Write};
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
    let outputs = output_paths(&args)?;

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

    for (format, path) in outputs {
        match format {
            OutputFormat::Json => {
                write_json_shape(&path, &photos, &assessments, &fetched_at, args.pretty)?
            }
            OutputFormat::Geojson => {
                write_geojson_shape(&path, &photos, &assessments, &fetched_at, args.pretty)?
            }
        }
        report_write(&path)?;
    }
    Ok(())
}

fn output_paths(args: &Args) -> Result<Vec<(OutputFormat, PathBuf)>> {
    let primary_default: PathBuf = match args.format {
        OutputFormat::Json => "data/snapshot.json".into(),
        OutputFormat::Geojson => "data/snapshot.geojson".into(),
    };
    let primary_path = args.output.clone().unwrap_or(primary_default);
    if args.both {
        let other_extension = if args.format == OutputFormat::Json {
            "geojson"
        } else {
            "json"
        };
        // Case-insensitive comparison also protects macOS/Windows filesystems.
        if primary_path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case(other_extension))
        {
            return Err(anyhow!(
                "--both output paths would overlap; use a primary extension matching --format"
            ));
        }
    }
    let mut outputs = Vec::new();
    if args.format == OutputFormat::Json || args.both {
        let path = if args.format == OutputFormat::Json {
            primary_path.clone()
        } else {
            primary_path.with_extension("json")
        };
        outputs.push((OutputFormat::Json, path));
    }
    if args.format == OutputFormat::Geojson || args.both {
        let path = if args.format == OutputFormat::Geojson {
            primary_path.clone()
        } else {
            primary_path.with_extension("geojson")
        };
        outputs.push((OutputFormat::Geojson, path));
    }
    Ok(outputs)
}

// ---------- Supabase REST fetch -------------------------------------------

async fn fetch_table(
    client: &reqwest::Client,
    table: &str,
    select: &str,
    limit: usize,
) -> Result<Vec<Row>> {
    fetch_table_from(client, SUPABASE_URL, table, select, limit).await
}

async fn fetch_table_from(
    client: &reqwest::Client,
    base_url: &str,
    table: &str,
    select: &str,
    limit: usize,
) -> Result<Vec<Row>> {
    let mut rows = Vec::new();
    let mut seen_ids = HashSet::new();
    while rows.len() < limit {
        let offset = rows.len();
        let page_limit = (limit - offset).min(1000);
        let url = format!(
        "{base_url}/rest/v1/{table}?select={select}&order=created_at.desc,id.desc&limit={page_limit}&offset={offset}"
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
        let page: Vec<Row> = resp.json().await.context("parse JSON")?;
        if page.is_empty() {
            break;
        }
        for row in &page {
            let id = row
                .get("id")
                .and_then(row_id)
                .ok_or_else(|| anyhow!("{table} row has no ID"))?;
            if !seen_ids.insert(id) {
                return Err(anyhow!(
                    "{table} pagination repeated a row; retry the snapshot"
                ));
            }
        }
        rows.extend(page);
    }
    Ok(rows)
}

fn row_id(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::String(id) => Some(id.clone()),
        serde_json::Value::Number(id) => Some(id.to_string()),
        _ => None,
    }
}

fn coordinates(row: &Row) -> Option<(f64, f64)> {
    let lat = row.get("latitude")?.as_f64()?;
    let lng = row.get("longitude")?.as_f64()?;
    (lat.is_finite() && lng.is_finite() && lat.abs() <= 90.0 && lng.abs() <= 180.0)
        .then_some((lat, lng))
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
        if let Some(pid) = a.get("photo_id").and_then(row_id) {
            by_photo_id.entry(pid).or_insert(a);
        }
        if let Some(url) = a.get("image_url").and_then(|v| v.as_str()) {
            by_image_url.entry(url.to_string()).or_insert(a);
        }
    }

    let mut used_assessments = HashSet::new();
    let features: Vec<serde_json::Value> = photos
        .iter()
        .map(|p| {
            // Start with the photo's columns, then overlay the assessment's.
            // Rename photo.id → photo_id first to avoid collision with assessment.id.
            let mut props = p.clone();
            if let Some(pid) = props.remove("id") {
                props.insert("photo_id".to_string(), pid);
            }

            let matched: Option<&Row> = p
                .get("id")
                .and_then(row_id)
                .and_then(|pid| by_photo_id.get(&pid).copied())
                .or_else(|| {
                    p.get("image_url")
                        .and_then(|v| v.as_str())
                        .and_then(|u| by_image_url.get(u).copied())
                })
                .filter(|a| {
                    let pid = a.get("photo_id").and_then(row_id);
                    (pid.is_none() || pid == p.get("id").and_then(row_id))
                        && a.get("id")
                            .and_then(row_id)
                            .is_none_or(|id| !used_assessments.contains(&id))
                });

            if let Some(a) = matched {
                if let Some(id) = a.get("id").and_then(row_id) {
                    used_assessments.insert(id);
                }
                for (k, v) in a.iter() {
                    // GeoJSON spec: each Feature has a unique top-level id;
                    // we keep the assessment's id as `assessment_id` and
                    // let the photo_id we already inserted stand.
                    if k == "id" {
                        props.insert("assessment_id".to_string(), v.clone());
                    } else if k != "photo_id" && k != "created_at" && !v.is_null() {
                        props.insert(k.clone(), v.clone());
                    }
                }
            }

            // Missing GPS is unknown, not a fabricated point at (0, 0).
            let geometry = match matched.and_then(coordinates).or_else(|| coordinates(p)) {
                Some((lat, lng)) => {
                    props.insert("latitude".to_string(), json!(lat));
                    props.insert("longitude".to_string(), json!(lng));
                    json!({"type": "Point", "coordinates": [lng, lat]})
                }
                _ => serde_json::Value::Null,
            };
            json!({
                "type": "Feature",
                "geometry": geometry,
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
    write_atomic(path, |file| {
        let mut writer = BufWriter::new(file);
        if pretty {
            serde_json::to_writer_pretty(&mut writer, value)?;
        } else {
            serde_json::to_writer(&mut writer, value)?;
        }
        writer.flush()?;
        Ok(())
    })
}

fn write_atomic(path: &Path, write: impl FnOnce(&mut std::fs::File) -> Result<()>) -> Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("mkdir {}", parent.display()))?;
        }
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let temporary = path.with_file_name(format!(
        ".geoai-snapshot-{}-{nonce}.tmp",
        std::process::id()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result: Result<()> = (|| {
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.with_context(|| format!("write {}", path.display()))
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
    let era = if z >= 0 {
        z / 146097
    } else {
        (z - 146096) / 146097
    };
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn row(value: serde_json::Value) -> Row {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn both_formats_never_share_an_output_path() {
        for (format, extension) in [("json", "geojson"), ("geojson", "JSON")] {
            let args = Args::try_parse_from([
                "snapshot",
                "--both",
                "--format",
                format,
                "--output",
                &format!("snapshot.{extension}"),
            ])
            .unwrap();
            assert!(output_paths(&args).is_err());
        }
        let args =
            Args::try_parse_from(["snapshot", "--both", "--output", "data/snapshot.json"]).unwrap();
        let outputs = output_paths(&args).unwrap();
        assert_eq!(outputs[0].1, PathBuf::from("data/snapshot.json"));
        assert_eq!(outputs[1].1, PathBuf::from("data/snapshot.geojson"));
    }

    #[test]
    fn interrupted_write_preserves_existing_snapshot_and_cleans_up() {
        let directory = std::env::temp_dir().join(format!("geoai-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("snapshot.json");
        std::fs::write(&path, "previous complete snapshot").unwrap();
        let result = write_atomic(&path, |file| {
            file.write_all(b"incomplete replacement")?;
            Err(anyhow!("simulated write failure"))
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "previous complete snapshot"
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        write_json(&path, &json!({"photos": []}), false).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"photos":[]}"#);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn geojson_matches_numeric_photo_ids_and_keeps_latest_assessment() {
        let path = std::env::temp_dir().join(format!("geoai-snapshot-{}.json", std::process::id()));
        let photos = vec![row(
            json!({"id": 7, "image_url": "photo", "latitude": 12.0, "longitude": 77.0, "created_at": "capture"}),
        )];
        let assessments = vec![
            row(
                json!({"id": "latest", "photo_id": 7, "image_url": "changed-url", "severity": "Low", "latitude": null, "created_at": "processed"}),
            ),
            row(json!({"id": "old", "photo_id": 7, "image_url": "photo", "severity": "High"})),
        ];
        write_geojson_shape(&path, &photos, &assessments, "now", false).unwrap();
        let data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        std::fs::remove_file(path).unwrap();
        let feature = &data["features"][0];
        assert_eq!(feature["properties"]["assessment_id"], "latest");
        assert_eq!(feature["properties"]["photo_id"], 7);
        assert_eq!(feature["properties"]["created_at"], "capture");
        assert_eq!(feature["geometry"]["coordinates"], json!([77.0, 12.0]));
    }

    #[test]
    fn geojson_keeps_missing_coordinates_unknown_and_zero_coordinates_valid() {
        let path =
            std::env::temp_dir().join(format!("geoai-coordinates-{}.json", std::process::id()));
        let photos = vec![
            row(json!({"id": 1})),
            row(json!({"id": 2, "latitude": 0.0, "longitude": 0.0})),
            row(json!({"id": 3, "latitude": 100.0, "longitude": 2.0})),
        ];
        write_geojson_shape(&path, &photos, &[], "now", false).unwrap();
        let data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        std::fs::remove_file(path).unwrap();
        assert!(data["features"][0]["geometry"].is_null());
        assert_eq!(
            data["features"][1]["geometry"]["coordinates"],
            json!([0.0, 0.0])
        );
        assert!(data["features"][2]["geometry"].is_null());
    }

    #[tokio::test]
    async fn fetch_reads_all_server_capped_pages_in_stable_order() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for offset in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|b| b == b"\r\n\r\n") {
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.contains(&format!("offset={offset}")));
                assert!(request.contains("order=created_at.desc,id.desc"));
                let body = if offset < 2 {
                    format!("[{{\"id\":{offset}}}]")
                } else {
                    "[]".to_string()
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap();
        let rows = fetch_table_from(&client, &base, "photos", "id", 10)
            .await
            .unwrap();
        server.join().unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn shared_urls_cannot_reuse_or_reassign_assessments() {
        for linked in [true, false] {
            let path = std::env::temp_dir()
                .join(format!("geoai-shared-{}-{linked}.json", std::process::id()));
            let photos = vec![
                row(json!({"id": 7, "image_url": "shared"})),
                row(json!({"id": 8, "image_url": "shared"})),
            ];
            let a = row(
                json!({"id": "a", "photo_id": if linked { json!(7) } else { json!(null) }, "image_url": "shared"}),
            );
            write_geojson_shape(&path, &photos, &[a], "now", false).unwrap();
            let data: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            std::fs::remove_file(path).unwrap();
            assert_eq!(data["features"][0]["properties"]["assessment_id"], "a");
            assert!(data["features"][1]["properties"]
                .get("assessment_id")
                .is_none());
        }
    }

    #[test]
    fn bad_assessment_gps_preserves_the_valid_photo_coordinate_pair() {
        let path =
            std::env::temp_dir().join(format!("geoai-gps-fallback-{}.json", std::process::id()));
        let photos = vec![row(json!({"id": 7, "latitude": 12.0, "longitude": 77.0}))];
        let assessments = vec![row(
            json!({"id": "a", "photo_id": 7, "latitude": 999.0, "longitude": 80.0}),
        )];
        write_geojson_shape(&path, &photos, &assessments, "now", false).unwrap();
        let data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(
            data["features"][0]["geometry"]["coordinates"],
            json!([77.0, 12.0])
        );
        assert_eq!(data["features"][0]["properties"]["latitude"], 12.0);
    }
}
