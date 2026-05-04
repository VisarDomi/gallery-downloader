# Architecture Decisions

## Three-file manifest: filters.txt, artists.txt, queries.txt

**Decision:** Three files define what to download. `filters.txt` owns base filter policy (language + exclusions). `artists.txt` owns tracked creators. `queries.txt` owns specific positive tag searches. `manifest-resolver.ts` is the single owner of resolution logic — it reads all three and produces the wanted ID set.

**Ownership:**
- `filters.txt` — language (`japanese`) + all negative tokens (`-tag:anthology`, `-female:mind control`, etc.)
- `artists.txt` — just `namespace:value` entries (no language, no exclusions)
- `queries.txt` — just positive tokens per line (e.g. `female:big breasts female:cheating`)
- `manifest-resolver.ts` — reads all three, applies filter policy to both artists and queries

**Resolution flow:**
1. Resolve all artist/group entries in the filter language → union of IDs
2. Subtract ALL filter negatives from artist IDs (one HTTP request per negative token)
3. For each query: merge query positives with filter language + negatives → resolve via `resolveQuery`
4. Union steps 2 and 3

**Why three files:** Previously, exclusions were scattered: hardcoded `EXCLUDED_TAGS` in TS (only 2 tags), inline in `queries.txt` (35 tokens), missing from `sync.py`. A gallery tagged `female:scat` by a tracked artist would download. Now all exclusions live in `filters.txt` and apply everywhere. Adding an exclusion = one line, one file.

**No language override:** Language is fixed in `filters.txt`. Queries and artists do not specify language — it's inherited. This avoids conditional "which language wins" logic.

**Query format:** Search terms are namespace-delimited tokens, not whitespace-delimited words. Values use Hitomi/gallery-dl text directly: lowercase with spaces, no underscores and no quotes. A value continues until the next `namespace:` or `-namespace:` marker, so `female:big breasts female:cheating` is two tokens. Free text search is intentionally unsupported.

**sync.py:** Diagnostic-only dry-run tool (no `--queue`). It reads the manifest and accepts `--extra-query <query>` for hypothetical query checks without writing to watched manifest files. Do not edit `queries.txt` just to test a query while the downloader service is running; manifest changes trigger the real TS sync path. All queuing goes through the TS sync endpoint (`POST /sync` on port 11558). The systemd timer calls `curl -sk -X POST https://localhost:11558/sync`.

**Implication for removal:** A gallery can only be considered an orphan if it's local, matched by the removed entry, and no longer wanted by ANY remaining entry in EITHER file (with filters applied). Remove planning is evaluated against the local index DB, not against Hitomi's remote nozomi index.

## Remove endpoint: ownership boundaries

**Decision:** The remove orchestrator lives in the downloader. It computes WHAT to delete, then delegates actual deletion to the streamer via its existing `POST /api/delete` endpoint.

**Why:** The downloader owns manifest parsing, local retention planning, and diff computation. The streamer owns gallery deletion (directory removal, archive DB cleanup, index DB cleanup). The remove operation needs both — a readonly local plan to find orphans, then deletion to clean them up. Rather than duplicating the delete logic (two writers to the same DBs and files), the downloader calls the streamer's existing endpoint. This maintains single-writer ownership: the streamer is the only process that mutates gallery state on disk.

**Read-only exception:** The downloader reads the index DB (readonly) to get local gallery IDs for diffing — same pattern as `diff.ts`. Multiple readers are safe; only one writer (streamer).

## Remove endpoint: targeted orphan detection

**Decision:** Orphans are computed as `(removed entry's IDs) ∩ (local IDs) - (still wanted IDs)`, not `(local IDs) - (still wanted IDs)`.

**Why:** The naive approach (`local - still_wanted`) would delete galleries that were never in any manifest — e.g., manually downloaded galleries, or leftovers from a previously-removed entry. The targeted approach only touches galleries that the removed entry was specifically responsible for, intersected with what's actually on disk, minus anything still wanted by other entries. This is safe: it never deletes more than the removed entry contributed.

**Local planning:** Remove planning is local-only. The downloader evaluates the removed entry and the remaining manifest against the readonly index DB, then asks the streamer to delete only local orphans. Remote Hitomi resolution is reserved for sync/download discovery; it is not needed to decide whether already-local galleries should be retained.

**Counters:** `candidateCount` is local galleries matched by the removed entry. `retainedCount` is candidates still matched by the remaining manifest. `orphanCount` is candidates to delete. `deleteSkippedCount` means the streamer refused a requested delete; it does not mean "retained by manifest."

## Remove endpoint: file rollback on failure

**Decision:** The original file content is saved before modification. If resolution or deletion fails, the file is restored.

**Why:** The file modification happens before local orphan planning and deletion. If local planning or deletion fails, the entry would be removed from the manifest but its galleries could remain as permanent orphans — invisible to future removes. Rolling back means the user can retry after fixing the local failure.

## Remove endpoint: async with status polling

**Decision:** `POST /remove` returns immediately with `{ status: 'started' }`. Progress is polled via `GET /remove/status`.

**Why:** Deleting orphan directories can still take time when an entry uniquely owns many local galleries. The HTTP request returns immediately and progress is pollable while the downloader owns orchestration.

## Remove endpoint: journalctl logging

**Decision:** Happy-path journal lines include `start`, `removed line`, `planned local remove`, optional `deleting N orphans`, and `done`. Errors go to `console.error`. No progress ticks in journal — progress is pollable via `/remove/status`.

**Why:** The journal must answer "did it start, did it finish, did it crash mid-delete" at a glance. If the journal shows `start` then `deleting 343 orphans` but no `done` — poweroff during delete. If it shows `start` then an error — API or streamer failure. Mid-operation detail (resolved IDs, orphan math, commit success) is only useful during the operation and lives in the status endpoint.

## Remove endpoint: no remote resolution

**Decision:** Remove does not call Hitomi. It plans only from local indexed metadata.

**Why:** Sync/download discovery needs the remote nozomi index. Remove only decides whether local files should remain after a manifest entry is removed, so the local index DB is the authoritative read model. This avoids slow network-dependent "delete 0" operations and avoids treating remote API failures as local retention uncertainty.

## Local superset: disk is the source of truth

**Decision:** Once a gallery is downloaded, it stays forever — unless it has a filter-negative tag. Galleries deindexed from hitomi's nozomi are kept. The local collection is a superset of hitomi.

**Why:** Hitomi's nozomi index rotates — galleries by tracked artists disappear from the API over time. The whole point of local storage is preserving what hitomi doesn't. Deletion is only for policy violations (filter-negative tags), never for "hitomi no longer lists it."

**Cleanup rule:** A local gallery is removed ONLY if it has a filter-negative tag. The wanted set from nozomi determines what to download, not what to keep.

## Salvaged metadata 404s: manual backup queue

**Decision:** A local salvaged gallery whose Hitomi metadata JS returns HTTP 404 is preserved and written to `gallery-server/salvaged-metadata-missing.txt`. The salvaged updater must not fail the whole timer run for this case, and must not delete the gallery automatically.

**Why:** Hitomi gallery HTML pages are shell pages. They can return HTTP 200 while dynamically loading `https://ltn.gold-usergeneratedcontent.net/galleries/<id>.js`; if that metadata JS returns 404, Hitomi's own frontend shows a 404 for the gallery. This means the local gallery is genuinely salvaged/preserved content rather than a normal alias that can be resolved from metadata.

**Alias distinction:** Normal alias handling still requires readable metadata: if `<old>.js` exists and contains a different `id`, the updater can classify it as alias-local or alias-missing. A metadata 404 has no canonical ID to compare, so it is surfaced for manual backup instead.

**Example:** On 2026-05-04, gallery `3881533` existed locally but `https://ltn.gold-usergeneratedcontent.net/galleries/3881533.js` returned HTTP 404. The gallery was zipped manually to `~/Downloads/hitomi-3881533-salvaged.zip`; future cases should appear in `salvaged-metadata-missing.txt`.

## Filter policy cleanup: local enforcement

**Decision:** `filters.txt` is enforced in two places: remote resolution prevents future downloads, and downloader-owned policy cleanup removes already-local violations. Cleanup reads the index DB in readonly mode to find local galleries whose indexed columns/tags match filter negatives, then delegates deletion to the streamer through `POST /api/delete`.

**Why:** Sync answers "what should be downloaded next"; it is not enough to enforce "what is allowed to remain local." Existing galleries can become invalid when a new negative filter is added. The downloader owns manifest policy and cleanup orchestration, while the streamer remains the single writer for disk, archive DB, and index DB deletion.

**Status/logging:** Policy cleanup logs `start`, `deleting N policy violations`, and `done/error` under `[policy-cleanup]`. It runs after sync and once on downloader startup, and can be triggered manually through `POST /policy-cleanup`. `GET /policy-cleanup/status` exposes the current phase and counts.

**Queue hygiene:** After resolving the current manifest, sync prunes queued gallery URLs whose IDs are no longer wanted. This handles queues restored from before a filter change. An already-active download is allowed to finish and is then checked by the post-download validator.

## Sync preflight policy gate

**Decision:** Sync-discovered downloads must be classified before they enter the queue. The resolver produces wanted IDs, the diff engine produces candidates, the metadata fetcher reads Hitomi gallery metadata, `policy.ts` classifies each candidate as allowed or rejected, and the queue accepts only `AllowedGallery` jobs.

**Why:** Hitomi's Nozomi indexes can claim an ID belongs to `language:japanese` while the gallery metadata says another language. Downloading first and deleting after wastes bandwidth and disk churn. The queue should own execution order, not admissibility policy. Invalid sync work is rejected before `gallery-dl` starts.

**Backstop:** The post-download validator remains as a defensive invariant check for stale metadata, manual queue paths, or upstream changes.

## Post-download validation: language check

**Decision:** After gallery-dl completes a download, the queue manager calls a validator. The validator reads `info.json` and checks `language` plus filter negatives against the current filter policy. Mismatch or excluded tag/series/etc. → gallery is deleted immediately.

**Why:** Hitomi's nozomi URL includes the language (`artist/name-japanese.nozomi`), but the API sometimes returns non-japanese gallery IDs. gallery-dl downloads whatever ID it's given. Without validation, wrong-language galleries accumulate (~3 out of ~13000 historically). The check is at the download boundary — where external data enters the system.

**Ownership:** The queue manager owns the post-download hook (`setValidator`). `main.ts` provides the validator closure with the filter language. The queue manager doesn't know about filters or info.json — it just calls the function.

## Single-gallery indexing on download completion

**Decision:** After each successful download + validation, the downloader notifies the indexer via `POST /index/:id`. The indexer runs the Go scanner in single-gallery mode and updates the DB. The gallery appears on the frontend immediately.

**Why:** Previously, galleries sat unindexed until the daily full scan. With thousands of galleries queuing, this meant hours/days before new downloads appeared in the UI. Single-gallery indexing takes ~13ms per gallery.

**Ownership:**
- Queue manager fires `onComplete(galleryId)` callback — doesn't know about the indexer
- `main.ts` wires the callback to an HTTP call to the indexer
- Indexer owns all index DB writes (single writer preserved)
- Go scanner handles both modes: full walk (daily safety net) and single-gallery (per-download)

**Daily scan remains:** The full scan at startup and via `gallery-refresh.timer` catches strays from crashes, power loss, or manual file operations. Single-gallery indexing is the primary path; full scan is the safety net.

## Archive DB is gallery-dl's concern

**Decision:** The archive DB (`hitomi.sqlite3`) is owned entirely by gallery-dl. The app never writes to it. Inconsistencies in the archive (e.g., unarchived galleries) are gallery-dl's problem to self-correct on next encounter.

**Why:** The archive DB's format and semantics are internal to gallery-dl. Writing to it would couple the app to gallery-dl's implementation details. The app's source of truth is the disk (files exist or they don't) and the index DB (what's searchable). The archive only affects download efficiency, not correctness.
