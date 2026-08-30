# Komga operations

Komga owns cataloging, covers, search, accounts, reading progress, media delivery, and the API consumed by Eclipse Reader. Its upstream checkout is kept separately at `/home/visar/Documents/reference/komga`; this repository owns only the local service definition and the completed-gallery-to-CBZ boundary.

## Installed layout

- Versioned application: `/home/visar/.local/lib/komga/komga-1.26.3.jar`
- Database, task state, logs, and configuration: `/home/visar/.local/share/komga/`
- Library root: `/home/visar/Pictures/komga/`
- One-Shots directory: `/home/visar/Pictures/komga/_oneshots/`
- Internal URL: `http://127.0.0.1:25600`
- Eclipse Reader URL: `http://192.168.1.197:25600`

The Komga library is named `Gallery Favorites`, rooted at `/home/visar/Pictures/komga`, and configured with `/_oneshots`. Automatic library scans run hourly. Cover thumbnail generation is set to the XLARGE/1200 px option; Eclipse may still need its own cached cover invalidated after regeneration.

## API environment

Copy `.env.template` to the ignored `.env` and place the administrator-created API key there:

```dotenv
KOMGA_API_KEY=...
KOMGA_URL=http://127.0.0.1:25600
KOMGA_LIBRARY_ROOT=/home/visar/Pictures/komga
```

The scripts continue to recognize the original misspelled `KOGMA_*` keys so the existing local `.env` does not need a risky secret rewrite.

## Export and scan

Normally no command is required: every completed job publishes its CBZ and requests a scan before the queue advances.

Manual repair/backfill commands are idempotent:

```bash
npm run export:komga -- hitomi 3374239
npm run export:komga -- imhentai 1043741
npm run export:komga -- --all
npm run scan:komga
```

Re-export is skipped when the destination is newer than every source page and `info.json`. The `--all` backfill skips galleries with an active download marker. Add `--force` only when the archive must be rebuilt despite current timestamps.

## Recovery and backup

The exporter prefers the provider's Japanese `title_jpn` for both the book and one-shot series title, falling back to `title` only when no Japanese title exists. Eclipse displays the resulting Komga metadata; it does not choose between the provider's English and Japanese fields itself.

The CBZ library is derived from loose source galleries and can be rebuilt with `--all`. Komga's database is not derived: it contains accounts, reading progress, server settings, and task state. Back up `/home/visar/.local/share/komga/` separately while Komga is stopped or with a filesystem-consistent snapshot.

Plain HTTP is acceptable only on the trusted LAN. Use a trusted HTTPS reverse proxy before any remote exposure; do not port-forward `25600` or `7777` directly.
