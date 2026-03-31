# Gallery Reader

## Svelte 5 Pitfalls

IMPORTANT: Before writing or modifying any `.svelte` or `.svelte.ts` file, read BOTH of these:
- [svelte5-pitfalls.md](/home/visar/.claude/projects/-home-visar/memory/svelte5-pitfalls.md) — quick rules
- [svelte5-pitfalls-detail.md](/home/visar/.claude/projects/-home-visar/memory/svelte5-pitfalls-detail.md) — detailed explanations with code examples

Monorepo. 4 packages: gallery-index, gallery-app (Svelte frontend), gallery-server (streamer/indexer/downloader, port 11556), gallery-sources.
Sprite generation: `gallery-server/sprite-gen/` Go daemon via Unix socket. Systemd: gallery-sprite-gen.service, gallery-sprite-pregen.service (daily 05:00).
Go scanner: `gallery-server/indexer/src/go/scanner.go`.
