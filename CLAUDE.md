# Gallery Reader

## Svelte 5 Pitfalls

IMPORTANT: Before writing or modifying any `.svelte` or `.svelte.ts` file, read BOTH of these:
- [svelte5-pitfalls.md](/home/visar/.claude/projects/-home-visar/memory/svelte5-pitfalls.md) — quick rules
- [svelte5-pitfalls-detail.md](/home/visar/.claude/projects/-home-visar/memory/svelte5-pitfalls-detail.md) — detailed explanations with code examples

Monorepo. 4 packages: gallery-index, gallery-app (Svelte frontend), gallery-server (streamer/indexer/downloader, port 11556), gallery-sources.
Thumbnails served directly from disk (gallery-dl downloads them). No sprite generation — individual thumbs with object-fit: cover, viewport-gated via IntersectionObserver.
Go scanner: `gallery-server/indexer/src/go/scanner.go`.
