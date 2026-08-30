/**
 * Diff engine: compares wanted IDs against local state.
 *
 * Read-only access to the index DB. Produces a list of IDs to download.
 * Also detects partial downloads (stale .downloading-* markers).
 */

import fs from 'fs';
import path from 'path';

export interface DiffResult {
    toDownload: number[];   // IDs not on disk at all
    toResume: number[];     // IDs with stale .downloading-* markers
    alreadyLocal: number;   // count of IDs already fully downloaded
    unwantedLocal: number[]; // local IDs outside the current manifest
}

export function computeDiff(
    wantedIds: Set<number>,
    galleryRoot: string,
): DiffResult {
    const localIds = new Set<number>();
    const staleMarkers = new Set<number>();
    try {
        for (const f of fs.readdirSync(galleryRoot)) {
            if (f.startsWith('.downloading-')) {
                const id = parseInt(f.slice('.downloading-'.length), 10);
                if (!isNaN(id)) staleMarkers.add(id);
                continue;
            }
            if (/^\d+$/.test(f) && fs.existsSync(path.join(galleryRoot, f, 'info.json'))) {
                localIds.add(Number(f));
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
