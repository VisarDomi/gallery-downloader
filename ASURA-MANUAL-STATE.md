# Manga Reader manual PC state

As of 2026-09-11 the Asura automatic feed is retired (HTTP 410). Existing feed
and named backup files are retained, not imported into the new shared state.
Gallery's own pipeline is unchanged.

Manga userscript, extension, and Asura iOS app show Load/Save under Home's loaded
text only when the PC responds to authenticated availability discovery.
`/api/reader-backups/manual/manga-reader/<provider>/status` returns availability
without reading/transferring history. GET the prefix loads the current snapshot;
PUT replaces it explicitly. No automatic publishing, merging, or polling of state.

Files under `backups/readers/manual-manga-<provider>.json` contain current and
previous complete snapshots, written atomically with 0600 permissions. An explicit
Save can replace with older or empty data; malformed input does not change disk.
No snapshot exists until the first deliberate Save. Existing access-key/CORS/TLS
configuration applies. Never put keys or backup contents in public logs.

Tests: from `gallery-server/downloader`, run `npm run build`, then
`node --test dist/reader-backups.test.js dist/manual-manga-state.test.js`.
Service: `systemctl --user restart gallery-downloader.service` after checking
`/status` has no active download; it runs compiled dist/main.js.
