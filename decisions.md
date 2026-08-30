# Architecture decisions

## Full snapshots are the favorite protocol

Each `gallery-reader` provider origin owns its own ordered favorite list. It sends complete provider-qualified snapshots instead of add/remove events. This makes updates idempotent and repairs changes made while the PC is unavailable. Numeric gallery IDs are never assumed globally unique.

## The downloader is the only Gallery LAN service

The downloader owns public HTTPS port `7777`, favorite persistence, queue scheduling, provider acquisition, manual deletion, CBZ publication, and Komga scan notification. The streamer and indexer were removed. Komga owns the presentation/catalog layer on `25600`, and Eclipse owns phone-native offline reading.

## Snapshot sync is non-destructive

Normal sync may prune stale pending work and add missing work, but never removes completed data. Exact reconciliation is a separate manual command. It deletes both loose galleries and provider-qualified CBZs, clears Hitomi archive entries first, uses a durable retirement rename, and skips active downloads.

## Queue and publication survive interruption

The active URL, pending URLs, pause state, and favorites snapshots use temporary-write, file-fsync, rename, and parent-directory-fsync replacement. Metadata plus the absence of `.downloading-*` is the completion boundary; Hitomi may write `info.json` before its last page. A failed synchronous CBZ export leaves the marker/checkpoint in place and causes systemd to restart the downloader so publication is retried.

## IMHentai uses Chromium only for protected HTML

Gallery-dl receives HTTP 403 from IMHentai even with copied browser state. A real visible Chromium context on the dedicated `:112` Xvfb display obtains the gallery manifest. Chromium is closed in `finally`; immutable CDN files are downloaded outside the browser. The persistent automation profile is separate from normal browsing and Video Platform's `:111` display.

## Loose files and CBZs have different jobs

Loose provider files are resumable acquisition state. A provider-qualified CBZ is the stable Komga ingestion format. Duplicating full images is accepted for now because it keeps recovery and the Komga boundary simple; thumbnails are excluded from CBZs.

## Retired systems live in Git history

The custom PWA, streamer, indexer, artist/query discovery, automatic remote discovery, automatic deletion, and server OCR are not compatibility requirements. They should not be reintroduced into the main process without a new explicit decision.
