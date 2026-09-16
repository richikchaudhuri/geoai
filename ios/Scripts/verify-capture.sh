#!/bin/bash
set -euo pipefail

# Foundation-only checks; URLProtocol intercepts all HTTP requests.
capture_script_dir="$(cd "$(dirname "$0")" && pwd)"
capture_project_dir="$(cd "$capture_script_dir/.." && pwd)"
capture_test_dir="$(mktemp -d "${TMPDIR:-/tmp}/geoai-capture-check.XXXXXX")"
trap 'rm -rf "$capture_test_dir"' EXIT

swiftc -swift-version 5 -parse-as-library \
  -module-cache-path "$capture_test_dir/ModuleCache" \
  "$capture_project_dir/GeoAI/Capture/CaptureConfiguration.swift" \
  "$capture_project_dir/GeoAI/Capture/CaptureDraftStore.swift" \
  "$capture_project_dir/GeoAI/Capture/CaptureUploadClient.swift" \
  "$capture_script_dir/CaptureNetworkChecks.swift" \
  -o "$capture_test_dir/CaptureNetworkChecks"
"$capture_test_dir/CaptureNetworkChecks"
