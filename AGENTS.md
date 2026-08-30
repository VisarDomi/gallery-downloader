# Gallery Downloader

The runtime is deliberately small:

- `gallery-sources`: Hitomi/IMHentai download descriptors
- `gallery-server/downloader`: HTTPS favorites API, durable queue, acquisition, and manual reconcile
- `gallery-server/scripts`: CBZ export, Komga scan, and command wrappers
- `systemd/user`: downloader, Gallery Xvfb `:112`, and Komga units

Ports:

- `7777`: Gallery Downloader HTTPS API/status/queue UI
- `25600`: Komga HTTP, internal scripts use `127.0.0.1`

Operational rules:

- `gallery-reader` owns provider-local favorite intent.
- Ordinary sync is non-destructive; only `npm run reconcile:favorites` deletes completed galleries/CBZs.
- Preserve atomic checkpoint and completion ordering when modifying queue or storage code.
- IMHentai Chromium must always close in `finally` and use the dedicated `:112` profile/display.
- Komga notification failure must not lose a completed download; the hourly scan is the fallback.

Start diagnosis with:

```bash
npm run status:all
journalctl --user -u gallery-downloader.service -n 300 --no-pager
journalctl --user -u komga.service -n 300 --no-pager
```
