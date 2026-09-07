# Gallery Downloader

`gallery-reader` provider favorites → HTTPS downloader → local images → offline OPFS PWA.

- PWA: https://192.168.1.197:7777/
- PC queue controls: https://192.168.1.197:7777/downloader
- Operations: [notes.md](notes.md)
- Offline app, storage and updates: [OFFLINE-TEST.md](OFFLINE-TEST.md)
- Boundaries: [decisions.md](decisions.md)
- Phone backup/restore and pre-format checklist: [READER-BACKUPS.md](READER-BACKUPS.md)

The user reported fast iOS 27 beta 8 PWA startup with 7 GB saved on 2026-09-07. The app now has paginated source-thumbnail strips, offline gallery information, and a content-only reader with native Back navigation. Resume downloads adds separate thumbnail packs without invalidating existing original packs. See the update instructions above; do not clear website data.
