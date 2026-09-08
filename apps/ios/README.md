# Gallery Reader for iPhone

The app automatically loads **all completed favorites** and downloads their images. It checks for new favorites on launch, reconnection, and every
30 seconds while foregrounded. Saved galleries are retained and reused; sync
never deletes them. Display order follows the PC favorites snapshot exactly
(within its Hitomi-then-IMHentai grouping); offline-only saved entries are retained
after current favorites. Download completion order never determines display order.
There is no separate import or download step. The existing offline PWA supplies
both library and reader views, with
25 galleries per library page. It is hosted in `WKWebView` with WebKit's own
back/forward navigation gestures and unrestricted viewport zoom. There are no
custom swipe, pinch, or double-tap recognizers.

The HTML, CSS, and UI JavaScript ship inside the app. A small message adapter
replaces browser storage RPCs with Swift actor calls. Original images and separate
source thumbnails live in Application Support, outside browser-managed storage.
Networking uses URLSession; JSON, filesystem work, and checkpoint commits run on
`GalleryStore`/`GalleryAPI` actors. WebKit handles image decoding/rendering in its
web content process. Only visible images are requested by the shared UI. Visible thumbnails can be
fetched immediately, ahead of bulk transfers, and duplicate requests share one
transfer. Eight gallery pipelines use a shared twelve-request budget. Each gallery
can begin originals as soon as its own previews finish.

Cold launch paints the bundled shell first, then reads the small `index.json`,
`catalog.json`, and `progress.json`. It does not decode the aggregate image catalog
or enumerate image files. Per-gallery manifests live in `manifests/`; visible
rows/readers load theirs first, and all remaining metadata warms one gallery at a
time with a yield between galleries. The previous aggregate is converted once,
without moving or redownloading media; the small index is committed only after
its referenced manifests are durable.

Visible thumbnail/reader requests take the next network slots ahead of queued
background work. If a requested image is already queued, its existing request is
promoted and shared. In-flight transfers finish, and queued background work
continues afterward. Opening an unsaved reader page fetches that page directly;
sparse original and thumbnail checkpoints survive restart. The shared UI prepares
visible rows first and fills the remaining rows in small background turns.
All library feedback and controls are below pagination.

Progress uses a separate small `progress.json`, flushed every 16 changes or 250 ms
during activity, plus on completion/cancellation/backgrounding. A process
interruption can leave a few committed files ahead of the checkpoint; resumed
transfers check those files and reuse them. Reading committed images creates no
transfer/progress events. UI updates carry changed gallery states.

## Build on macOS

Install Xcode, add an Apple account in **Xcode → Settings → Accounts**, and enable
Developer Mode on the attached iPhone.

1. At the repository root, run `bash apps/ios/scripts/prepare-web.sh` to bundle the
   current PWA UI. `build.sh` also does this automatically.
2. Provide the LAN server's **public** CA certificate in DER form:

   ```sh
   openssl x509 -in /path/to/public/rootCA.pem -outform DER \
     -out apps/ios/Resources/LocalCA.cer
   ```

   Do not copy private CA/server keys. The certificate is ignored by Git because
   it is specific to this installation. Only the configured server hostname can
   use this trust anchor, and TLS hostname/validity checks still apply.
3. `npm run build:ios:native` builds without signing. To install, use:

   ```sh
   DEVELOPMENT_TEAM=YOUR_TEAM_ID npm run build:ios:native
   xcrun devicectl device install app --device YOUR_DEVICE_ID \
     apps/ios/build/Debug-iphoneos/GalleryReader.app
   xcrun devicectl device process launch --device YOUR_DEVICE_ID com.visar.GalleryReader
   ```

   A GUI login session may be necessary for Xcode to access account credentials
   and signing keys. The existing web/PWA build and npm workspaces are unchanged.
   Xcode's target build is used directly so device compilation does not depend on
   downloading an iOS simulator runtime.

The PC URL is `GalleryServerURL` in `Resources/Info.plist`. Syncing and
downloading need the home LAN and iPhone Local Network permission. Reading already
saved images and opening the bundled app shell work without that network.

## First phone test

Allow Local Network access and keep the app foregrounded while it automatically
loads favorites and saves their images. Scroll to page 2, open a gallery, and use the normal WebKit back/forward
edge swipes and zoom. Turn off Wi-Fi/mobile data and reopen to test offline reads.

The app pauses downloads on backgrounding and automatically resumes
when brought back to the foreground. It has no background-transfer service, sync/deletion UI, or full
history restoration after process termination. WebKit owns in-session history
and back/forward scroll restoration. Personal Team signing must be renewed before
its profile expires; updating the same app bundle preserves downloaded files.

## Checks

`npm run test:ios:native` checks selection, unsafe/inconsistent manifest rejection,
empty-catalog handling, retained offline favorites, and atomic file replacement. On the home LAN, add `-- --integration` to exercise automatic favorites loading,
cancellation during previews, and automatic resume from persisted state. Small sample catalogs are supplied by the test source; production sync has no gallery-limit parameter. Integration files are temporary and removed afterward.

Tests also cover new-gallery sync without image redownloads, shared concurrent
thumbnail requests, out-of-order preview recovery, compact checkpoints, and
stopping a batch when the server is unavailable.

`npm run test:offline` verifies the existing PWA storage flows.

`Tests/TransferBenchmark.swift` measures 1/4/8/12 concurrent transfers using a
saved native library JSON. On the wired development laptop, 256 thumbnails rose
from 2.58 MB/s at one transfer to 8.57 MB/s at twelve; 64 originals rose from
28.59 MB/s to 73.05 MB/s. These are LAN measurements on that machine, not a claim
about the iPhone's Wi-Fi ceiling. A subsequent on-phone checkpoint measurement
saved 3.83 GB in 83 seconds (46.13 MB/s), including 12,436 originals and 12,908
source thumbnails. This is observed throughput, not a guaranteed network maximum.

Apple reference: [WKWebView navigation gestures](https://developer.apple.com/documentation/webkit/wkwebview/allowsbackforwardnavigationgestures).

`Tests/StartupBenchmark.swift` measures aggregate decoding/validation, the small
launch index, visible-gallery loading, and complete background warm-up. It accepts
a saved aggregate JSON and an optional catalog JSON. `startup.json` in the app's
Application Support directory records native index-load timing and WebKit's first
image timing for on-device cold-start verification.
