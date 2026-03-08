# Gallery Reader

Monorepo. 4 packages: gallery-index, gallery-reader (Svelte frontend), gallery-server (streamer/indexer/downloader, port 11556), gallery-sources.
Sprite generation: `gallery-server/sprite-gen/` Go daemon via Unix socket. Systemd: gallery-sprite-gen.service, gallery-sprite-pregen.service (daily 05:00).
Go scanner: `gallery-server/indexer/src/go/scanner.go`.
