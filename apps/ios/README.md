# Gallery Reader for iPhone

The app automatically loads **all completed favorites** and downloads their images. It checks for new favorites on launch, reconnection, and every
30 seconds while foregrounded. Saved galleries are retained and reused; sync
never deletes them. Display order follows the PC favorites snapshot exactly
(within its Hitomi-then-IMHentai grouping); offline-only saved entries are retained
after current favorites. Download completion order never determines display order.
There is no separate import or download step.

The app is native UIKit (no WebKit), built on NativeKit (`apps/ios/Kit`, vendored from
ios-tools `native/Kit`; see its PLAN.md):

- **Library**: every favorite in one continuous list (the web version's 25-row pages only
  kept WebKit's documents small), each a row with a sideways strip of every page's thumbnail
  (100×300 covers) and an "i" button for the gallery's details; at the end the favorites
  count and the status line. Drag the scroll indicator to jump through the list.
- **Reader**: the pages full width with no gaps on black, half a screen above the first and
  below the last, pinch-zoomed and panned like a Safari page (double tap zooms in or out).
  Opened from a thumbnail, that page's top sits at the screen's middle.
- **Navigation**: screens stay alive under the reader, so going back is instant and exact.
  The left edge goes back, the right edge goes forward to the screen last left; a zoomed page
  pans to the left edge instead. The whole stack is saved (`navigation.json`) and rebuilt
  after a relaunch.
- **Positions**: the library remembers the row at the screen's middle, how far down that
  row, and every strip's sideways offset (the first native launch carries over the place
  saved on the web version's last page); each gallery remembers its page and how far
  down it (`view-state.json`, the same file and format as before). Opening a different page
  from a thumbnail wins over a saved reader position.
- **Images** decode at display size off the main thread, the ones nearest the screen first
  (both axes), with a bounded memory cache; every image on a page loads as it comes near.

Original images and separate source thumbnails live in Application Support. Networking
uses URLSession; JSON, filesystem work, and checkpoint commits run on the
`GalleryStore`/`GalleryAPI` actors. Visible thumbnails and reader pages are fetched
immediately, ahead of bulk transfers, and duplicate requests share one transfer. Eight
gallery pipelines use a shared twelve-request budget. Each gallery can begin originals as
soon as its own previews finish.

Cold launch reads the small `index.json`, `catalog.json`, and `progress.json`. It does not
decode the aggregate image catalog or enumerate image files. Per-gallery manifests live in
`manifests/`; visible rows and readers load theirs first, and all remaining metadata warms
one gallery at a time with a yield between galleries. The previous aggregate is converted
once, without moving or redownloading media; the small index is committed only after its
referenced manifests are durable.

Visible thumbnail/reader requests take the next network slots ahead of queued
background work. If a requested image is already queued, its existing request is
promoted and shared. In-flight transfers finish, and queued background work
continues afterward. Opening an unsaved reader page fetches that page directly;
sparse original and thumbnail checkpoints survive restart.

Progress uses a separate small `progress.json`, flushed every 16 changes or 250 ms
during activity, plus on completion/cancellation/backgrounding. A process
interruption can leave a few committed files ahead of the checkpoint; resumed
transfers check those files and reuse them. Reading committed images creates no
transfer/progress events.

## Build on macOS

Install Xcode 26, add an Apple account in **Xcode → Settings → Accounts**, and enable
Developer Mode on the attached iPhone.

1. Provide the LAN server's **public** CA certificate in DER form:

   ```sh
   openssl x509 -in /path/to/public/rootCA.pem -outform DER \
     -out apps/ios/Resources/LocalCA.cer
   ```

   Do not copy private CA/server keys. The certificate is ignored by Git because
   it is specific to this installation. Only the configured server hostname can
   use this trust anchor, and TLS hostname/validity checks still apply.
2. `npm run build:ios:native` builds Release without signing. To install, use:

   ```sh
   DEVELOPMENT_TEAM=YOUR_TEAM_ID npm run build:ios:native
   xcrun devicectl device install app --device YOUR_DEVICE_ID \
     apps/ios/build/Release-iphoneos/GalleryReader.app
   xcrun devicectl device process launch --device YOUR_DEVICE_ID com.visar.GalleryReader
   ```

   A GUI login session may be necessary for Xcode to access account credentials
   and signing keys.
3. `SIMULATOR=1 bash apps/ios/scripts/build.sh` builds for the simulator
   (`build/Release-iphonesimulator`). A simulator build saves only what is viewed unless
   launched with `-downloads` (the whole library would fill the Mac's disk), and answers
   ios-tools' `native/scripts/sim hook` requests (KitTestHooks: state, taps, scrolls, back,
   forward, zoom) for testing from the Mac.

The PC URL is `GalleryServerURL` in `Resources/Info.plist`. Syncing and
downloading need the home LAN and iPhone Local Network permission. Reading already
saved images works without that network.

## First phone test

Allow Local Network access and keep the app foregrounded while it automatically
loads favorites and saves their images. Scroll to page 2, open a gallery, zoom, swipe back
from the left edge and forward from the right edge. Turn off Wi-Fi/mobile data and reopen
to test offline reads.

Downloads continue while the app is away (locked, in the background, or closed by iOS);
see "Away from the screen" in [PAID-NATIVE.md](PAID-NATIVE.md). There is no sync/deletion
UI. Updating the same app bundle preserves downloaded files. See
[daily wireless renewal](REFRESH.md) for the Mac LaunchAgent, private configuration
template, initial wireless verification, and retry policy.

## Checks

`npm run test:ios:native` checks selection, unsafe/inconsistent manifest rejection,
empty-catalog handling, retained offline favorites, atomic file replacement, persistent
positions and safe restoration routes. On the home LAN, add `-- --integration` to exercise
automatic favorites loading, cancellation during previews, and automatic resume from
persisted state. Small sample catalogs are supplied by the test source; production sync has
no gallery-limit parameter. Integration files are temporary and removed afterward.

Tests also cover new-gallery sync without image redownloads, shared concurrent
thumbnail requests, out-of-order preview recovery, compact checkpoints, and
stopping a batch when the server is unavailable.

`Tests/TransferBenchmark.swift` measures 1/4/8/12 concurrent transfers using a
saved native library JSON. On the wired development laptop, 256 thumbnails rose
from 2.58 MB/s at one transfer to 8.57 MB/s at twelve; 64 originals rose from
28.59 MB/s to 73.05 MB/s. These are LAN measurements on that machine, not a claim
about the iPhone's Wi-Fi ceiling. A subsequent on-phone checkpoint measurement
saved 3.83 GB in 83 seconds (46.13 MB/s), including 12,436 originals and 12,908
source thumbnails. This is observed throughput, not a guaranteed network maximum.

`Tests/StartupBenchmark.swift` measures aggregate decoding/validation, the small
launch index, visible-gallery loading, and complete background warm-up. It accepts
a saved aggregate JSON and an optional catalog JSON. `startup.json` in the app's
Application Support directory records native index-load timing and the time until the
first screen is ready. `debug-state.json` (written whenever the app leaves the screen)
holds the navigation stack, reader position and image queue for on-device checks.
