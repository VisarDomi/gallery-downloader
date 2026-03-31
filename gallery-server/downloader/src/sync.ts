/**
 * Sync orchestrator: ties resolver, diff, and queue together.
 *
 * Reads manifests → resolves IDs from hitomi → diffs against local → feeds queue.
 * Single writer to the queue. All other access is read-only.
 */

import path from 'path';
import { loadManifest } from './manifest.js';
import { resolveArtistEntry, resolveQuery, resolveTag } from './resolver.js';
import { computeDiff } from './diff.js';
import { queueManager } from './queue.manager.js';
import { socketService } from './socket.service.js';
import { CONFIG } from './config.js';
import { hitomi } from 'gallery-sources';

const GALLERY_ROOT = path.join(CONFIG.WORKING_DIR, hitomi.gallerySubdir);
const INDEX_DB_PATH = path.join(CONFIG.WORKING_DIR, 'gallery-dl', 'gallery-index.db');

export interface SyncStatus {
    phase: 'idle' | 'resolving-artists' | 'resolving-queries' | 'diffing' | 'done';
    artistsResolved: number;
    artistsTotal: number;
    queriesResolved: number;
    queriesTotal: number;
    wantedCount: number;
    newCount: number;
    resumeCount: number;
    alreadyLocalCount: number;
    errors: string[];
}

let currentSync: SyncStatus = {
    phase: 'idle',
    artistsResolved: 0, artistsTotal: 0,
    queriesResolved: 0, queriesTotal: 0,
    wantedCount: 0, newCount: 0, resumeCount: 0, alreadyLocalCount: 0,
    errors: [],
};

let syncRunning = false;

export function getSyncStatus(): SyncStatus {
    return { ...currentSync };
}

function log(msg: string) {
    console.log(`[sync] ${msg}`);
    socketService.emitLog(`[sync] ${msg}\n`);
}

function resetStatus(artistsTotal: number, queriesTotal: number): void {
    currentSync = {
        phase: 'resolving-artists',
        artistsResolved: 0, artistsTotal,
        queriesResolved: 0, queriesTotal,
        wantedCount: 0, newCount: 0, resumeCount: 0, alreadyLocalCount: 0,
        errors: [],
    };
}

export async function runSync(artistsPath: string, queriesPath: string): Promise<SyncStatus> {
    if (syncRunning) {
        log('Sync already running, skipping.');
        return currentSync;
    }

    syncRunning = true;

    try {
        const manifest = loadManifest(artistsPath, queriesPath);
        resetStatus(manifest.artists.length, manifest.queries.length);

        log(`Loaded manifest: ${manifest.artists.length} artist entries, ${manifest.queries.length} queries`);

        // Phase 1: Resolve artist entries
        const wantedIds = new Set<number>();

        currentSync.phase = 'resolving-artists';
        for (const entry of manifest.artists) {
            const result = await resolveArtistEntry(entry.namespace, entry.value, entry.language);
            for (const id of result.ids) wantedIds.add(id);
            currentSync.errors.push(...result.errors);
            currentSync.artistsResolved++;

            if (currentSync.artistsResolved % 20 === 0) {
                log(`Artists: ${currentSync.artistsResolved}/${currentSync.artistsTotal} (${wantedIds.size} IDs so far)`);
            }
        }

        log(`Artists resolved: ${wantedIds.size} unique IDs from ${manifest.artists.length} entries`);

        // Phase 1b: Subtract excluded tags from artist IDs
        const EXCLUDED_TAGS = ['tag:anthology', 'tag:animated'];
        for (const tag of EXCLUDED_TAGS) {
            const result = await resolveTag(tag, 'japanese');
            if (result.errors.length > 0) {
                currentSync.errors.push(...result.errors);
            } else {
                const before = wantedIds.size;
                for (const id of result.ids) wantedIds.delete(id);
                log(`${tag} filter: ${before - wantedIds.size} removed (${wantedIds.size} remaining)`);
            }
        }

        // Phase 2: Resolve query entries
        currentSync.phase = 'resolving-queries';
        for (const entry of manifest.queries) {
            const result = await resolveQuery(entry.raw);
            for (const id of result.ids) wantedIds.add(id);
            currentSync.errors.push(...result.errors);
            currentSync.queriesResolved++;
            log(`Query ${currentSync.queriesResolved}/${currentSync.queriesTotal}: +${result.ids.size} IDs (${wantedIds.size} total)`);
        }

        currentSync.wantedCount = wantedIds.size;
        log(`Total wanted: ${wantedIds.size} unique IDs`);

        // Phase 3: Diff against local
        currentSync.phase = 'diffing';
        const diff = computeDiff(wantedIds, INDEX_DB_PATH, GALLERY_ROOT);

        currentSync.newCount = diff.toDownload.length;
        currentSync.resumeCount = diff.toResume.length;
        currentSync.alreadyLocalCount = diff.alreadyLocal;

        log(`Diff: ${diff.toDownload.length} new, ${diff.toResume.length} to resume, ${diff.alreadyLocal} already local`);

        // Phase 4: Feed the queue (resume first, then new)
        const allIds = [...diff.toResume, ...diff.toDownload];
        if (allIds.length > 0) {
            queueManager.appendQueue(allIds);
            log(`Queued ${allIds.length} galleries for download`);
        } else {
            log('Nothing to download — up to date');
        }

        currentSync.phase = 'done';

        if (currentSync.errors.length > 0) {
            log(`Completed with ${currentSync.errors.length} errors`);
        }

        return currentSync;
    } finally {
        syncRunning = false;
    }
}
