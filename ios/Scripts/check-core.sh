#!/bin/bash
# Run the checked-in core regression methods without requiring XCTest/Xcode.
# Usage: Scripts/check-core.sh [scratch-directory]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK_DIR="${1:-$(mktemp -d "${TMPDIR:-/tmp}/geoai-core-checks.XXXXXX")}"
mkdir -p "$CHECK_DIR/ModuleCache"
CHECK_DIR="$(cd "$CHECK_DIR" && pwd)"

python3 "$SCRIPT_DIR/generate-core-checks.py" "$PROJECT_DIR" "$CHECK_DIR/CoreChecks.swift"
swiftc -swift-version 5 -module-cache-path "$CHECK_DIR/ModuleCache" \
    "$PROJECT_DIR"/Packages/GeoAICore/Sources/GeoAICore/*.swift \
    "$CHECK_DIR/CoreChecks.swift" -o "$CHECK_DIR/core-checks"
"$CHECK_DIR/core-checks" | tee "$CHECK_DIR/results.log"
printf '\nVerification artifacts: %s\n' "$CHECK_DIR"
