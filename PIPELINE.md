# PC pipeline

`gallery-reader` provider favorites → HTTPS downloader on this PC → local images →
Gallery Reader on the phone ([apps/ios/README.md](apps/ios/README.md)).

The runtime is deliberately small:

- `gallery-sources`: Hitomi/IMHentai download descriptors.
- `gallery-server/downloader`: the HTTPS server on port `7777`. It holds the favorites API,
  the durable queue, acquisition, manual reconcile, the queue UI at `/downloader`, `/status`,
  and the `/offline-api` the Gallery Reader app reads (`catalog`,
  `<provider>/<id>/manifest`, `pages/<name>`, `thumbnails/<name>`).
- `gallery-server/scripts/favorites-command.mjs`: the sync and reconcile wrappers.
- `gallery-server/favorites/` (gitignored): durable favorites snapshots.
- `gallery-server/gallery-dl/` (gitignored): the local gallery-dl checkout (its own Git
  repository and `.venv`) used for Hitomi.
- `systemd/user`: `gallery-downloader.service` and `gallery-xvfb.service` (display `:112`).
  The installed copies in `~/.config/systemd/user/` are the same files. The service runs
  `~/.local/bin/gallery-downloader`, which starts `gallery-server/downloader/dist/main.js`.

Addresses and files:

- Queue controls: https://192.168.1.197:7777/downloader
- Originals and thumbnails: `/home/visar/Pictures/gallery-dl/<provider>/<id>/`.
- TLS: mkcert's `~/.local/share/mkcert/pwa/{cert,key}.pem`, signed by
  `~/.local/share/mkcert/rootCA.pem`. The phone app trusts only the public root
  (see [apps/ios/README.md](apps/ios/README.md)). Never copy or commit the keys.

## Commands

```bash
npm run build
npm test
npm run status:all
npm run restart                  # builds first: the service runs dist/
npm run logs
npm run sync:favorites           # Hitomi; `npm run sync:favorites -- imhentai` for IMHentai
npm run reconcile:favorites      # same provider argument
DISPLAY=:112 npm run download:imhentai -- <gallery ID or URL>   # one gallery, outside the queue
```

Start diagnosis with:

```bash
npm run status:all
journalctl --user -u gallery-downloader.service -n 300 --no-pager
```

`peek 112` (an alias for `/home/visar/Documents/environment/shell/peek.sh`) shows the
headful Chromium session.

## Boundaries and rules

- `gallery-reader` (the Hitomi and Imhen apps) owns provider-local favorite intent. The
  downloader keeps snapshots of it. No artist/query discovery, OCR, or automatic deletion.
- Ordinary sync is non-destructive: it does not delete saved galleries. Only
  `npm run reconcile:favorites` removes unwanted completed galleries and the corresponding
  Hitomi archive entries; active downloads are skipped. Do not run reconcile just to repair
  a failed download.
- Local provider files are the authoritative downloaded content. The iPhone app owns its
  own offline copy on the phone.
- Preserve existing gallery identities and original revisions when adding thumbnails (the
  phone keeps files per revision).
- Durable writes flush content before publishing completion. Preserve atomic checkpoint and
  completion ordering when modifying queue or storage code.
- IMHentai Chromium must always close in `finally` and use the dedicated `:112`
  display and profile (`~/.config/chromium-gallery`).
- Protect Chromium BrowserMetrics (`~/.config/chromium-gallery/BrowserMetrics`) with mode
  `0500` before each launch; it once filled 60 GiB with diagnostic files.
- Do not reintroduce unbounded job retries. Failed state and cooldowns must survive restart
  and favorites sync.
- Thumbnails come only from the source: Hitomi through gallery-dl, IMHentai through its own
  thumbnail URL pattern. Do not resize originals, generate substitutes or add
  image-generation dependencies. Repair missing thumbnails independently of saved originals.
- No CBZ publishing, separate comic server, or external reader app is part of the runtime.

## Retries and failed jobs

Attempt reservations, errors and cooldown deadlines survive restart in `/home/visar/Pictures/gallery-dl/.retry-state.json`. Temporary errors retry after 30 seconds, 2 minutes, 10 minutes, 1 hour, and 6 hours; a longer IMHentai `Retry-After` takes precedence. Six total queue attempts is the limit. Repeated non-transient 4xx responses stop after two attempts, allowing one fresh manifest extraction. Disk-full and permission failures require attention immediately. Another ready gallery can run while one waits for its cooldown.

`/downloader` shows running/retrying/Needs attention records, failed filenames, error messages, attempt counts, and the next retry time. Use Retry for one failed job or Retry all for all failed jobs (`POST /retry-failed` with optional `{ "url": "..." }`). Favorite sync and service restart do not reset failed jobs. Pause/Stop preserve queue and downloaded files; Resume respects retry cooldowns. Manually saving/injecting URLs starts a new retry budget for those URLs. Corrupt retry state fails closed instead of silently resetting budgets.

## Thumbnails

IMHentai thumbnails do not reuse the original's extension (an original WebP or PNG page can have a `Nt.jpg` thumbnail), so the thumbnail pattern comes from an actual source thumbnail URL with only the page number substituted. Hitomi uses the local gallery-dl extractor with archive lookup disabled, so stale archive records cannot hide missing files; gallery-dl still skips existing files and resumes partial files. Full originals finish first and remain available if thumbnail repair fails. Transfers have timeouts, validate image responses, and atomically publish complete files.
