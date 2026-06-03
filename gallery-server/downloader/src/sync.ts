/**
 * Sync orchestrator: ties manifest resolution, diff, and queue together.
 *
 * Delegates ID resolution to manifest-resolver (single owner of that policy).
 * Owns: diffing against local, feeding the queue, progress reporting.
 */

import path from 'path';
import { loadManifest } from './manifest.js';
import { resolveManifest } from './manifest-resolver.js';
import { computeDiff } from './diff.js';
import { queueManager } from './queue.manager.js';
import { socketService } from './socket.service.js';
import { CONFIG } from './config.js';
import { hitomi } from 'gallery-sources';
import { buildFilterPolicy, classifyCandidateGallery, runPolicyCleanup, type PolicyCleanupStatus } from './policy.js';
import { candidateFromId, type AllowedGallery, type CandidateGallery, type RejectedGallery } from './gallery-job.js';
import { fetchHitomiGalleryInfo } from './hitomi-metadata.js';
import { requestDeletion } from './deletion-client.js';

const GALLERY_ROOT = path.join(CONFIG.WORKING_DIR, hitomi.gallerySubdir);
const INDEX_DB_PATH = path.join(CONFIG.WORKING_DIR, 'gallery-dl', 'gallery-index.db');
const UNWANTED_REMOTE_CHECK_CONCURRENCY = 8;

export interface SyncStatus {
    phase: 'idle' | 'resolving-artists' | 'resolving-queries' | 'diffing' | 'classifying' | 'done';
    artistsResolved: number;
    artistsTotal: number;
    queriesResolved: number;
    queriesTotal: number;
    wantedCount: number;
    newCount: number;
    resumeCount: number;
    alreadyLocalCount: number;
    allowedCount: number;
    rejectedCount: number;
    metadataErrorCount: number;
    unwantedLocalCount: number;
    unwantedRemoteExistingCount: number;
    unwantedRetainedCount: number;
    unwantedDeletedCount: number;
    unwantedSkippedCount: number;
    cleanup: PolicyCleanupStatus;
    errors: string[];
}

let currentSync: SyncStatus = {
    phase: 'idle',
    artistsResolved: 0, artistsTotal: 0,
    queriesResolved: 0, queriesTotal: 0,
    wantedCount: 0, newCount: 0, resumeCount: 0, alreadyLocalCount: 0, allowedCount: 0, rejectedCount: 0, metadataErrorCount: 0,
    unwantedLocalCount: 0, unwantedRemoteExistingCount: 0, unwantedRetainedCount: 0, unwantedDeletedCount: 0, unwantedSkippedCount: 0,
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

async function cleanupUnwantedLocal(unwantedIds: number[]): Promise<{
    remoteExisting: number;
    retained: number;
    deleted: number;
    skipped: number;
}> {
    if (unwantedIds.length === 0) {
        log('Unwanted-local cleanup: nothing to check');
        return { remoteExisting: 0, retained: 0, deleted: 0, skipped: 0 };
    }

    const remoteExistingIds: number[] = [];
    let retained = 0;
    let cursor = 0;
    let checked = 0;
    let nextLogAt = 100;

    async function worker() {
        while (true) {
            const index = cursor++;
            if (index >= unwantedIds.length) return;

            const id = unwantedIds[index];
            const metadata = await fetchHitomiGalleryInfo(id);
            if (metadata.kind === 'ok') {
                remoteExistingIds.push(id);
            } else {
                retained++;
            }

            checked++;
            currentSync.unwantedRemoteExistingCount = remoteExistingIds.length;
            currentSync.unwantedRetainedCount = retained;

            if (checked >= nextLogAt || checked === unwantedIds.length) {
                log(`Unwanted-local: ${checked}/${unwantedIds.length} checked (${remoteExistingIds.length} remote-existing, ${retained} retained)`);
                nextLogAt += 100;
            }
        }
    }

    const workerCount = Math.min(UNWANTED_REMOTE_CHECK_CONCURRENCY, unwantedIds.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (remoteExistingIds.length === 0) {
        log(`Unwanted-local cleanup: retained ${retained}, nothing to delete`);
        return { remoteExisting: 0, retained, deleted: 0, skipped: 0 };
    }

    log(`Unwanted-local cleanup: deleting ${remoteExistingIds.length} remote-existing galleries, retaining ${retained} missing-upstream galleries`);
    const result = await requestDeletion(remoteExistingIds);
    for (const skipped of result.skipped) {
        log(`Unwanted-local skip ${skipped.id}: ${skipped.reason}`);
    }

    log(`Unwanted-local cleanup: done ${result.deleted.length} deleted, ${result.skipped.length} skipped`);
    return {
        remoteExisting: remoteExistingIds.length,
        retained,
        deleted: result.deleted.length,
        skipped: result.skipped.length,
    };
}

function log(msg: string) {
    console.log(`[sync] ${msg}`);
    socketService.emitLog(`[sync] ${msg}\n`);
}

async function classifyCandidates(
    candidates: CandidateGallery[],
    filtersPath: string,
    artistsPath: string,
    queriesPath: string,
): Promise<{ allowed: AllowedGallery[]; rejected: RejectedGallery[]; metadataErrors: number }> {
    const policy = buildFilterPolicy(loadManifest(filtersPath, artistsPath, queriesPath).filters);
    const allowed: AllowedGallery[] = [];
    const rejected: RejectedGallery[] = [];
    let metadataErrors = 0;

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const metadata = await fetchHitomiGalleryInfo(candidate.id);

        if (metadata.kind === 'error') {
            metadataErrors++;
            rejected.push({
                kind: 'rejected',
                id: candidate.id,
                url: candidate.url,
                reason: `metadata preflight failed: ${metadata.error}`,
            });
        } else {
            const classified = classifyCandidateGallery(candidate, metadata.info, policy);
            if (classified.kind === 'allowed') {
                allowed.push(classified);
            } else {
                rejected.push(classified);
            }
        }

        if ((i + 1) % 20 === 0 || i + 1 === candidates.length) {
            log(`Preflight: ${i + 1}/${candidates.length} checked (${allowed.length} allowed, ${rejected.length} rejected)`);
        }
    }

    return { allowed, rejected, metadataErrors };
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
            wantedCount: 0, newCount: 0, resumeCount: 0, alreadyLocalCount: 0, allowedCount: 0, rejectedCount: 0, metadataErrorCount: 0,
            unwantedLocalCount: 0, unwantedRemoteExistingCount: 0, unwantedRetainedCount: 0, unwantedDeletedCount: 0, unwantedSkippedCount: 0,
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
        currentSync.unwantedLocalCount = diff.unwantedLocal.length;

        log(`Diff: ${diff.toDownload.length} new, ${diff.toResume.length} to resume, ${diff.alreadyLocal} already local, ${diff.unwantedLocal.length} unwanted local`);

        const allIds = [...diff.toResume, ...diff.toDownload];
        if (allIds.length > 0) {
            currentSync.phase = 'classifying';
            const classified = await classifyCandidates(allIds.map(candidateFromId), filtersPath, artistsPath, queriesPath);
            currentSync.allowedCount = classified.allowed.length;
            currentSync.rejectedCount = classified.rejected.length;
            currentSync.metadataErrorCount = classified.metadataErrors;

            for (const rejected of classified.rejected) {
                log(`Preflight rejected ${rejected.id}: ${rejected.reason}`);
            }

            queueManager.appendAllowed(classified.allowed);
            log(`Queued ${classified.allowed.length} allowed galleries for download`);
        } else {
            log('Nothing to download — up to date');
        }

        const unwantedCleanup = await cleanupUnwantedLocal(diff.unwantedLocal);
        currentSync.unwantedRemoteExistingCount = unwantedCleanup.remoteExisting;
        currentSync.unwantedRetainedCount = unwantedCleanup.retained;
        currentSync.unwantedDeletedCount = unwantedCleanup.deleted;
        currentSync.unwantedSkippedCount = unwantedCleanup.skipped;

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
