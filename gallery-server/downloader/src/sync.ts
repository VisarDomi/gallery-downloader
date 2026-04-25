/**
 * Sync orchestrator: ties manifest resolution, diff, and queue together.
 *
 * Delegates ID resolution to manifest-resolver (single owner of that policy).
 * Owns: diffing against local, feeding the queue, progress reporting.
 */

import path from 'path';
import { resolveManifest } from './manifest-resolver.js';
import { computeDiff } from './diff.js';
import { queueManager } from './queue.manager.js';
import { socketService } from './socket.service.js';
import { CONFIG } from './config.js';
import { hitomi } from 'gallery-sources';
import { runPolicyCleanup, type PolicyCleanupStatus } from './policy.js';

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
    cleanup: PolicyCleanupStatus;
    errors: string[];
}

let currentSync: SyncStatus = {
    phase: 'idle',
    artistsResolved: 0, artistsTotal: 0,
    queriesResolved: 0, queriesTotal: 0,
    wantedCount: 0, newCount: 0, resumeCount: 0, alreadyLocalCount: 0,
    cleanup: {
        phase: 'idle',
        filterCount: 0,
        violationCount: 0,
        deletedCount: 0,
        skippedCount: 0,
        error: null,
    },
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

export async function runSync(filtersPath: string, artistsPath: string, queriesPath: string): Promise<SyncStatus> {
    if (syncRunning) {
        log('Sync already running, skipping.');
        return currentSync;
    }

    syncRunning = true;

    try {
        currentSync = {
            phase: 'resolving-artists',
            artistsResolved: 0, artistsTotal: 0,
            queriesResolved: 0, queriesTotal: 0,
            wantedCount: 0, newCount: 0, resumeCount: 0, alreadyLocalCount: 0,
            cleanup: {
                phase: 'idle',
                filterCount: 0,
                violationCount: 0,
                deletedCount: 0,
                skippedCount: 0,
                error: null,
            },
            errors: [],
        };

        const resolution = await resolveManifest(filtersPath, artistsPath, queriesPath, {
            onArtistResolved: (resolved, total, idsSoFar) => {
                currentSync.artistsResolved = resolved;
                currentSync.artistsTotal = total;
                if (resolved % 20 === 0) {
                    log(`Artists: ${resolved}/${total} (${idsSoFar} IDs so far)`);
                }
            },
            onTagExcluded: (tag, removed, remaining) => {
                log(`${tag} filter: ${removed} removed (${remaining} remaining)`);
            },
            onQueryResolved: (resolved, total, queryIds, totalIds) => {
                currentSync.phase = 'resolving-queries';
                currentSync.queriesResolved = resolved;
                currentSync.queriesTotal = total;
                log(`Query ${resolved}/${total}: +${queryIds} IDs (${totalIds} total)`);
            },
        });

        currentSync.errors.push(...resolution.errors);
        currentSync.wantedCount = resolution.wantedIds.size;

        log(`Loaded manifest: ${resolution.artistCount} artist entries, ${resolution.queryCount} queries`);
        log(`Total wanted: ${resolution.wantedIds.size} unique IDs`);

        const pruned = queueManager.retainQueuedGalleryIds(resolution.wantedIds);
        if (pruned > 0) {
            log(`Pruned ${pruned} queued galleries excluded by current policy`);
        }

        // Diff against local
        currentSync.phase = 'diffing';
        const diff = computeDiff(resolution.wantedIds, INDEX_DB_PATH, GALLERY_ROOT);

        currentSync.newCount = diff.toDownload.length;
        currentSync.resumeCount = diff.toResume.length;
        currentSync.alreadyLocalCount = diff.alreadyLocal;

        log(`Diff: ${diff.toDownload.length} new, ${diff.toResume.length} to resume, ${diff.alreadyLocal} already local`);

        // Feed the queue (resume first, then new)
        const allIds = [...diff.toResume, ...diff.toDownload];
        if (allIds.length > 0) {
            queueManager.appendQueue(allIds);
            log(`Queued ${allIds.length} galleries for download`);
        } else {
            log('Nothing to download — up to date');
        }

        const cleanup = await runPolicyCleanup(filtersPath, artistsPath, queriesPath, INDEX_DB_PATH);
        currentSync.cleanup = cleanup.status;
        if (cleanup.kind === 'error') {
            currentSync.errors.push(cleanup.status.error ?? 'policy cleanup failed');
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
