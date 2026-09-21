#!/bin/bash
set -euo pipefail

# Compile-check UIKit/SwiftUI without an iOS simulator. This does not build/run an iOS app.
geoai_root="$(cd "$(dirname "$0")/.." && pwd)"
geoai_check_dir="$(mktemp -d "${TMPDIR:-/tmp}/geoai-typecheck.XXXXXX")"
trap 'rm -rf "$geoai_check_dir"' EXIT
if [[ -n "${GEOAI_CHECK_SDK:-}" ]]; then
  geoai_sdk="$GEOAI_CHECK_SDK"
elif [[ -d /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk ]]; then
  # The CLT 27 SDK declares SwiftUI macros whose plugin is only shipped with full Xcode.
  geoai_sdk=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
else
  geoai_sdk="$(xcrun --sdk macosx --show-sdk-path)"
fi
geoai_arch="$(uname -m)"
geoai_flags=(-swift-version 5 -module-cache-path "$geoai_check_dir/cache"
  -target "${geoai_arch}-apple-ios17.0-macabi" -sdk "$geoai_sdk"
  -F "$geoai_sdk/System/iOSSupport/System/Library/Frameworks")
xcrun swiftc "${geoai_flags[@]}" -emit-module -parse-as-library -module-name GeoAICore \
  -emit-module-path "$geoai_check_dir/GeoAICore.swiftmodule" \
  "$geoai_root"/Packages/GeoAICore/Sources/GeoAICore/*.swift
xcrun swiftc "${geoai_flags[@]}" -emit-module -parse-as-library -module-name ThinkingOrbsKit \
  -emit-module-path "$geoai_check_dir/ThinkingOrbsKit.swiftmodule" \
  "$geoai_root"/Packages/ThinkingOrbsKit/Sources/ThinkingOrbsKit/*.swift
xcrun swiftc "${geoai_flags[@]}" -I "$geoai_check_dir" -typecheck \
  "$geoai_root"/GeoAI/*.swift "$geoai_root"/GeoAI/*/*.swift
echo "PASS: GeoAICore, ThinkingOrbsKit and all app Swift files typecheck against Mac Catalyst."
