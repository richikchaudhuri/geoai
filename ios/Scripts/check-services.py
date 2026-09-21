#!/usr/bin/env python3
"""Check configured public endpoints without creating photos or database rows."""
import concurrent.futures
import json
import plistlib
from pathlib import Path
import subprocess
import urllib.parse


def request(url, *, headers=None, data=None):
    # System curl uses this Mac's trusted certificates; never disable TLS checks.
    command = ["/usr/bin/curl", "--silent", "--show-error", "--max-time", "25",
               "--dump-header", "/dev/stderr", "--write-out", "\n%{http_code}", url]
    for name, value in (headers or {}).items():
        command.extend(["--header", name + ": " + value])
    if data is not None:
        command.extend(["--data-binary", "@-"])
    result = subprocess.run(command, input=data, capture_output=True)
    if result.returncode:
        raise RuntimeError(result.stderr.decode().strip())
    body, code = result.stdout.rsplit(b"\n", 1)
    response_headers = {}
    for line in result.stderr.decode().splitlines():
        if ":" in line:
            name, value = line.split(":", 1)
            response_headers[name.lower()] = value.strip()
    return int(code), body, response_headers


def main():
    config = plistlib.loads((Path(__file__).resolve().parents[1] / "GeoAI/Resources/Configuration.plist").read_bytes())
    key = config["SupabasePublicKey"]
    headers = {"apikey": key, "Accept": "application/json", "Prefer": "count=exact"}
    if key.count(".") == 2:
        headers["Authorization"] = "Bearer " + key

    def table(name, columns, label=None):
        query = urllib.parse.urlencode({"select": columns, "limit": 1})
        code, body, response_headers = request(config["SupabaseURL"].rstrip("/") + "/rest/v1/" + name + "?" + query, headers=headers)
        if 200 <= code < 300:
            return {"check": label or name, "status": code, "result": "readable", "range": response_headers.get("content-range")}
        error = json.loads(body)
        return {"check": label or name, "status": code, "code": error.get("code"), "message": error.get("message")}

    def cloudinary():
        # Invalid image bytes deliberately exercise preset validation without
        # uploading an asset. This cannot verify a real image's size/format rules.
        data = urllib.parse.urlencode({"upload_preset": config["CloudinaryUploadPreset"],
                                      "file": "data:image/jpeg;base64,bm90LWFuLWltYWdl"}).encode()
        url = "https://api.cloudinary.com/v1_1/" + config["CloudinaryCloudName"] + "/image/upload"
        code, body, _ = request(url, headers={"Content-Type": "application/x-www-form-urlencoded"}, data=data)
        reply = json.loads(body)
        return {"check": "cloudinary-invalid-image-probe", "status": code,
                "message": reply.get("error", {}).get("message", "Unexpected response; inspect service separately")}

    checks = [lambda: table("photos", "id,captured_at", "photos-capture-time"),
              lambda: table("photos", "id,latitude,longitude,address,image_url,created_at", "photos-base-columns"),
              lambda: table("assessments", "id,photo_id,latitude,longitude,address,image_url,status,distress_types,severity,stage2_confidence,stage1_confidence,description,processed_at,created_at,expert_reviewed,expert_corrected_types,expert_corrected_severity"),
              cloudinary]
    failed = False
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        for check, future in zip(["photos-capture-time", "photos-legacy", "assessments", "cloudinary"], [executor.submit(fn) for fn in checks]):
            try:
                result = future.result()
                print(json.dumps(result))
                if check == "cloudinary":
                    failed |= not (result["status"] == 400 and result.get("message") == "Invalid image file")
                else:
                    failed |= result.get("result") != "readable"
            except Exception as error:
                print(json.dumps({"check": check, "error": str(error)}))
                failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
