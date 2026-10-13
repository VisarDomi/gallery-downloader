# Gallery Reader for iPhone

A native UIKit app on NativeKit (`Kit/`, vendored from ios-tools; see the
[NativeKit guide](../../../../ios-tools/native/README.md)). It loads **all completed
favorites** from the PC pipeline ([PIPELINE.md](../../PIPELINE.md)), saves their originals
and source thumbnails on the phone, keeps downloading while the app is away, and reads
fully offline.

Installed as bundle ID `com.visar.GalleryReader.paid`, team `65U58U86DD`, display name
**Gallery Reader**, no custom icons, no push entitlements or background modes. The PC
address is `GalleryServerURL` in `Resources/Info.plist` (`https://192.168.1.197:7777`).

## What it does

The owner relies on all of this.

- **Library**: every favorite in one continuous list (no page numbers: the owner's standing
  default), each a row with a sideways strip of every page's thumbnail (100×300 covers) and
  an "i" button for the gallery's details (titles, Japanese first; artists, groups, type,
  language, pages, source, what is saved, tags). At the end: the favorites count and the
  store's status line. Drag the scroll indicator to jump through the list. No pinch zoom on
  the list.
- **Reader**: the pages full width with no gaps on black, half a screen above the first and
  below the last, pinch-zoomed and panned like a Safari page (double tap zooms in or out).
  Opened from a thumbnail, that page's top sits at the screen's middle. Page heights come
  from the manifest's sizes before the images load (2:3 until known), so resuming never
  jumps. "n/total pages saved" shows until the gallery is complete.
- **Navigation**: screens stay alive under the reader, so going back is instant and exact.
  The left edge goes back, the right edge goes forward to the screen last left; a zoomed page
  pans to the left edge instead. The whole stack is saved and rebuilt after a relaunch.
- **Positions**: the library remembers the row at the screen's middle, how far down that
  row, and every strip's sideways offset; each gallery remembers its page and how far down
  it. Opening a page from a thumbnail wins over the saved reader position (that is used only
  when the tapped page is the one the reader was left on).
- **Images** decode at display size off the main thread, on-screen first, then nearest
  (both axes), with a bounded memory cache (256 MB). A thumbnail or page not saved yet
  downloads at once, ahead of the background work.
- **Sync**: no import or download step, and no sync/deletion UI. The app checks for new
  favorites on launch, on network return, and every 30 seconds while foregrounded. Saved
  galleries are kept and reused; sync never deletes them, and an empty PC catalog keeps
  them too. Display order follows the PC favorites snapshot exactly (within its
  Hitomi-then-IMHentai grouping); offline-only saved entries follow the current favorites.
  Download completion order never decides display order.
- **Offline**: syncing and downloading need the home LAN and the Local Network permission.
  Reading saved images works without any network.
- **Away from the screen**: downloads continue while the app is locked, in the background,
  or closed by iOS (a force-quit from the app switcher stops them). Control Center or Face ID
  leave downloads and the catalog untouched; only a real trip to the background stops the
  app's own downloads and refreshes the catalog on return. A changed catalog keeps the
  current position (the row at the screen's middle stays put).
- Not in the app, on purpose: search, saved searches, import/export, a favorite-edit heart.
- Known limit: animated GIF pages show only their first frame.

## Rules

The shared rules are in the NativeKit guide; here is how this app keeps them.

- **Relaunch to the exact screen, first frame included.** Before the first frame the
  screens read the saved catalog (`catalogNow`), each gallery's manifest (`manifestNow`)
  and the thumbnails and pages already on the phone (`savedFile`), while the store opens in
  the background. `ImagePipeline.beginRestore` decodes on-screen local images at once; the
  library goes straight to its anchor; the reader lays out from the manifest with its
  saved-pages count; the screens below the top are built after it shows. Check every
  change with `restore-check` (below).
- **An unopened store is not news.** Until the store has answered once (`libraryLoaded` in
  `AppController`), its empty library must not replace the saved catalog on screen.
- **The main thread only shows.** Manifests are read from disk on the main thread only while
  relaunching (`pipeline.isRestoring`); otherwise rows and thumbnails ask the store in the
  background. A newer catalog waits while a finger or momentum moves the list (setting the
  offset would stop a fling). Keep new main-thread work inside a `FrameMonitor` span; the
  goal is no frame over 25 ms while anything scrolls.
- **Nothing on disk is lost or half-written.** All file I/O, JSON and checkpoints run on the
  `GalleryStore` actor. Files are committed atomically at their exact expected size;
  `index.json` is written only after the manifests it names are durable. Keep the file
  formats and route paths below: the phone's saved data and positions use them.
- **Only the PC may be trusted with the bundled CA** (`LocalTrust`): the configured host only,
  TLS hostname and validity still checked, no accept-all handler.
- **Never uninstall the app to update it**: install over the same bundle ID, which keeps the
  downloaded library and positions.
- **Never leave a renewal input changed without deploying it**, not even a comment
  (see Renewal).

## Code map

| Path | What it owns |
|---|---|
| `GalleryReader/AppDelegate.swift` | App and scene delegates; one `AppController`, also created when iOS relaunches the app in the background to deliver finished transfers |
| `GalleryReader/AppController.swift` | The store and its automatic work (sync, downloads, metadata warm-up, 30 s poll, network monitor), the shared image pipeline, positions, the navigation stack, leaving and returning to the screen, the simulator's `-downloads` switch, debug-state reporters |
| `GalleryReader/LibraryScreen.swift` | The list, `GalleryRowCell` (title or strip, "i" button), anchor and strip offsets, catalog updates in place |
| `GalleryReader/ReaderScreen.swift` | The reader on `StripReaderView`, its saved place, the pages-saved message, edge back off while zoomed |
| `GalleryReader/InfoSheet.swift` | A favorite's details |
| `GalleryReader/GalleryStore.swift` | Actor: files on the phone, catalog sync, downloads, checkpoints, warm-up, the background hand-off list, the first-frame reads |
| `GalleryReader/GalleryAPI.swift` | `LocalTrust`, `TransferGate` (12 slots, interactive first), `GalleryAPI` (the PC's `/offline-api`, image type and exact size checks) |
| `GalleryReader/BackgroundDownloads.swift` | The background URLSession (`<bundle ID>.pages`) |
| `GalleryReader/Models.swift` | Catalog and manifest types with validation, display order (`CatalogSelection`), launch index, positions, `Route` |
| `Kit/` | Vendored NativeKit. Do not edit here: change the canonical copy and vendor it (NativeKit guide) |
| `Resources/` | `Info.plist`; `LocalCA.cer` (gitignored, see Build) |
| `Tests/` | `CoreTests.swift` (`scripts/test.sh`), `StartupBenchmark.swift`, `TransferBenchmark.swift` |
| `scripts/` | `build.sh`, `test.sh`, `renewal.py` |

## Store, sync and downloads

Data lives in `Library/Application Support/GalleryReader/` (excluded from backup):

| File | Contents |
|---|---|
| `catalog.json` | The favorites in display order |
| `index.json` | One small record per gallery (the launch index); no image records |
| `manifests/<key>.json` | A gallery's pages and thumbnails (names, sizes, offsets, image sizes, revisions) |
| `progress.json` | Saved counts per gallery, plus pages saved out of order |
| `<key>/<revision>/pages/`, `<key>/<revision>/thumbnails/` | The images |
| `view-state.json` | Positions, keyed `library:1` and `reader:<key>`; routes are `/` and `/?read=<key>&page=N` |
| `navigation.json` | The screen stack (back and forward) with each screen's state |
| `startup.json` | Launch timings (`store_load_ms`, `native_ui_ready_ms`) |
| `debug-state.json` | Navigation, library, screens, image pipeline and frame report; written whenever the app resigns active |

Cold launch reads only `index.json`, `catalog.json` and `progress.json`; it does not
decode image records or list image files. Visible rows and readers load their manifests
first; all remaining metadata warms one gallery at a time, yielding to visible requests.

Networking uses URLSession with a shared budget of twelve requests. Eight gallery pipelines
run at once; each saves its previews (source thumbnails) first and can start its originals
as soon as its own previews finish. Visible thumbnails and reader pages take the next free
slot ahead of queued background work; a request already queued is promoted, and duplicate
requests share one transfer. A cancelled queued request leaves the queue at once. A gallery
whose thumbnails are on screen downloads first. A batch stops when the PC is unreachable
or the disk is full, and starts again with the next automatic check.

A file is committed only at its exact expected size, by atomic rename, so partial images
never replace complete ones. Progress is flushed every 16 changes or 250 ms during activity,
and on completion, cancellation and backgrounding. An interruption can leave a few
committed files ahead of the checkpoint; resumed transfers find and reuse them. Reading a
saved image creates no transfer or progress events.

When the app resigns active, `BackgroundDownloads` hands the unfinished files (priority
galleries first, previews before originals, up to 2000) to a background URLSession, which
commits each one exactly as the store does. It must happen while the app is still active:
iOS defers transfers started from the background. Back on screen the remaining transfers
are cancelled and the app's own downloads carry on, counting the committed files as saved.
Background URLSessions need no background mode or entitlement.

One-time readers still in the code: `GalleryStore.load` converts the old aggregate
`library.json` into `index.json` and `manifests/` (no media moved or redownloaded), and
`AppController` builds `navigation.json` from `view-state.json` when it is missing (the
library place saved on any old library page carries over). Removing them is an open item
in the NativeKit guide.

## Build, deploy, test, inspect

Everything Apple runs on the Mac. Start with [Mac access](../../../../../environment/mac-access.md)
(`ssh mac`, the phone's UDID `00008101-000639912881401E`, signing). The Mac mirror is
`/Users/visar/Developer/gallery-downloader/apps/ios`. `scripts/build.sh` and
`scripts/test.sh` stop on Linux, so `npm run build:ios:native` and `test:ios:native` only
work on a Mac.

**The PC's CA certificate.** The app bundles the PC's **public** mkcert root CA in DER
form as `Resources/LocalCA.cer` (gitignored; the build stops without it). The mirror keeps
its own copy. To make one:

```sh
openssl x509 -in ~/.local/share/mkcert/rootCA.pem -outform DER -out apps/ios/Resources/LocalCA.cer
```

Never copy the private CA or server keys. Only the configured server host can use this
trust anchor.

### Deploy to the phone

From this PC (the owner tests on the phone as soon as a build appears, so deploy each
change):

```sh
apps/ios/scripts/deploy.sh          # all three steps; or: sync | build | install
```

- `sync`: rsync `apps/ios` to the Mac mirror (`--delete`; `build/` and the mirror's own
  `LocalCA.cer` are left alone).
- `build`: on the Mac, in the GUI session (Keychain access), `scripts/build.sh` with
  `SIGNING_DEVICE` (the profile then includes the phone), recorded for renewal before and
  after (`deliver.py begin`/`built`). Output: `build/Release-iphoneos/GalleryReader.app`;
  the log is `/tmp/gallery-reader-build.log` on the Mac.
- `install`: checks the signature, bundle ID, team, the phone in the profile and more than
  45 days of validity, installs over the existing app (its data kept) and approves it as
  the renewal baseline (`deliver.py installed`; skipped, with the reason printed, if the
  inputs or the app changed since the build).

The remote part runs through `bash -s`: the Mac's login shell is zsh, which does not split
words in unquoted variables.

On the phone after a change: allow Local Network access; the library loads by itself; open
a gallery from a thumbnail, zoom, swipe back from the left edge and forward from the right;
kill and relaunch (same screen, same place); lock the phone and check downloads continued;
turn off Wi-Fi and mobile data and read saved galleries.

### Simulator

The simulator build is unsigned and uses the project's default bundle ID
`com.visar.GalleryReader`. It syncs from the real PC (the simulator trusts its CA) but saves
only what is viewed unless launched with `-downloads` (the whole library would fill the
Mac's disk). Its NativeKit test hooks answer on port 8765. Boot the simulator for one batch
of checks and shut it down afterwards.

```sh
ssh mac 'SIMULATOR=1 /bin/bash ~/Developer/gallery-downloader/apps/ios/scripts/build.sh'
S=/home/visar/Documents/work/ios-tools/native/scripts
$S/sim install /Users/visar/Developer/gallery-downloader/apps/ios/build/Release-iphonesimulator/GalleryReader.app
$S/sim launch com.visar.GalleryReader            # add -downloads to save everything
$S/sim hook /state                               # also /tap, /scroll, /back, /forward, /zoom, /layout
$S/sim shot /tmp/gallery.png
$S/restore-check com.visar.GalleryReader         # relaunch exactness; --warm for background and back
ssh mac 'xcrun simctl shutdown all'
```

### Tests

On the Mac: `bash ~/Developer/gallery-downloader/apps/ios/scripts/test.sh` (what
`npm run test:ios:native` runs). It covers selection, unsafe or inconsistent manifest
rejection, empty catalogs, retained offline favorites, partial-file rejection, atomic
replacement, queue cancellation and priority, stopping a batch when the server is
unavailable, the small launch index with visible-first loading and full warm-up,
persistent positions and safe restoration routes. On the home LAN, add `--integration`
for automatic favorites loading, cancellation during previews, resume from persisted state,
new-gallery sync without image redownloads, shared concurrent thumbnail requests,
out-of-order preview recovery and compact checkpoints. Small sample catalogs come from the test source; the app's
sync has no gallery limit. Integration files are temporary and removed afterwards.

`Tests/StartupBenchmark.swift` (a saved aggregate `library.json`, optionally a catalog
JSON) measures decoding, the launch index, visible-gallery loading and complete warm-up.
`Tests/TransferBenchmark.swift` (a saved aggregate) measures 1, 4, 8 and 12 concurrent
transfers from the PC. Build either like `scripts/test.sh` does, with it in place of
`CoreTests.swift`. On the wired LAN throughput kept rising up to twelve transfers
(thumbnails 2.6 to 8.6 MB/s, originals 28.6 to 73 MB/s); the phone once saved 3.8 GB in
83 s (46 MB/s).

### Inspect the phone

Use the app, leave it (that writes `debug-state.json`), then from this PC:

```sh
/home/visar/Documents/work/ios-tools/native/scripts/frames com.visar.GalleryReader.paid \
  'Library/Application Support/GalleryReader'          # frame report; --json for the whole file
```

This app's spans are `library.cell`, plus NativeKit's `images.deliver`, `strip.*` and
`navigation.save`. Other files come the same way, on the Mac:

```sh
xcrun devicectl device copy from --device 00008101-000639912881401E --domain-type appDataContainer \
  --domain-identifier com.visar.GalleryReader.paid \
  --source 'Library/Application Support/GalleryReader/startup.json' --destination /tmp/startup.json
```

## Renewal

Gallery Reader renews monthly through this repository's own Mac scheduler,
`com.visar.renewal.gallery-downloader`, which runs the shared
[ios-tools renewal](../../../../ios-tools/renewal/README.md) runner. `scripts/renewal.py`
lists the app (`gallery`, `com.visar.GalleryReader.paid`, the builder `scripts/build.sh`)
and its inputs: `GalleryReader/`, `GalleryReader.xcodeproj`, `Kit/`, `Resources/` and
`scripts/build.sh`. A changed input blocks the unattended renewal until the app is deployed
and approved (the `deliver.py` steps above). Docs, tests and the other scripts are not
inputs.

On the Mac, after `renewal.py` changes, register again; check the state any time:

```sh
/usr/bin/python3 ~/Developer/ios-tools/renewal/scripts/configure-refresh.py ~/Developer/gallery-downloader/apps/ios
/usr/bin/python3 ~/Developer/ios-tools/renewal/scripts/refresh-installed.py status --repo gallery-downloader
```

The recovery copy of the renewal setup is
[mac-renewal/RECOVERY.md](../../../../../environment/mac-renewal/RECOVERY.md).

## Gotchas

- A build without `GALLERY_BUNDLE_ID` is `com.visar.GalleryReader`, a different app from the
  installed `.paid` one. Only the simulator uses it.
- `Kit/` is a renewal input. Vendoring a new NativeKit means deploying this app again; never
  edit `Kit/` here by hand (change ios-tools' `native/Kit` and vendor it).
- `debug-state.json` is written only when the app resigns active, so the report is as old as
  the last time the app left the screen.
- `devicectl` says the phone is unavailable although it answers on the LAN: see Mac access
  (Tailscale on the phone, the Mac's pairing services).
- Simulator: one app at a time (port 8765), and `-downloads` only when the Mac has the space.
