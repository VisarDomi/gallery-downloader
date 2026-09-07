# Pipeline boundaries

- The userscript owns provider-local favorites. Ordinary snapshots are non-destructive. No artist/query discovery, OCR, or automatic deletion.
- The downloader owns HTTPS port 7777, durable favorites snapshots, acquisition, queue controls, and manual reconcile. Local provider files are the authoritative downloaded content.
- The PWA owns device-local offline storage. Keep shell-only Cache Storage, small IndexedDB checkpoints, and independent per-gallery OPFS packs. Preserve existing database identity, pack naming, and original revisions when adding thumbnails.
- All thumbnails must be downloaded from their source. Do not resize originals or introduce image-generation dependencies. Repair missing thumbnails independently of saved originals.
- The intended UI matches gallery-reader: paginated thumbnail strips and a content-only full-width reader. No search, saved-search, import/export, or favorite-edit heart for now. Reader navigation should use real document navigation and native swipe-back/bfcache.
- No CBZ publishing, separate comic server, or external reader app is part of the runtime.
- Durable writes flush content before publishing completion. Chromium closes in `finally` on dedicated display `:112` and must not accumulate persistent diagnostic files.
- The PC queue has a persistent visible failed-job interface. Temporary failures have bounded exponential cooldowns; persistent invalid URLs need attention after a fresh extraction attempt. Failed jobs survive service restart and favorite sync without being automatically revived. Manual Retry starts a new budget. See notes.md for exact delays and controls.
