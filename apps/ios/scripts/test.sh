#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=../Kit/Linux/swift-env.sh
source Kit/Linux/swift-env.sh
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/gallery-native-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
build_linux_shims "$test_dir"
kit_libraries "$test_dir" "" KitCore KitNet KitLifecycle
"${SWIFTC[@]}" ${SHIM_FLAGS[@]+"${SHIM_FLAGS[@]}"} -j "$JOBS" -swift-version 6 -parse-as-library -strict-concurrency=complete -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitLifecycle -Xlinker -rpath -Xlinker "$test_dir" \
  GalleryReader/Models.swift GalleryReader/GalleryAPI.swift GalleryReader/GalleryStore.swift GalleryReader/BackgroundDownloads.swift GalleryReader/ViewPositions.swift \
  Tests/CoreTests.swift -o "$test_dir/tests"
"$test_dir/tests" "$@"
