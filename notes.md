# Gallery Downloader

Gallery Downloader mirrors the provider-local favorites selected in the `gallery-reader` userscript, downloads missing galleries, publishes CBZ copies for Komga, and leaves reading/offline storage to Eclipse Reader.

The final pipeline is:

```text
gallery-reader -> Gallery Downloader -> loose gallery + CBZ -> Komga -> Eclipse Reader
```

There is no custom PWA, streamer, indexer, discovery engine, or server OCR in the runtime.

## Runtime

- Gallery Downloader: `https://192.168.1.197:7777`
- Komga inside this PC: `http://127.0.0.1:25600`
- Komga from Eclipse Reader: `http://192.168.1.197:25600`
- Chromium automation: Xvfb display `:112`; inspect it with `peek 112`

The address `192.168.1.197` is expected to stay static. Ports `7777` and `25600` are LAN services; neither should be exposed directly to the internet. The favorites API trusts the LAN and has permissive CORS because it must accept requests from the userscript's provider origins.

Managed user services:

- `gallery-downloader.service`
- `gallery-xvfb.service`
- `komga.service`

All three are enabled. User lingering keeps them running across logout and boots them without an interactive login.

```bash
npm run build
npm test
npm run restart
npm run status:all
npm run logs
```

## Favorites and downloads

`gallery-reader` owns favorite intent. It sends a complete ordered snapshot to one of:

```text
PUT /api/favorites/hitomi
PUT /api/favorites/imhentai
```

The downloader atomically stores each accepted snapshot under the ignored `gallery-server/favorites/` directory. A full snapshot is idempotent and repairs updates missed while the PC was unreachable.

Receiving a snapshot or starting the service:

- prunes no-longer-wanted pending entries for that provider;
- queues missing or interrupted favorites;
- never automatically deletes a completed gallery.

The queue checkpoint, favorites snapshots, completion markers, and published metadata use durable atomic replacement. A gallery is complete only when its metadata exists and its `.downloading-*` marker is gone. An interrupted active URL is restored after service restart or power loss. Failed downloads retry with bounded exponential backoff and move to the queue tail after five failures, so they remain scheduled without blocking every later gallery.

Run a non-destructive sync again from the stored snapshot:

```bash
npm run sync:favorites
npm run sync:favorites -- imhentai
```

The downloader retains a small HTTPS queue/status page at port `7777`. Dynamic API and status responses use `Cache-Control: no-store`; this service no longer hosts the reader shell or gallery media.

## Manual reconciliation

Deletion is always explicit:

```bash
npm run reconcile:favorites
npm run reconcile:favorites -- imhentai
```

The command removes completed loose galleries and provider-qualified Komga CBZs that are absent from the selected snapshot. It also clears the matching Hitomi gallery-dl archive records so a later re-favorite can download every page. It refuses to run before the first authoritative snapshot and skips a currently active download; run it again later to remove anything skipped.

## IMHentai and Chromium

IMHentai rejects gallery-dl's HTTP fingerprint even with exported Chromium cookies. The downloader therefore opens the protected metadata page in a real headful persistent Chromium context, extracts the image manifest, closes Chromium in `finally`, and downloads the public CDN images normally.

The dedicated profile is `/home/visar/.config/chromium-gallery`. If Cloudflare needs interaction, use `peek 112`; accepted state persists in that Gallery-only profile. Do not use it for personal browsing or logins.

Test one gallery without changing favorites:

```bash
npm run download:imhentai -- 1043741
```

## Storage

Loose, resumable source galleries live at:

```text
~/Pictures/gallery-dl/hitomi/<id>/
~/Pictures/gallery-dl/imhentai/<id>/
```

Komga-ready copies live at:

```text
~/Pictures/komga/_oneshots/<provider>-<id>.cbz
```

CBZ publication includes only full-size numbered pages plus `ComicInfo.xml`; downloader thumbnails are not duplicated. The archive is fsynced and atomically renamed. A completion callback then asks Komga to scan, while Komga's hourly scan provides recovery if that request fails.

The loose gallery and CBZ are intentionally duplicate data: loose files are the resumable provider/download state, while CBZ is the stable Komga boundary. Monitor disk usage as the favorites library grows.

See [KOMGA.md](./KOMGA.md) for Komga operations and [decisions.md](./decisions.md) for the durability/ownership decisions.
