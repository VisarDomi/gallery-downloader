/**
 * Diff engine: compares wanted IDs against local state.
 *
 * Read-only access to provider files. Produces a list of IDs to download.
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
    const provider = path.basename(galleryRoot);
    try {
        for (const f of fs.readdirSync(galleryRoot)) {
            if (f.startsWith('.downloading-')) {
                const id = parseInt(f.slice('.downloading-'.length), 10);
                if (!isNaN(id)) staleMarkers.add(id);
                continue;
            }
            if (/^\d+$/.test(f) && fs.existsSync(path.join(galleryRoot, f, 'info.json'))) {
                localIds.add(Number(f));
                if (['hitomi', 'imhentai'].includes(provider)) {
                    const names = fs.readdirSync(path.join(galleryRoot, f));
                    const info = JSON.parse(fs.readFileSync(path.join(galleryRoot, f, 'info.json'), 'utf8'));
                    const originals = names.filter(n => new RegExp(`^${provider}_${f}_\\d+\\.(webp|avif|jpe?g|png|gif)$`, 'i').test(n));
                    const thumbnails = new Set(names.map(n => n.match(new RegExp(`^${provider}_${f}_thumb_(\\d+)\\.(webp|avif|jpe?g|png|gif)$`, 'i'))?.[1]).filter(Boolean));
                    const count = Number(info.count);
                    const complete = originals.length > 0 && (!count || originals.length === count || provider === 'hitomi' && originals.length * 2 === count);
                    if (!complete || originals.some(n => !thumbnails.has(n.match(/_(\d+)\.[^.]+$/)![1]))) staleMarkers.add(Number(f));
                }
            }
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

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
