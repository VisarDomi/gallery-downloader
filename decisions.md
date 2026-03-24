# Architecture Decisions

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
