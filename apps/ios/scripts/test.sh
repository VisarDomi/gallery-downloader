#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname)" != Darwin ]]; then
  echo 'Native core tests require the macOS Swift toolchain.' >&2
  exit 1
fi
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/gallery-native-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
# KitCore is its own module, as in the app.
xcrun swiftc -parse-as-library -emit-library -emit-module -module-name KitCore Kit/Sources/KitCore/*.swift \
  -emit-module-path "$test_dir/KitCore.swiftmodule" -o "$test_dir/libKitCore.dylib" -Xlinker -install_name -Xlinker @rpath/libKitCore.dylib
xcrun swiftc -parse-as-library -strict-concurrency=complete -I "$test_dir" -L "$test_dir" -lKitCore -Xlinker -rpath -Xlinker "$test_dir" \
  GalleryReader/Models.swift GalleryReader/GalleryAPI.swift GalleryReader/GalleryStore.swift GalleryReader/BackgroundDownloads.swift \
  Tests/CoreTests.swift -o "$test_dir/tests"
"$test_dir/tests" "$@"
