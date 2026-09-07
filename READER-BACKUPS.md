# Reader backups before formatting an iPhone

The existing HTTPS `gallery-downloader.service` on port 7777 also stores private
backups for Gallery Reader, Manga Reader and KM Explorer. This is separate from downloader
favorites and from the PWA's downloaded images.

## Phone flow

1. Install the new builds of both userscripts on the **old phone before formatting**.
2. On the same LAN, visit each provider's home using its normal Safari website.
3. On first use, the prompt compares the phone's counts with available PC backups.
   Choose **Back up this phone** and give it a recognizable name. Each provider
   has its own worker-owned IndexedDB ID; using the same name makes the phone's backups easy
   to find across providers. Different phones never share an ID.
4. Initial setup shows **Backed up to PC** on each provider after confirmation.
   Later automatic saves are silent. An error or choosing **Later** is not a
   successful backup. The PC status command below verifies received counts.
5. Only after verifying all needed providers, format the phone.
6. Reinstall/trust the PC's HTTPS certificate and install both userscripts again.
   Visit each provider home and choose **Restore from PC**, selecting the old
   phone's matching backup. The selector also offers its one previous snapshot.

Restore replaces that provider's script-owned local data, then creates a **new,
independent backup ID**. The selected old phone backup is never modified.
Following either initial choice, home visits (including a bfcache Back to home)
back up automatically without checking/success notifications. Unreachable PCs,
connection timeouts and unavailable services are silent, including on fresh
phones: no setup prompt appears until the PC returns a valid backup listing.
The next home visit retries. Online access/validation/storage errors remain
visible until dismissed or a successful retry. Reader/search pages do not initiate backup setup.
`Later` only postpones setup; it is not a third backup mode.

Gallery favorite downloads are gated until initial backup/restore succeeds.
They subsequently sync after a successful home backup and after favorite/import
changes. A fresh phone cannot publish an empty favorite list before setup.

## Exactly what is saved

| Reader | Script-owned storage |
| --- | --- |
| Gallery Reader | IndexedDB `gallery-reader-data` v1: favorites, saved searches, pagination, and all scroll positions, migrated from its original localStorage keys |
| Manga Reader | IndexedDB `manga-reader-compute` v2: complete `progress`, `tokens`, and `metadata` stores, with current progress schema v3 |
| KM Explorer | IndexedDB `km-explorer` v5: complete `videos`, `details`, `channels`, and `preferences` stores; preferences migrate favorites, selected-card identity and listing scroll positions from its old localStorage |

Manga progress is the latest resume position per series, not an independently
stored list of every chapter ever read. Manga Reader has no other existing
script-owned localStorage data. Gallery Reader reads legacy localStorage only on
the first migration, in small yielding batches, without deleting or changing it.
Its worker then uses IndexedDB exclusively. Both readers store backup IDs in
worker-owned `reader-pc-backup-state-v1`; these IDs/names are setup bookkeeping
and are deliberately not restored.
Unrelated website storage, cookies, server-owned reading histories, browser
credentials, and the separate PWA's OPFS/image downloads are not copied.
Stored Asura tokens are included, but provider login may still be necessary if
tokens expire or are revoked. A backup is not a guarantee of continued login.

## PC storage and verification

Run from this repository:

```bash
npm run backups:status
systemctl --user status gallery-downloader.service --no-pager
```

Snapshots live at `backups/readers/<reader>/<provider>/<installation-id>.json`.
Each file contains `current` and **at most one** `previous` snapshot. Repeated
identical uploads do not rotate snapshots or generate more files. There is no
automated deletion of separate phone identities. PC status prints counts, not
session token contents.

The entire two-generation record is written to a temporary file, fsynced, renamed,
then its directory is fsynced. Newly created directories are also committed in
their parents. Files are mode 0600; newly created directories are 0700. Backups
are excluded from Git and are not exposed by static file serving.

On the phone, Manga restore uses one strict-durability IndexedDB transaction
across all three stores. Gallery migration and restore each use one strict
IndexedDB transaction. No partial localStorage restore is needed.
Existing state is validated before replacing it. API writes use a revision check
to reject stale uploads. Unexpectedly empty content cannot replace a nonempty
backup: the next home visit asks the two setup choices again.

## Access and builds

The service creates `backups/readers/access-key` once. Both Vite builds read that
file from this sibling repository by default. Optional `.env.local` settings are
documented in each reader's `.env.example`. An absent key fails the build rather
than silently producing a reader without backups.

The API is `/api/reader-backups/<reader>/<provider>` (GET) and the same path with
`/<installation-id>` (PUT). It requires `X-Reader-Backup-Key`, serves `no-store`,
allows CORS only from the nine configured reader origins (including `https://ytboob.com`), and limits an upload
to 5 MB for the readers or 50 MB for KM Explorer's catalog/URL caches. Authenticated fetch runs inside each reader's worker; no GM grant is
needed. Both UI threads receive only backup counts/labels, not full snapshots.
Slow backup HTTP requests do not block the workers' data-write queues.
Never publish the built userscripts with
their embedded private key, or the backup files containing session records.
These backups are private on disk but not encrypted at rest.

Keep `backups/readers/`, including its key, if moving this service to another PC.
The key remains unchanged across service restarts and phone formats. This is a
local-PC backup, not protection against loss of the PC itself.

## Verification tests

`npm test` here tests snapshot isolation, retention, idempotent retry, stale/empty
write rejection, filesystem permissions and authenticated HTTP access. Each
reader's unit suite tests the two-choice client, interrupted requests and restore
validation. Gallery startup tests enforce route match → stop/open/close before storage work.
In Manga Reader, `node tests/browser/backup.mjs` additionally tests real Chromium
IndexedDB restore, mid-transaction rollback, tokens/metadata and reload persistence
in a disposable profile, using the sibling downloader's Playwright dependency.

Gallery's `npm run test:browser` runs real workers plus the complete userscript
against synthetic provider responses and a disposable real PC backup store.
It checks preserved data, usable home while the PC waits, edits surviving reload,
source previews and reader images, previous-snapshot recovery, independent
formatted-phone restore and Back. It does not claim desktop Back proves iOS bfcache.

## Verified phone backups — 2026-09-07

All eight snapshots were compared to the actual Safari data using SHA-256 over
canonical serialized values. All matched exactly; favorites/searches/progress
also matched their pre-migration/pre-backup values. No phone restore or clear was
performed. Profile label: **iPhone before iOS downgrade**.

| Provider | Saved data |
| --- | --- |
| Hitomi | 545 favorites, 66 saved searches, 85 scroll positions |
| IMHentai | 15 favorites, 8 saved searches, 25 scroll positions |
| EzManga | 7 series resume positions |
| QiManga | 1 series resume position |
| Yaksha Comics | 1 series resume position |
| Asura Scans | 29 series resume positions, 2 session records |
| Scythe Scans | 5 series resume positions |
| Lua Comic | 2 series resume positions |

Manga metadata was included on every provider. Injection through the debugger
does not install or enable the userscripts: install the new builds to keep
automatic backups running. After formatting, reinstall/trust the HTTPS CA,
install the builds, and select this profile under Restore on each provider home.

The same phone session verified both Gallery Reader thumbnail lists and full-image
readers. Hitomi's native Back restored the original DOM and scroll positions.
IMHentai reloaded on Back even without Gallery Reader; its HTTPS home response
sends `Cache-Control: no-store`. See Gallery Reader's `test.md` for the isolated
diagnostic and WebKit source. This navigation limitation does not affect backup
or migration correctness.

## KM Explorer verified phone backup — 2026-09-07

Profile **iPhone before iOS downgrade**, ID `eed0074a-38dc-454f-bfc0-1b06d033ebb0`:
503 favorites, 21 scroll positions, one selected card, 12,633 cached videos,
4,966 cached details and 105 cached channels (about 2.9 MiB on disk).
Migration preserved personal data, every preexisting cache record and all legacy
localStorage keys. Every saved record was compared against Safari using canonical
SHA-256 hashes. All 503 cards became ready; a reload retained the identity/data
and showed zero backup notifications. Live Restore was not performed; full-store
restore/rollback was tested in disposable browser profiles.
