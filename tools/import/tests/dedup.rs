use std::process::Command;

#[test]
fn identical_files_are_scheduled_once_in_the_same_import() {
    let dir = std::env::temp_dir().join(format!("geoai-dedup-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("one.jpg"), b"same image bytes, no EXIF").unwrap();
    std::fs::write(dir.join("two.jpg"), b"same image bytes, no EXIF").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_geoai-import"))
        .args([
            "--dry-run",
            "--default-lat",
            "0",
            "--default-lng",
            "0",
            "--dir",
        ])
        .arg(&dir)
        .arg("--state-file")
        .arg(dir.join("state.json"))
        .output()
        .unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Would upload 1 image(s)"));
}
