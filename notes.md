## agent notes

The runtime is deliberately small:

- `gallery-sources`: Hitomi/IMHentai download descriptors
- `gallery-server/downloader`: HTTPS favorites API, durable queue, acquisition, manual reconcile, and the `/offline-api` the Gallery Reader app reads
- `gallery-server/downloader/public/offline`: the offline UI bundled into the Gallery Reader app (`apps/ios`)
- `gallery-server/scripts`: favorites command wrappers and offline UI tests
- `systemd/user`: downloader and Gallery Xvfb `:112` units

Ports:

- `7777`: HTTPS queue UI at `/downloader`, favorites API, `/offline-api` and status

Operational rules:

- `gallery-reader` (Hitomi and Imhen apps) owns provider-local favorite intent.
- Ordinary sync is non-destructive; only `npm run reconcile:favorites` deletes completed galleries.
- Preserve atomic checkpoint and completion ordering when modifying queue or storage code.
- IMHentai Chromium must always close in `finally` and use the dedicated `:112` profile/display.
- Protect Chromium BrowserMetrics (`~/.config/chromium-gallery/BrowserMetrics`) with mode `0500` before each launch; it once filled 60 GiB with diagnostic files. Do not reintroduce unbounded job retries; failed state/cooldowns must survive restart and favorites sync.
- Source thumbnails only: Hitomi gallery-dl; IMHentai's own thumbnail URL pattern, independent of original extensions. No generated substitutes.
- Keep the offline UI's scroll-settle and image-retry helpers faithful to gallery-reader's `src/core/{scroll-settle,image-retry}.ts`.

Start diagnosis with:

```bash
npm run status:all
journalctl --user -u gallery-downloader.service -n 300 --no-pager
```

# setup

`gallery-reader` provider favorites → HTTPS downloader → local images → Gallery Reader app.

- PC queue controls: https://192.168.1.197:7777/downloader
- iPhone app: [apps/ios/README.md](apps/ios/README.md)
- Boundaries: [decisions.md](decisions.md)

# Operations

The downloader persists favorites snapshots in `gallery-server/favorites/`, schedules missing galleries, and serves the app's API on trusted HTTPS port 7777. Original files live in `/home/visar/Pictures/gallery-dl/<provider>/<id>/`.

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

## Retries and failed jobs

Attempt reservations, errors and cooldown deadlines survive restart in `/home/visar/Pictures/gallery-dl/.retry-state.json`. Temporary errors retry after 30 seconds, 2 minutes, 10 minutes, 1 hour, and 6 hours; a longer IMHentai `Retry-After` takes precedence. Six total queue attempts is the limit. Repeated non-transient 4xx responses stop after two attempts, allowing one fresh manifest extraction. Disk-full and permission failures require attention immediately. Another ready gallery can run while one waits for its cooldown.

`/downloader` shows running/retrying/Needs attention records, failed filenames, error messages, attempt counts, and the next retry time. Use Retry for one failed job or Retry all for all failed jobs (`POST /retry-failed` with optional `{ "url": "..." }`). Favorite sync and service restart do not reset failed jobs. Pause/Stop preserve queue and downloaded files; Resume respects retry cooldowns. Manually saving/injecting URLs starts a new retry budget for those URLs. Corrupt retry state fails closed instead of silently resetting budgets.

## Thumbnails

IMHentai thumbnails do not reuse the original's extension (an original WebP or PNG page can have a `Nt.jpg` thumbnail), so the thumbnail pattern comes from an actual source thumbnail URL with only the page number substituted. Hitomi uses the local gallery-dl extractor with archive lookup disabled, so stale archive records cannot hide missing files; gallery-dl still skips existing files and resumes partial files. Full originals finish first and remain available if thumbnail repair fails. Transfers have timeouts, validate image responses, and atomically publish complete files.
