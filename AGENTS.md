# Gallery Downloader

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
