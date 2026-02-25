import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { hitomi } from 'gallery-sources';
import { CONFIG } from './config.js';
import { socketService } from './socket.service.js';
import { stripAnsi, getUniqueItems } from './utils.js';

const SOURCE_DIR = path.join(CONFIG.WORKING_DIR, hitomi.gallerySubdir);

// Remove stale markers from previous runs (e.g. power failure, crash)
try {
    for (const f of fs.readdirSync(SOURCE_DIR)) {
        if (f.startsWith('.downloading-')) fs.unlinkSync(path.join(SOURCE_DIR, f));
    }
} catch (_) {}

function extractGalleryId(url: string): string | null {
    return hitomi.download.parseIdFromUrl(url);
}

function markerPath(galleryId: string): string {
    return path.join(SOURCE_DIR, hitomi.downloadingMarker(galleryId));
}

function createMarker(galleryId: string) {
    try { fs.writeFileSync(markerPath(galleryId), ''); } catch (_) {}
}

function removeMarker(galleryId: string) {
    try { fs.unlinkSync(markerPath(galleryId)); } catch (_) {}
}

export interface QueueStatus {
    running: boolean;
    stopped: boolean;
    currentUrl: string;
    queue: string[];
}

class QueueManager {
    private downloadQueue: string[] = [];
    private currentChild: ChildProcess | null = null;
    private currentUrl: string | null = null;
    private currentGalleryId: string | null = null;
    private isInterrupted: boolean = false;
    private stopSignal: boolean = false;

    public getStatus(): QueueStatus {
        return {
            running: !!this.currentChild,
            stopped: this.stopSignal,
            currentUrl: this.currentUrl || '',
            queue: this.downloadQueue
        };
    }

    private emitState() {
        socketService.emitStatus(this.getStatus());
    }

    public processQueue() {
        if (this.currentChild || this.stopSignal) return;

        if (this.downloadQueue.length === 0) {
            this.currentUrl = null;
            this.emitState();
            socketService.emitLog('Queue finished. Waiting for commands...\n');
            return;
        }

        this.currentUrl = this.downloadQueue.shift() || null;
        if (!this.currentUrl) return;

        this.currentGalleryId = extractGalleryId(this.currentUrl);
        if (this.currentGalleryId) createMarker(this.currentGalleryId);

        this.emitState();
        socketService.emitLog(`\n--- STARTING: ${this.currentUrl} ---\n`);

        this.currentChild = spawn(CONFIG.PYTHON_PATH, [CONFIG.GALLERY_DL_SCRIPT, ...CONFIG.BASE_ARGS, this.currentUrl], {
            cwd: CONFIG.WORKING_DIR
        });

        this.currentChild.on('error', (err) => {
            socketService.emitLog(`\n--- SPAWN ERROR: ${err.message} ---\n`);
            if (this.currentGalleryId) removeMarker(this.currentGalleryId);
            this.currentChild = null;
            this.currentGalleryId = null;

            if (!this.isInterrupted && !this.stopSignal) {
                this.processQueue();
            }
        });

        this.currentChild.stdout?.on('data', (data) => {
            socketService.emitLog(stripAnsi(data.toString()));
        });

        this.currentChild.stderr?.on('data', (data) => {
            socketService.emitLog(`[ERR] ${stripAnsi(data.toString())}`);
        });

        this.currentChild.on('close', (code) => {
            socketService.emitLog(`\n--- FINISHED (Code ${code}) ---\n`);
            // Only remove marker on clean completion — interrupted/cancelled
            // downloads leave partial files, so keep them hidden from indexer
            if (!this.isInterrupted && !this.stopSignal) {
                if (this.currentGalleryId) removeMarker(this.currentGalleryId);
            }
            this.currentChild = null;
            this.currentGalleryId = null;

            if (!this.isInterrupted && !this.stopSignal) {
                this.processQueue();
            }
        });
    }

    public updateQueue(rawUrls: string[]) {
        this.downloadQueue = getUniqueItems(rawUrls, [], this.currentUrl);
        this.stopSignal = false;
        this.emitState();
        this.processQueue();
    }

    public injectImmediate(rawUrls: string[]) {
        if (rawUrls.length === 0) return;

        console.log(`IMMEDIATE REQUEST: ${rawUrls.length} items.`);
        this.stopSignal = false;

        const newActive = rawUrls[0];
        const newFrontOfQueue = getUniqueItems(rawUrls.slice(1), [], this.currentUrl);

        if (this.currentChild) {
            this.isInterrupted = true;
            this.currentChild.kill('SIGINT');

            const oldUrl = this.currentUrl;
            const combined = [...newFrontOfQueue];
            if (oldUrl) combined.push(oldUrl);
            combined.push(...this.downloadQueue);

            this.downloadQueue = getUniqueItems(combined, [], newActive);
            this.downloadQueue.unshift(newActive);

            setTimeout(() => {
                this.isInterrupted = false;
                this.processQueue();
            }, 1000);
        } else {
            this.downloadQueue = getUniqueItems([...newFrontOfQueue, ...this.downloadQueue], [], newActive);
            this.downloadQueue.unshift(newActive);
            this.processQueue();
        }
    }

    public cancel() {
        this.stopSignal = true;
        if (this.currentChild) {
            socketService.emitLog(`\n--- CANCELLING... ---\n`);
            this.currentChild.kill('SIGINT');
        } else {
            socketService.emitLog(`\n--- QUEUE STOPPED ---\n`);
        }
        this.emitState();
    }
}

export const queueManager = new QueueManager();
