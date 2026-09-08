#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname)" != Darwin ]]; then
  echo 'Native core tests require the macOS Swift toolchain.' >&2
  exit 1
fi
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/gallery-native-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
xcrun swiftc -parse-as-library -strict-concurrency=complete \
  GalleryReader/Models.swift GalleryReader/GalleryAPI.swift GalleryReader/GalleryStore.swift \
  Tests/CoreTests.swift -o "$test_dir/tests"
"$test_dir/tests" "$@"
