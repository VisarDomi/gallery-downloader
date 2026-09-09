## agent notes

The runtime is deliberately small:

- `gallery-sources`: Hitomi/IMHentai download descriptors
- `gallery-server/downloader`: HTTPS favorites API, durable queue, acquisition, and manual reconcile
- `gallery-server/scripts`: favorites command wrappers and offline tests
- `systemd/user`: downloader and Gallery Xvfb `:112` units
- `gallery-server/downloader/public/offline`: local offline reader; see `OFFLINE-TEST.md`

Ports:

- `7777`: HTTPS PWA at `/`, queue UI at `/downloader`, and downloader API/status

Operational rules:

- `gallery-reader` owns provider-local favorite intent.
- Ordinary sync is non-destructive; only `npm run reconcile:favorites` deletes completed galleries.
- Preserve atomic checkpoint and completion ordering when modifying queue or storage code.
- IMHentai Chromium must always close in `finally` and use the dedicated `:112` profile/display.
- Protect Chromium BrowserMetrics with mode `0500` before each launch. Do not reintroduce unbounded job retries; failed state/cooldowns must survive restart and favorites sync.
- Source thumbnails only: Hitomi gallery-dl; IMHentai's own thumbnail URL pattern, independent of original extensions. No generated substitutes.
- Startup must paint before storage work. Worker init never opens OPFS; original packs open only on Download/Reader, and separate preview packs only for visible thumbnails after rendering. Never enumerate image directories on boot. Cache Storage is shell-only.
- Preserve IndexedDB v1 and all original checkpoint/pack identities. Thumbnail state uses independent keys/packs. Do not invalidate original revisions when changing metadata or previews.

Start diagnosis with:

```bash
npm run status:all
journalctl --user -u gallery-downloader.service -n 300 --no-pager
```

# setup

`gallery-reader` provider favorites → HTTPS downloader → local images → offline OPFS PWA.

- PWA: https://192.168.1.197:7777/
- PC queue controls: https://192.168.1.197:7777/downloader
- Operations: [notes.md](notes.md)
- Offline app, storage and updates: [OFFLINE-TEST.md](OFFLINE-TEST.md)
- Boundaries: [decisions.md](decisions.md)
- Phone backup/restore and pre-format checklist: [READER-BACKUPS.md](READER-BACKUPS.md)

The user reported fast iOS 27 beta 8 PWA startup with 7 GB saved on 2026-09-07. The app now has paginated source-thumbnail strips, offline gallery information, and a content-only reader with native Back navigation. Resume downloads adds separate thumbnail packs without invalidating existing original packs. See the update instructions above; do not clear website data.


# Operations

`gallery-reader` owns Hitomi/IMHentai favorites. The downloader persists snapshots in `gallery-server/favorites/`, schedules missing galleries, and serves the PWA on trusted HTTPS port 7777. Original files live in `/home/visar/Pictures/gallery-dl/<provider>/<id>/`.

```bash
npm run build
npm test
npm run status:all
npm run restart
npm run logs
npm run sync:favorites
npm run reconcile:favorites
```

Normal favorites sync does not delete saved galleries. Manual reconcile removes unwanted completed galleries and corresponding Hitomi archive entries; active downloads are skipped. Do not run reconcile just to repair a failed download.

Services: `gallery-downloader.service` and dedicated `gallery-xvfb.service` on display `:112`. `peek 112` exposes the headful Chromium session; the browser must close in `finally`. Originals and thumbnails must come from the source, with no locally generated substitute images.

## Diagnostic disk incident, 2026-09-07

Chromium's profile `/home/visar/.config/chromium-gallery/BrowserMetrics` contained 15,420 diagnostic `.pma` files totaling 60.23 GiB. These matching files were deleted and the directory set to mode `0500`; cookies and image downloads were preserved. A subsequent bounded two-gallery Chromium inspection produced no new metrics files. The permission change is reversible with `chmod 700` on that exact directory.

The old queue reset its retry counter forever. That loop is removed. Attempt reservations, errors and cooldown deadlines now survive restart in `/home/visar/Pictures/gallery-dl/.retry-state.json`. Temporary errors retry after 30 seconds, 2 minutes, 10 minutes, 1 hour, and 6 hours; a longer IMHentai `Retry-After` takes precedence. Six total queue attempts is the limit. Repeated non-transient 4xx responses stop after two attempts, allowing one fresh manifest extraction. Disk-full and permission failures require attention immediately. Another ready gallery can run while one waits for its cooldown.

`/downloader` shows running/retrying/Needs attention records, failed filenames, error messages, attempt counts, and the next retry time. Use Retry for one failed job or Retry all for all failed jobs (`POST /retry-failed` with optional `{ "url": "..." }`). Favorite sync and service restart do not reset failed jobs. Pause/Stop preserve queue and downloaded files; Resume respects retry cooldowns. Manually saving/injecting URLs starts a new retry budget for those URLs. Corrupt retry state fails closed instead of silently resetting budgets.

IMHentai's old thumbnail URL construction reused the original extension. Live verification found gallery 1362775 page 5 uses original WebP but thumbnail `5t.jpg`, and gallery 988447 page 2 uses original PNG but thumbnail `2t.jpg`. Guessed `.webp`/`.png` thumbnail requests return 404; the actual JPEG thumbnail URLs return 200. Existing thumbnail files stop immediately before these pages. Older exact error messages were only broadcast over Socket.IO, not persisted. After original-only downloading was enabled, four logged HTTP 429 failures for 988447 page 101 recovered automatically and all 15 IMHentai galleries completed.

Source thumbnails are restored. Hitomi uses the existing local gallery-dl extractor, with archive lookup disabled so stale archive records cannot hide missing files; gallery-dl still skips existing files and resumes partial files. IMHentai uses the same one-gallery manifest parsing approach as gallery-reader but obtains the thumbnail pattern from an actual source thumbnail URL. Only its page number is substituted; the original image extension is never reused. No Load all endpoint, no thumbnail generation, and no extra comic server. Full originals finish first and remain available if thumbnail repair fails. Transfers have timeouts, validate image responses, and atomically publish complete files.

Verified 2026-09-07 after gallery-reader build 506's iPhone test: downloader parity tests cover mixed original formats, pages beyond the first ten, explicit thumbnail overrides, query strings, GIF thumbnails, and missing-pattern failure without an original-image substitute. Existing complete thumbnail files are skipped; an interrupted file is fetched again and atomically published (not byte-range resumed). Backfill reached 100,851 thumbnail files beside 100,851 originals across 545 Hitomi and 15 IMHentai favorites. The before/after digest of original filenames, sizes, and modification times was identical. These are PC acquisition counts, not device download counts.

The metrics directory is protected before each managed Chromium launch, including a recreated profile; cancellation closes the browser in `finally`. The PWA now saves separate source-thumbnail packs and renders paginated strips and a content-only reader. Existing device original packs and their revisions are unchanged. See OFFLINE-TEST.md for updating, Safari tests, and installed-PWA acceptance checks.
