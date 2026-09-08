#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/prepare-web.sh
if [[ "$(uname)" != Darwin ]]; then
  echo 'Build on the Mac with Xcode installed.' >&2
  exit 1
fi
if [[ ! -f Resources/LocalCA.cer ]]; then
  echo 'Missing PUBLIC LAN CA: see apps/ios/README.md.' >&2
  exit 1
fi
signing=(CODE_SIGNING_ALLOWED=NO)
if [[ -n "${DEVELOPMENT_TEAM:-}" ]]; then
  signing=(-allowProvisioningUpdates -allowProvisioningDeviceRegistration "DEVELOPMENT_TEAM=$DEVELOPMENT_TEAM")
fi
xcodebuild -project GalleryReader.xcodeproj -target GalleryReader -sdk iphoneos \
  -configuration Debug "SYMROOT=${IOS_BUILD_DIR:-$PWD/build}" "${signing[@]}" build
