/**
 * Diff engine: compares wanted IDs against local state.
 *
 * Read-only access to the index DB. Produces a list of IDs to download.
 * Also detects partial downloads (stale .downloading-* markers).
 */

import Database from 'better-sqlite3';
import fs from 'fs';

export interface DiffResult {
    toDownload: number[];   // IDs not on disk at all
    toResume: number[];     // IDs with stale .downloading-* markers
    alreadyLocal: number;   // count of IDs already fully downloaded
    unwantedLocal: number[]; // local IDs outside the current manifest
}

export function computeDiff(
    wantedIds: Set<number>,
    indexDbPath: string,
    galleryRoot: string,
): DiffResult {
    // Read all local gallery IDs from index DB
    const localIds = new Set<number>();
    if (fs.existsSync(indexDbPath)) {
        const db = new Database(indexDbPath, { readonly: true });
        db.pragma('journal_mode = WAL');
        const rows = db.prepare('SELECT gallery_id FROM galleries').all() as { gallery_id: number }[];
        for (const row of rows) {
            localIds.add(row.gallery_id);
        }
        db.close();
    }

    // Find stale .downloading-* markers (leftover from power failure)
    const staleMarkers = new Set<number>();
    try {
        for (const f of fs.readdirSync(galleryRoot)) {
            if (f.startsWith('.downloading-')) {
                const id = parseInt(f.slice('.downloading-'.length), 10);
                if (!isNaN(id)) staleMarkers.add(id);
            }
        }
    } catch { /* galleryRoot doesn't exist yet */ }

    const toDownload: number[] = [];
    const toResume: number[] = [];
    let alreadyLocal = 0;

    for (const id of wantedIds) {
        if (staleMarkers.has(id)) {
            // Partial download from a previous crash — re-queue
            toResume.push(id);
        } else if (localIds.has(id)) {
            alreadyLocal++;
        } else {
            toDownload.push(id);
        }
    }

    const unwantedLocal = [...localIds]
        .filter((id) => !wantedIds.has(id) && !staleMarkers.has(id))
        .sort((a, b) => a - b);

    return { toDownload, toResume, alreadyLocal, unwantedLocal };
}
