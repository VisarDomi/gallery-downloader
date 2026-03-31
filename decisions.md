# Architecture Decisions

## Sync model: artists.txt and queries.txt are unioned

**Decision:** `artists.txt` and `queries.txt` are the two sources of truth for what galleries to download. Sync resolves both independently and takes their union — a gallery is wanted if it matches ANY artist entry OR ANY query.

**Why:** Artists and queries serve different purposes. Artists track a creator's full catalog. Queries find galleries matching complex tag filters regardless of creator. The union means each file is self-contained.

**Anthology exclusion:** After artist IDs are resolved, the sync orchestrator subtracts all `tag:anthology` IDs (japanese language, hardcoded). This is a sync-level policy — the resolver stays pure. Anthologies are multi-artist compilations that bloat disk usage (56% of storage for 18% of galleries) while the individual works by tracked artists are already captured. `queries.txt` independently excludes anthologies via its own `-tag:anthology` token.

**Implication for removal:** A gallery can only be considered an orphan if it's no longer wanted by ANY entry in EITHER file. Removing an artist doesn't orphan galleries that a query still matches, and vice versa. The remove endpoint must re-resolve the entire remaining manifest (both files) to compute the still-wanted set before it can safely identify orphans.

## Remove endpoint: ownership boundaries

**Decision:** The remove orchestrator lives in the downloader. It computes WHAT to delete, then delegates actual deletion to the streamer via its existing `POST /api/delete` endpoint.

**Why:** The downloader owns manifest parsing, hitomi resolution, and diff computation. The streamer owns gallery deletion (directory removal, archive DB cleanup, index DB cleanup). The remove operation needs both — resolution to find orphans, then deletion to clean them up. Rather than duplicating the delete logic (two writers to the same DBs and files), the downloader calls the streamer's existing endpoint. This maintains single-writer ownership: the streamer is the only process that mutates gallery state on disk.

**Read-only exception:** The downloader reads the index DB (readonly) to get local gallery IDs for diffing — same pattern as `diff.ts`. Multiple readers are safe; only one writer (streamer).

## Remove endpoint: targeted orphan detection

**Decision:** Orphans are computed as `(removed entry's IDs) ∩ (local IDs) - (still wanted IDs)`, not `(local IDs) - (still wanted IDs)`.

**Why:** The naive approach (`local - still_wanted`) would delete galleries that were never in any manifest — e.g., manually downloaded galleries, or leftovers from a previously-removed entry. The targeted approach only touches galleries that the removed entry was specifically responsible for, intersected with what's actually on disk, minus anything still wanted by other entries. This is safe: it never deletes more than the removed entry contributed.

## Remove endpoint: file rollback on failure

**Decision:** The original file content is saved before modification. If resolution or deletion fails, the file is restored.

**Why:** The file modification (step 3) happens before the slow re-resolve (step 4). If resolution fails (hitomi API down, network error), we can't determine orphans. Without rollback, the entry would be removed from the manifest but its galleries would remain on disk as permanent orphans — invisible to future removes. Rolling back means the user can retry when the API is available.

## Remove endpoint: async with status polling

**Decision:** `POST /remove` returns immediately with `{ status: 'started' }`. Progress is polled via `GET /remove/status`.

**Why:** Re-resolving the full remaining manifest requires ~200 HTTP requests to hitomi with 100ms delays — roughly 20 seconds minimum. A synchronous HTTP request would time out or block the UI.

## Remove endpoint: journalctl logging

**Decision:** Only three log lines in the happy path: `start`, `deleting N orphans`, `done`. Errors go to `console.error`. No progress ticks in journal — progress is pollable via `/remove/status`.

**Why:** The journal must answer "did it start, did it finish, did it crash mid-delete" at a glance. If the journal shows `start` then `deleting 343 orphans` but no `done` — poweroff during delete. If it shows `start` then an error — API or streamer failure. Mid-operation detail (resolved IDs, orphan math, commit success) is only useful during the operation and lives in the status endpoint.

## Remove endpoint: abort on partial resolution failure

**Decision:** If any artist/query resolution fails during the re-resolve step, abort the entire operation, log each failure to journalctl, and roll back the file change. Never proceed to deletion with an incomplete wanted set.

**Why:** The resolver swallows HTTP errors and returns empty sets for failed entries. An incomplete wanted set means galleries that ARE still wanted could appear as orphans and get deleted. This is silent data loss. The only safe response to a flaky hitomi API is to refuse to delete and let the user retry later.
