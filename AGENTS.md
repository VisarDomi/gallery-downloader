# Gallery Reader

Monorepo. Packages: `gallery-index`, `gallery-app` (Svelte frontend), `gallery-server` (streamer/indexer/downloader), `gallery-sources`.

Thumbnails are served directly from disk. No sprite generation.

Go scanner: `gallery-server/indexer/src/go/scanner.go`

## Read on demand

- Frontend app:
  `~/Documents/work/manga/gallery-reader/gallery-app/AGENTS.md`
- Ownership rule:
  `~/Documents/memory/ownership.md`

## Repo notes

- Ports:
  - `11556` streamer + frontend
  - `11557` indexer
  - `11558` downloader
- Gallery Reader uses `origin: "*"` CORS.
- Normal local-network fetches stay eager, but decoded GPU texture memory is a separate budget.
- Rows outside the viewport may suspend decoded image state while keeping fast resume paths available.
