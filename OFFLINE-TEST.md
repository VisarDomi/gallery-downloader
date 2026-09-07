# Offline Gallery Reader

App: **https://192.168.1.197:7777/**. PC queue: **/downloader**.

The 7 GB iPhone proof of concept opened quickly on iOS 27 beta 8. The app now
uses gallery-reader's 25-gallery pagination, 100 × 300 source-thumbnail strips,
gallery information dialog, and full-width continuous reader. No search,
saved searches, import/export, hearts, reader toolbar, or custom Back button.

## Update without losing the existing downloads

1. Open the existing app online. The service worker installs the new shell.
2. If an update is waiting, close all windows of that app/browser and reopen.
   Do **not** uninstall the PWA, clear website data, or reset storage.
3. Press **Resume downloads**. The first pass saves source thumbnails for the
   library; the second continues missing originals. Old completed pages are
   not fetched again. Stop preserves committed progress in either pass.

Safari and the installed Home Screen app may have separate storage. Download
inside whichever one you use. The Safari debugger cannot control the installed
PWA. Neither promises native background downloads: keep it foregrounded.

## Behavior

- The list paints before storage work. Only small catalog/checkpoint records
  are read at initialization; only the selected 25 galleries get detailed rows.
- Visible thumbnails come from saved preview packs when available. Before
  downloading, they can be previewed from the PC over the LAN. Previews fetched
  for display are not silently counted as saved. No full-image thumbnail fallback.
- **Download all / Stop / Resume downloads** is the only acquisition control.
  It saves thumbnails first, then originals, respecting independent checkpoints.
- Clicking a thumbnail navigates to `/?read=<provider>-<id>&page=<1-based page>`.
  The reader consumes saved original bytes only. Missing pages are reported,
  never silently fetched. The current page is recorded in the URL on scrolling.
- Page links use `/?p=N`. List → reader → Back is real document navigation.
  On bfcache restoration, the existing rows and horizontal/vertical scroll
  positions remain intact. No synthetic Back UI or SPA history emulation.
- Source metadata is saved with manifests for offline info dialogs; Japanese
  titles take precedence. Tags are text, not unimplemented search controls.
- No automatic deletion on favorite removal. No storage reset feature.

## Storage contract (preserve these identities)

- IndexedDB **gallery-offline-test-v1**, version **1**, stores `kv`, `downloads`,
  and `manifests`. No schema migration, image blobs, or per-page database rows.
- Original checkpoint key: `<provider>-<id>`; manifest key:
  `<provider>-<id>-<revision>`; original pack:
  **gallery-offline-test-v1/<provider>-<id>-<revision>.pages**.
- Original revisions still hash precisely filename, byte length, and mtime.
  Adding metadata, dimensions, or thumbnails does not change that hash.
- Thumbnail checkpoint key: `<provider>-<id>:thumbs`; manifest key:
  `<provider>-<id>:thumbs-<revision>`; pack:
  **gallery-offline-thumbnails-v1/<provider>-<id>-<revision>.thumbs**.
- Thumbnail revisions depend only on source thumbnail files. Both pack types
  concatenate original source bytes, without resizing, transcoding or compression.
- `details-<provider>-<id>` manifests are read on demand, never as a boot scan.
  The small catalog and roughly two checkpoint records per gallery are the
  only library-wide initialization reads.
- No OPFS open in worker `init`. Original storage opens only for Download or
  Reader. The separate thumbnail directory opens asynchronously for visible
  locally saved previews after the list is rendered; there is no enumeration.
- A worker streams one file at a time into a synchronous access handle, flushes
  bytes, then commits its IndexedDB checkpoint. Resume discards only an
  uncommitted tail; a missing/short pack restarts that pack safely. Committed
  pages are skipped. Browser/OS physical durability and eviction remain platform
  constraints, not an unconditional power-loss guarantee.
- One Web Lock excludes concurrent writers. `pagehide` terminates this window's
  worker, releasing IDB/access handles. Downloads do not auto-resume on boot or Back.
- Rendering slices only nearby pages/previews into blobs, bounds concurrency
  and the preview File cache, and revokes offscreen blob URLs. It never reads
  an entire multi-GB pack into memory or decodes the entire collection.

## Server and caching

`offline-api.ts` serves catalog, ordered original/thumbnail manifests, metadata,
and validated provider-qualified image routes. Original dimensions are obtained
with header inspection (`image-size-next`), not an image conversion pipeline.
The legacy doubled Hitomi `info.count` remains supported.

Image/API responses use `no-store` to avoid duplicating OPFS bytes in the HTTP
cache. Cache Storage holds only the explicit, small shell allowlist. The
service worker maps root document query URLs to that shell for offline reading;
it never intercepts downloader, media, or API routes. HTML uses ordinary static
headers, not `no-store`. No forced service-worker takeover during a transfer.

The existing local CA must be trusted on iPhone. The certificate covers
192.168.1.197 and localhost (not 127.0.0.1). This remains a LAN-only service;
do not expose port 7777 to the Internet.

## Verification

```bash
npm test
npm run build
systemctl --user restart gallery-downloader.service
node tests/ios/pwa.mjs
```

The phone test uses the shared userscript-ios-test debugger and Safari only.
It does not press Download or clear existing data. It checks the live thumbnail
home, no original requests from listing, an existing saved reader when present,
and bfcache via `pageshow.persisted`, DOM identity, and both scroll axes. A fresh
Safari partition with no originals can verify only the missing-download reader
state. The runner returns Safari to example.com and closes its bridge.

Automated worker adapters cover no-OPFS initialization, stream truncation,
checkpoints, stop/resume, original-only upgrade/thumbnail backfill without
original re-fetch, offline thumbnail/page reads, eviction repair, and shell-only
caching. They do not substitute for Safari's actual storage implementation.

Final device acceptance: Resume inside the installed PWA, stop after previews
are saved, disable Wi-Fi as well as mobile data, cold-open, open a saved page,
swipe back, and repeat after force-close/reboot. Startup timings remain available
as `window.bootMarks` for diagnostics, not permanent UI clutter.

Live Safari check on 2026-09-07: 25 gallery rows, 20 loaded thumbnails and no
original requests in the listing; the existing 123-page partial download opened
and five original images decoded. Back reported `pageshow.persisted === true`,
retained the same row DOM, and restored horizontal 200px / vertical 78px exactly.
The installed PWA was not controlled or reset. Live server checks also confirmed
unchanged pre-upgrade original revisions for Hitomi 2312444 and IMHentai 1362775.
The extended Safari pass also verified the final page's ten IMHentai rows,
20 decoded thumbnails, and the nine-row information dialog. The final shell is
v6, approximately 42 KB; an older open tab can delay activation until closed.
