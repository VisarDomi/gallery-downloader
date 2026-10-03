# Gallery Reader: paid native installation

Gallery Reader is installed with team `65U58U86DD` and bundle ID
`com.visar.GalleryReader.paid`, display name **Gallery Reader**, no custom icons.
Its library comes from the PC favorites pipeline.

Start with [shared Mac access](/home/visar/Documents/environment/mac-access.md).
Ethernet address: `192.168.1.198`, user `visar`. The Mac mirror is
`/Users/visar/Developer/gallery-downloader` (this repository's `apps/ios` and
`gallery-server/downloader/public/offline`).

## Build and install

Sync `apps/ios` (without `build/` and the generated `Resources/Web/`) and
`gallery-server/downloader/public/offline` to the mirror, then build attached in
the Mac GUI session for Keychain access:

```sh
sudo -n launchctl asuser 501 sudo -n -H -u visar /usr/bin/env \
  DEVELOPMENT_TEAM=65U58U86DD GALLERY_BUNDLE_ID=com.visar.GalleryReader.paid \
  SIGNING_DEVICE=00008101-000639912881401E \
  /bin/bash /Users/visar/Developer/gallery-downloader/apps/ios/scripts/build.sh
```

The physical `GalleryReader` scheme is used when SIGNING_DEVICE is supplied, so the
profile includes the phone. Do not install an app solely because Xcode says build
succeeded: verify the full code signature, team, bundle ID, phone inclusion, expiry
and bundled Web file hashes first. Output:
`apps/ios/build/Debug-iphoneos/GalleryReader.app`; install it with `devicectl
device install app --device <UDID> <app>`, which keeps the app's data. There are
no push entitlements or background modes.

## Renewal and recovery

Gallery renews monthly with its paid identity through this repository's
scheduler, `com.visar.renewal.gallery-downloader` ([REFRESH.md](REFRESH.md)). See
the [environment recovery copy](/home/visar/Documents/environment/mac-renewal/RECOVERY.md).

## Offline UI

The app bundles `gallery-server/downloader/public/offline` (`app.js`, `style.css`,
`index.html`) through `scripts/prepare-web.sh`. Home requests every thumbnail on
the current page and the reader every image as soon as its DOM exists; WebKit owns
decoding. The scroll-settle and image-retry helpers in `app.js` mirror gallery-reader's
`src/core/{scroll-settle,image-retry}.ts`. All images and image links disable
callouts, selection and dragging.
