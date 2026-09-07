import path from 'node:path';
import type { Source, SourceId } from 'gallery-sources';
import { CONFIG } from './config.js';
import { computeDiff } from './diff.js';
import {
    cleanupRetiredGalleryDirectories,
    deleteGalleries,
} from './gallery-delete.js';
import { candidateFromId } from './gallery-job.js';
import { readFavorites } from './favorites-store.js';
import { queueManager } from './queue.manager.js';
import { socketService } from './socket.service.js';

export interface FavoritesSyncStatus {
    phase: 'idle' | 'diffing' | 'queueing' | 'done' | 'error';
    wantedCount: number;
    queuedCount: number;
    alreadyLocalCount: number;
    unwantedLocalCount: number;
    error: string | null;
    finishedAt: string | null;
}

export interface FavoritesReconcileStatus {
    phase: 'idle' | 'diffing' | 'deleting' | 'done' | 'error';
    wantedCount: number;
    unwantedLocalCount: number;
    deletedCount: number;
    skippedCount: number;
    error: string | null;
    finishedAt: string | null;
}

export class FavoritesSyncController {
    private readonly provider: SourceId;
    private readonly galleryRoot: string;
    private syncRunning = false;
    private syncRequested = false;
    private reconcileRunning = false;
    private syncStatus: FavoritesSyncStatus = {
        phase: 'idle', wantedCount: 0, queuedCount: 0, alreadyLocalCount: 0,
        unwantedLocalCount: 0, error: null, finishedAt: null,
    };
    private reconcileStatus: FavoritesReconcileStatus = {
        phase: 'idle', wantedCount: 0, unwantedLocalCount: 0, deletedCount: 0,
        skippedCount: 0, error: null, finishedAt: null,
    };

    constructor(source: Source) {
        this.provider = source.id as SourceId;
        this.galleryRoot = path.join(CONFIG.WORKING_DIR, source.gallerySubdir);
    }

    private log(message: string): void {
        const line = `[favorites:${this.provider}] ${message}`;
        console.log(line);
        socketService.emitLog(`${line}\n`);
    }

    public getSyncStatus(): FavoritesSyncStatus {
        return { ...this.syncStatus };
    }

    public getReconcileStatus(): FavoritesReconcileStatus {
        return { ...this.reconcileStatus };
    }

    private async syncOnce(favoritesPath: string): Promise<void> {
        const snapshot = readFavorites(favoritesPath, this.provider);
        if (snapshot.updatedAt === null) {
            this.syncStatus = {
                phase: 'done', wantedCount: 0, queuedCount: 0, alreadyLocalCount: 0,
                unwantedLocalCount: 0, error: null, finishedAt: new Date().toISOString(),
            };
            this.log('no authoritative snapshot received yet; existing queue left unchanged');
            return;
        }
        const wantedIds = new Set(snapshot.ids);
        this.syncStatus = {
            phase: 'diffing', wantedCount: wantedIds.size, queuedCount: 0,
            alreadyLocalCount: 0, unwantedLocalCount: 0, error: null, finishedAt: null,
        };

        const prunedCount = queueManager.retainQueuedGalleryIds(this.provider, wantedIds);
        const diff = computeDiff(wantedIds, this.galleryRoot);
        this.syncStatus.alreadyLocalCount = diff.alreadyLocal;
        this.syncStatus.unwantedLocalCount = diff.unwantedLocal.length;
        this.syncStatus.phase = 'queueing';
        const candidates = [...diff.toResume, ...diff.toDownload]
            .map(id => candidateFromId(this.provider, id));
        this.syncStatus.queuedCount = queueManager.append(candidates);
        queueManager.start();
        this.syncStatus.phase = 'done';
        this.syncStatus.finishedAt = new Date().toISOString();
        this.log(`${wantedIds.size} wanted, ${this.syncStatus.queuedCount} queued, ${diff.alreadyLocal} local, ${prunedCount} stale queue entries pruned`);
    }

    private async drainSyncRequests(favoritesPath: string): Promise<void> {
        if (this.syncRunning) return;
        this.syncRunning = true;
        try {
            while (this.syncRequested) {
                this.syncRequested = false;
                try {
                    await this.syncOnce(favoritesPath);
                } catch (error) {
                    this.syncStatus.phase = 'error';
                    this.syncStatus.error = String((error as Error)?.message ?? error);
                    this.syncStatus.finishedAt = new Date().toISOString();
                    console.error(`[favorites:${this.provider}] sync failed`, error);
                }
            }
        } finally {
            this.syncRunning = false;
        }
    }

    public requestSync(favoritesPath: string): void {
        this.syncRequested = true;
        void this.drainSyncRequests(favoritesPath);
    }

    public async reconcile(favoritesPath: string): Promise<FavoritesReconcileStatus> {
        if (this.reconcileRunning) return this.getReconcileStatus();
        this.reconcileRunning = true;
        try {
            const snapshot = readFavorites(favoritesPath, this.provider);
            if (snapshot.updatedAt === null) {
                throw new Error('refusing reconcile before the first favorites snapshot has been received');
            }
            const wantedIds = new Set(snapshot.ids);
            this.reconcileStatus = {
                phase: 'diffing', wantedCount: wantedIds.size, unwantedLocalCount: 0,
                deletedCount: 0, skippedCount: 0, error: null, finishedAt: null,
            };
            queueManager.retainQueuedGalleryIds(this.provider, wantedIds);
            cleanupRetiredGalleryDirectories(this.galleryRoot);
            const diff = computeDiff(wantedIds, this.galleryRoot);
            const unwantedIds = diff.unwantedLocal;
            this.reconcileStatus.unwantedLocalCount = unwantedIds.length;
            if (unwantedIds.length > 0) {
                this.reconcileStatus.phase = 'deleting';
                const result = deleteGalleries(this.provider, unwantedIds);
                this.reconcileStatus.deletedCount = result.deleted.length;
                this.reconcileStatus.skippedCount = result.skipped.length;
            }
            this.reconcileStatus.phase = 'done';
            this.reconcileStatus.finishedAt = new Date().toISOString();
            this.log(`manual reconcile done: ${this.reconcileStatus.deletedCount} deleted, ${this.reconcileStatus.skippedCount} skipped`);
        } catch (error) {
            this.reconcileStatus.phase = 'error';
            this.reconcileStatus.error = String((error as Error)?.message ?? error);
            this.reconcileStatus.finishedAt = new Date().toISOString();
            console.error(`[favorites:${this.provider}] reconcile failed`, error);
        } finally {
            this.reconcileRunning = false;
        }
        return this.getReconcileStatus();
    }
}
