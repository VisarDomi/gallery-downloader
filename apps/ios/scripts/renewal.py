#!/usr/bin/env python3
"""Print this repo's paid app for ios-app-renewal's configure-refresh.py (runs on the Mac mirror)."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--team', required=True)
parser.add_argument('--device', required=True)
args = parser.parse_args()
# The app also bundles the downloader's offline UI, so its root is the repository, not apps/ios.
root = Path(__file__).resolve().parents[3]
print(json.dumps([dict(name='gallery', root=str(root),
                       app='apps/ios/build/Debug-iphoneos/GalleryReader.app',
                       bundleIds=['com.visar.GalleryReader.paid'],
                       inputs=['apps/ios/GalleryReader', 'apps/ios/GalleryReader.xcodeproj',
                               'apps/ios/Resources', 'apps/ios/scripts/build.sh', 'apps/ios/scripts/prepare-web.sh',
                               'gallery-server/downloader/public/offline'],
                       build=['/bin/bash', 'apps/ios/scripts/build.sh'],
                       environment={'DEVELOPMENT_TEAM': args.team, 'GALLERY_BUNDLE_ID': 'com.visar.GalleryReader.paid',
                                    'SIGNING_DEVICE': args.device})]))
