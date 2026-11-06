#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname)" != Darwin ]]; then
  echo 'Native core tests require the macOS Swift toolchain.' >&2
  exit 1
fi
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/gallery-native-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
for module in KitCore KitNet KitLifecycle; do
  deps=()
  [[ $module == KitNet ]] && deps=(-I "$test_dir" -L "$test_dir" -lKitCore)
  [[ $module == KitLifecycle ]] && deps=(-I "$test_dir" -L "$test_dir" -lKitCore -lKitNet)
  xcrun swiftc -j 2 -parse-as-library -emit-library -emit-module -module-name "$module" Kit/Sources/"$module"/*.swift ${deps[@]+"${deps[@]}"} \
    -emit-module-path "$test_dir/$module.swiftmodule" -o "$test_dir/lib$module.dylib" -Xlinker -install_name -Xlinker @rpath/lib$module.dylib
done
xcrun swiftc -j 2 -swift-version 6 -parse-as-library -strict-concurrency=complete -I "$test_dir" -L "$test_dir" -lKitCore -lKitNet -lKitLifecycle -Xlinker -rpath -Xlinker "$test_dir" \
  GalleryReader/Models.swift GalleryReader/GalleryAPI.swift GalleryReader/GalleryStore.swift GalleryReader/BackgroundDownloads.swift \
  Tests/CoreTests.swift -o "$test_dir/tests"
"$test_dir/tests" "$@"
