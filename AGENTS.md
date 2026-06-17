# Gallery Downloader

Monorepo. Packages: `gallery-index`, `gallery-app` (Svelte frontend), `gallery-server` (streamer/indexer/downloader), `gallery-sources`.

Thumbnails are served directly from disk. No sprite generation.

Go scanner: `gallery-server/indexer/src/go/scanner.go`

## Read on demand

- Frontend app:
  `~/Documents/work/manga/gallery-downloader/gallery-app/AGENTS.md`
- Ownership rule:
  `~/Documents/memory/ownership.md`

## Logs

- Start debugging by checking the managed service logs.
- Use direct `journalctl` for bounded reads:
  `journalctl --user -u gallery-streamer.service -n 300 --no-pager`
- For a time window, usually the specific time after a build so that you get the logs from the user tests:
  `journalctl --user -u gallery-streamer.service --since '2026-05-09 01:13:00' --until now --no-pager`

## Repo notes

- Ports:
  - `11556` streamer + frontend
  - `11557` indexer
  - `11558` downloader
- Gallery Downloader uses `origin: "*"` CORS.
- Normal local-network fetches stay eager, but decoded GPU texture memory is a separate budget.
- Rows outside the viewport may suspend decoded image state while keeping fast resume paths available.
