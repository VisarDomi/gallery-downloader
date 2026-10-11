#!/usr/bin/env python3
"""Print this repo's paid app for its renewal scheduler (ios-tools renewal; runs on the Mac mirror)."""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--team', required=True)
parser.add_argument('--device', required=True)
args = parser.parse_args()
# The repository root (the app was configured from there; its inputs are all under apps/ios).
root = Path(__file__).resolve().parents[3]
print(json.dumps(dict(repo='gallery-downloader', apps=[dict(name='gallery', root=str(root),
                       app='apps/ios/build/Release-iphoneos/GalleryReader.app',
                       bundleIds=['com.visar.GalleryReader.paid'],
                       inputs=['apps/ios/GalleryReader', 'apps/ios/GalleryReader.xcodeproj', 'apps/ios/Kit',
                               'apps/ios/Resources', 'apps/ios/scripts/build.sh'],
                       build=['/bin/bash', 'apps/ios/scripts/build.sh'],
                       environment={'DEVELOPMENT_TEAM': args.team, 'GALLERY_BUNDLE_ID': 'com.visar.GalleryReader.paid',
                                    'SIGNING_DEVICE': args.device})])))
