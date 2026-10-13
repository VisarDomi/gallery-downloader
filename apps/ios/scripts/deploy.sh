#!/bin/bash
# Gallery Reader to the phone, from this PC: sync the sources to the Mac mirror, build signed
# in the Mac's GUI session, verify, install over the existing app (data kept) and approve the
# build as its renewal baseline.
#   apps/ios/scripts/deploy.sh [sync|build|install|all]    (default: all)
# The remote part runs through `bash -s`: the Mac's login shell is zsh, which does not split
# words in unquoted variables.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR=/Users/visar/Developer/gallery-downloader/apps/ios
PHONE=00008101-000639912881401E
action="${1:-all}"

sync() {
  # build/ and the mirror's own LocalCA.cer (gitignored) stay as they are.
  rsync -az --delete --exclude=build/ --exclude=.build/ --exclude=.swiftpm/ --exclude=__pycache__/ \
    --exclude=Resources/LocalCA.cer --exclude=project.xcworkspace/ "$IOS/" "mac:$MIRROR/"
}

remote() {
  ssh -o BatchMode=yes mac 'bash -s' <<REMOTE
set -euo pipefail
DELIVER="/usr/bin/python3 /Users/visar/Developer/ios-tools/renewal/scripts/deliver.py"
APPARGS="--repo gallery-downloader --app gallery --bundle com.visar.GalleryReader.paid"
APP=$MIRROR/build/Release-iphoneos/GalleryReader.app
$1
REMOTE
}

build() {
  remote '
$DELIVER begin $APPARGS
sudo -n launchctl asuser 501 sudo -n -H -u visar /usr/bin/env DEVELOPMENT_TEAM=65U58U86DD \
  GALLERY_BUNDLE_ID=com.visar.GalleryReader.paid SIGNING_DEVICE='"$PHONE"' \
  /bin/bash '"$MIRROR"'/scripts/build.sh > /tmp/gallery-reader-build.log 2>&1 \
  || { tail -20 /tmp/gallery-reader-build.log; exit 1; }
$DELIVER built $APPARGS
echo "Built $APP"'
}

install() {
  remote '
codesign --verify --deep --strict "$APP"
test "$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP/Info.plist")" = com.visar.GalleryReader.paid
security cms -D -i "$APP/embedded.mobileprovision" > /tmp/gallery-reader-profile.plist
/usr/bin/python3 -c "
import plistlib, datetime
p = plistlib.load(open(\"/tmp/gallery-reader-profile.plist\", \"rb\"))
assert p[\"TeamIdentifier\"] == [\"65U58U86DD\"], p[\"TeamIdentifier\"]
assert \"'"$PHONE"'\" in p[\"ProvisionedDevices\"], \"phone not in the profile\"
assert p[\"ExpirationDate\"] > datetime.datetime.utcnow() + datetime.timedelta(days=45), p[\"ExpirationDate\"]
print(\"Verified team, phone and expiry:\", p[\"ExpirationDate\"])"
xcrun devicectl device install app --device '"$PHONE"' "$APP" | grep -E "bundleID|installed" | head -2
$DELIVER installed $APPARGS'
}

case "$action" in
  sync) sync ;;
  build) build ;;
  install) install ;;
  all) sync; build; install ;;
  *) echo "usage: $0 [sync|build|install|all]" >&2; exit 2 ;;
esac
