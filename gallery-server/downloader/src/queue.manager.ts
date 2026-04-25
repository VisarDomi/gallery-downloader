import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { hitomi } from 'gallery-sources';
import { CONFIG } from './config.js';
import { socketService } from './socket.service.js';
import { stripAnsi, getUniqueItems } from './utils.js';

const SOURCE_DIR = path.join(CONFIG.WORKING_DIR, hitomi.gallerySubdir);
const QUEUE_FILE = path.join(SOURCE_DIR, '.queue-backup.json');

// Remove stale markers from previous runs (e.g. power failure, crash)
try {
    for (const f of fs.readdirSync(SOURCE_DIR)) {
        if (f.startsWith('.downloading-')) fs.unlinkSync(path.join(SOURCE_DIR, f));
    }
} catch (_) {}

function saveQueue(currentUrl: string | null, queue: string[], paused: boolean = false) {
    const data = { currentUrl, queue, paused, savedAt: new Date().toISOString() };
    try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(data)); } catch (_) {}
}

function loadQueue(): { currentUrl: string | null; queue: string[]; paused: boolean } | null {
    try {
        const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
        const urls: string[] = [];
        if (raw.currentUrl) urls.push(raw.currentUrl);
        if (Array.isArray(raw.queue)) urls.push(...raw.queue);
        if (urls.length === 0) return null;
        return { currentUrl: null, queue: urls, paused: !!raw.paused };
    } catch (_) { return null; }
}

function clearQueueFile() {
    try { fs.unlinkSync(QUEUE_FILE); } catch (_) {}
}

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

function deletePartialGallery(galleryId: string) {
    // Delete gallery directory from disk
    const dirPath = path.join(SOURCE_DIR, galleryId);
    try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`Deleted partial gallery dir: ${galleryId}`);
    } catch (_) {}
    // Remove archive entries
    const archivePath = hitomi.download.archivePath(CONFIG.WORKING_DIR);
    try {
        execSync(`sqlite3 "${archivePath}" "DELETE FROM archive WHERE entry LIKE 'hitomi${galleryId}_%'"`, { stdio: 'pipe' });
        console.log(`Cleaned archive entries for gallery ${galleryId}`);
    } catch (_) {}
    // Remove marker
    removeMarker(galleryId);
}

export type DownloadValidator = (galleryId: string) => { valid: boolean; reason?: string };

export interface QueueStatus {
    running: boolean;
    stopped: boolean;
    paused: boolean;
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
    private pauseSignal: boolean = false;
    private validator: DownloadValidator | null = null;
    private onComplete: ((galleryId: string) => void) | null = null;

    public setValidator(fn: DownloadValidator) {
        this.validator = fn;
    }

    public setOnComplete(fn: (galleryId: string) => void) {
        this.onComplete = fn;
    }

    public getStatus(): QueueStatus {
        return {
            running: !!this.currentChild,
            stopped: this.stopSignal,
            paused: this.pauseSignal,
            currentUrl: this.currentUrl || '',
            queue: this.downloadQueue
        };
    }

    private emitState() {
        socketService.emitStatus(this.getStatus());
        this.persist();
    }

    private persist() {
        if (this.downloadQueue.length === 0 && !this.currentUrl) {
            clearQueueFile();
        } else {
            saveQueue(this.currentUrl, this.downloadQueue, this.pauseSignal);
        }
    }

    public processQueue() {
        if (this.currentChild || this.stopSignal || this.pauseSignal) return;

        if (this.downloadQueue.length === 0) {
            this.currentUrl = null;
            this.emitState();
            socketService.emitLog('Queue finished. Waiting for commands...\n');
            return;
        }

        this.currentUrl = this.downloadQueue.shift() || null;
        if (!this.currentUrl) return;

        this.currentGalleryId = extractGalleryId(this.currentUrl);
        if (this.currentGalleryId) {
            createMarker(this.currentGalleryId);
        }

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
            const completedGalleryId = this.currentGalleryId;

            if (!this.isInterrupted && !this.stopSignal) {
                let rejected = false;

                // Post-download validation (only on clean exit)
                if (code === 0 && completedGalleryId && this.validator) {
                    const check = this.validator(completedGalleryId);
                    if (!check.valid) {
                        console.log(`[validate] rejected ${completedGalleryId}: ${check.reason}`);
                        socketService.emitLog(`[REJECTED] ${completedGalleryId}: ${check.reason}\n`);
                        deletePartialGallery(completedGalleryId);
                        rejected = true;
                    }
                }

                if (!rejected && completedGalleryId) {
                    removeMarker(completedGalleryId);
                    this.onComplete?.(completedGalleryId);
                }
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

    public pause() {
        this.pauseSignal = true;
        this.emitState();
        socketService.emitLog('\n--- PAUSED (will finish current download) ---\n');
    }

    public resume() {
        this.pauseSignal = false;
        this.emitState();
        socketService.emitLog('\n--- RESUMED ---\n');
        this.processQueue();
    }

    public cancel() {
        this.stopSignal = true;
        const partialId = this.currentGalleryId;
        if (this.currentChild) {
            socketService.emitLog(`\n--- CANCELLING... ---\n`);
            this.currentChild.kill('SIGINT');
        } else {
            socketService.emitLog(`\n--- QUEUE STOPPED ---\n`);
        }
        // Clean up partial download
        if (partialId) {
            deletePartialGallery(partialId);
            socketService.emitLog(`Deleted partial gallery ${partialId}\n`);
        }
        this.downloadQueue = [];
        this.currentUrl = null;
        this.currentGalleryId = null;
        this.pauseSignal = false;
        this.emitState();
    }

    /**
     * Append gallery IDs to the queue without replacing existing items.
     * Converts IDs to hitomi URLs. Deduplicates against current queue + active download.
     */
    public appendQueue(galleryIds: number[]) {
        const existingUrls = new Set(this.downloadQueue);
        if (this.currentUrl) existingUrls.add(this.currentUrl);

        let added = 0;
        for (const id of galleryIds) {
            const url = `https://hitomi.la/galleries/${id}.html`;
            if (!existingUrls.has(url)) {
                this.downloadQueue.push(url);
                existingUrls.add(url);
                added++;
            }
        }

        if (added > 0) {
            this.stopSignal = false;
            this.emitState();
            this.processQueue();
        }

        return added;
    }

    public retainQueuedGalleryIds(allowedIds: Set<number>): number {
        const before = this.downloadQueue.length;
        this.downloadQueue = this.downloadQueue.filter((url) => {
            const id = extractGalleryId(url);
            if (!id) return true;
            return allowedIds.has(Number(id));
        });

        const removed = before - this.downloadQueue.length;
        if (removed > 0) {
            this.emitState();
        }
        return removed;
    }

    public restore() {
        const saved = loadQueue();
        if (!saved || saved.queue.length === 0) return;
        console.log(`Restoring ${saved.queue.length} queued items from backup...`);
        this.downloadQueue = saved.queue;
        this.stopSignal = false;
        this.pauseSignal = saved.paused;
        this.emitState();
        if (saved.paused) {
            console.log('Queue was paused — waiting for resume.');
        } else {
            this.processQueue();
        }
    }
}

export const queueManager = new QueueManager();
