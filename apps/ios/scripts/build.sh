#!/bin/bash
# Builds Gallery Reader on the Mac: Release for the phone (signed when DEVELOPMENT_TEAM is
# set), or `SIMULATOR=1` for the simulator (unsigned). Output: build/Release-iphoneos or
# build/Release-iphonesimulator.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname)" != Darwin ]]; then
  echo 'Build on the Mac with Xcode installed.' >&2
  exit 1
fi
if [[ ! -f Resources/LocalCA.cer ]]; then
  echo 'Missing PUBLIC LAN CA: see apps/ios/README.md.' >&2
  exit 1
fi
if [[ -n "${SIMULATOR:-}" ]]; then
  xcodebuild -project GalleryReader.xcodeproj -scheme GalleryReader -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' -configuration Release \
    "SYMROOT=${IOS_BUILD_DIR:-$PWD/build}" -derivedDataPath "${DERIVED_DATA:-$PWD/build/DerivedData}" CODE_SIGNING_ALLOWED=NO build
  exit
fi
signing=(CODE_SIGNING_ALLOWED=NO)
if [[ -n "${DEVELOPMENT_TEAM:-}" ]]; then
  signing=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM")
fi
if [[ -n "${GALLERY_BUNDLE_ID:-}" ]]; then
  signing+=("PRODUCT_BUNDLE_IDENTIFIER=$GALLERY_BUNDLE_ID")
fi
destination=(-destination 'generic/platform=iOS')
if [[ -n "${SIGNING_DEVICE:-}" ]]; then
  destination=(-destination "platform=iOS,id=$SIGNING_DEVICE" -destination-timeout 30)
fi
xcodebuild -project GalleryReader.xcodeproj -scheme GalleryReader -sdk iphoneos "${destination[@]}" \
  -configuration Release "SYMROOT=${IOS_BUILD_DIR:-$PWD/build}" -derivedDataPath "${DERIVED_DATA:-$PWD/build/DerivedData}" \
  "${signing[@]}" build
