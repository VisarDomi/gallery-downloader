import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { hitomi, imhentai, type Source, type SourceId } from 'gallery-sources';
import { CONFIG } from './config.js';
import { downloadImhentaiGallery } from './imhentai-downloader.js';
import { socketService } from './socket.service.js';
import { stripAnsi, getUniqueItems } from './utils.js';
import type { CandidateGallery } from './gallery-job.js';
import { durableAtomicWriteFileSync, durableUnlinkSync } from './durable-file.js';

const SOURCES: Record<SourceId, Source> = { hitomi, imhentai };
const QUEUE_DIR = path.join(CONFIG.WORKING_DIR, 'gallery-dl');
const QUEUE_FILE = path.join(QUEUE_DIR, '.queue-backup.json');
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 120_000;

interface GalleryTarget {
    provider: SourceId;
    source: Source;
    galleryId: string;
    url: string;
}

interface ActiveDownload {
    cancel(): void;
}

function targetFromUrl(url: string): GalleryTarget | null {
    for (const provider of Object.keys(SOURCES) as SourceId[]) {
        const source = SOURCES[provider];
        const galleryId = source.download.parseIdFromUrl(url);
        if (galleryId) return { provider, source, galleryId, url };
    }
    return null;
}

export function isSupportedGalleryUrl(url: string): boolean {
    return targetFromUrl(url) !== null;
}

function sourceDirectory(source: Source): string {
    return path.join(CONFIG.WORKING_DIR, source.gallerySubdir);
}

function markerPath(target: GalleryTarget): string {
    return path.join(sourceDirectory(target.source), target.source.downloadingMarker(target.galleryId));
}

function createMarker(target: GalleryTarget): void {
    durableAtomicWriteFileSync(markerPath(target), '');
}

function removeMarker(target: GalleryTarget): void {
    durableUnlinkSync(markerPath(target));
}

function deletePartialGallery(target: GalleryTarget): void {
    const directory = path.join(sourceDirectory(target.source), target.galleryId);
    try {
        fs.rmSync(directory, { recursive: true, force: true });
        console.log(`Deleted partial ${target.provider} gallery: ${target.galleryId}`);
    } catch { /* already gone */ }

    if (target.provider === 'hitomi') {
        const archivePath = hitomi.download.archivePath(CONFIG.WORKING_DIR);
        try {
            execFileSync('sqlite3', [archivePath, `DELETE FROM archive WHERE entry LIKE 'hitomi${target.galleryId}_%'`], { stdio: 'pipe' });
        } catch { /* archive absent or entry absent */ }
    }
    removeMarker(target);
}

function saveQueue(currentUrl: string | null, queue: string[], paused = false): void {
    const data = { currentUrl, queue, paused, savedAt: new Date().toISOString() };
    durableAtomicWriteFileSync(QUEUE_FILE, `${JSON.stringify(data)}\n`);
}

function loadQueue(): { queue: string[]; paused: boolean } | null {
    try {
        const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) as { currentUrl?: unknown; queue?: unknown; paused?: unknown };
        const urls: string[] = [];
        if (typeof raw.currentUrl === 'string' && isSupportedGalleryUrl(raw.currentUrl)) urls.push(raw.currentUrl);
        if (Array.isArray(raw.queue)) {
            urls.push(...raw.queue.filter((url): url is string => typeof url === 'string' && isSupportedGalleryUrl(url)));
        }
        return urls.length > 0 ? { queue: getUniqueItems(urls, null), paused: raw.paused === true } : null;
    } catch (error) {
        console.error(`[queue] could not restore ${QUEUE_FILE}; favorites snapshots will rebuild it`, error);
        return null;
    }
}

function clearQueueFile(): void {
    durableUnlinkSync(QUEUE_FILE);
}

export interface QueueStatus {
    running: boolean;
    stopped: boolean;
    paused: boolean;
    currentUrl: string;
    currentProvider: SourceId | null;
    retryAttempt: number;
    retryAt: string | null;
    queue: string[];
}

class QueueManager {
    private downloadQueue: string[] = [];
    private activeDownload: ActiveDownload | null = null;
    private currentUrl: string | null = null;
    private currentTarget: GalleryTarget | null = null;
    private isInterrupted = false;
    private stopSignal = false;
    private pauseSignal = false;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private retryAt: string | null = null;
    private retryAttempt = 0;
    private readonly retryAttempts = new Map<string, number>();
    private onComplete: ((provider: SourceId, galleryId: string) => void) | null = null;

    public setOnComplete(fn: (provider: SourceId, galleryId: string) => void): void {
        this.onComplete = fn;
    }

    public getStatus(): QueueStatus {
        return {
            running: this.activeDownload !== null,
            stopped: this.stopSignal,
            paused: this.pauseSignal,
            currentUrl: this.currentUrl ?? '',
            currentProvider: this.currentTarget?.provider ?? null,
            retryAttempt: this.retryAttempt,
            retryAt: this.retryAt,
            queue: this.downloadQueue,
        };
    }

    private emitState(): void {
        socketService.emitStatus(this.getStatus());
        if (this.downloadQueue.length === 0 && !this.currentUrl) clearQueueFile();
        else saveQueue(this.currentUrl, this.downloadQueue, this.pauseSignal);
    }

    private finish(target: GalleryTarget, error: Error | null): void {
        if (this.currentTarget !== target) return;
        if (error) {
            socketService.emitLog(`\n--- FAILED: ${error.message} ---\n`);
            if (!this.isInterrupted && !this.stopSignal) {
                const attempt = (this.retryAttempts.get(target.url) ?? 0) + 1;
                this.activeDownload = null;
                this.currentUrl = null;
                this.currentTarget = null;

                if (attempt <= MAX_RETRY_ATTEMPTS) {
                    this.retryAttempts.set(target.url, attempt);
                    if (!this.downloadQueue.includes(target.url)) this.downloadQueue.unshift(target.url);
                    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
                    this.retryAttempt = attempt;
                    this.retryAt = new Date(Date.now() + delay).toISOString();
                    socketService.emitLog(`[RETRY ${attempt}/${MAX_RETRY_ATTEMPTS}] ${target.provider}:${target.galleryId} in ${Math.ceil(delay / 1000)}s\n`);
                    this.emitState();
                    this.retryTimer = setTimeout(() => {
                        this.retryTimer = null;
                        this.retryAt = null;
                        this.retryAttempt = 0;
                        this.emitState();
                        this.processQueue();
                    }, delay);
                    return;
                }

                this.retryAttempts.delete(target.url);
                if (!this.downloadQueue.includes(target.url)) this.downloadQueue.push(target.url);
                socketService.emitLog(`[DEFERRED] ${target.provider}:${target.galleryId} moved to the queue tail after ${MAX_RETRY_ATTEMPTS} retries\n`);
            }
        } else {
            socketService.emitLog('\n--- FINISHED ---\n');
            this.retryAttempts.delete(target.url);
            if (!this.isInterrupted && !this.stopSignal) this.onComplete?.(target.provider, target.galleryId);
            removeMarker(target);
        }

        this.activeDownload = null;
        this.currentUrl = null;
        this.currentTarget = null;
        this.retryAt = null;
        this.retryAttempt = 0;
        this.emitState();
        if (!this.isInterrupted && !this.stopSignal) this.processQueue();
    }

    private runGalleryDl(target: GalleryTarget): void {
        const child: ChildProcess = spawn(CONFIG.PYTHON_PATH, [CONFIG.GALLERY_DL_SCRIPT, ...CONFIG.BASE_ARGS, target.url], {
            cwd: CONFIG.WORKING_DIR,
        });
        this.activeDownload = { cancel: () => child.kill('SIGINT') };
        child.stdout?.on('data', data => socketService.emitLog(stripAnsi(data.toString())));
        child.stderr?.on('data', data => socketService.emitLog(`[ERR] ${stripAnsi(data.toString())}`));
        child.once('error', error => this.finish(target, error));
        child.once('close', code => this.finish(target, code === 0 ? null : new Error(`gallery-dl exited with code ${code}`)));
    }

    private runImhentai(target: GalleryTarget): void {
        const controller = new AbortController();
        this.activeDownload = { cancel: () => controller.abort(new Error('download interrupted')) };
        void downloadImhentaiGallery(target.url, {
            signal: controller.signal,
            log: message => socketService.emitLog(`${message}\n`),
        }).then(
            () => this.finish(target, null),
            error => this.finish(target, error instanceof Error ? error : new Error(String(error))),
        );
    }

    public processQueue(): void {
        if (this.activeDownload || this.retryTimer || this.stopSignal || this.pauseSignal) return;
        const url = this.downloadQueue.shift();
        if (!url) {
            this.currentUrl = null;
            this.emitState();
            socketService.emitLog('Queue finished. Waiting for commands...\n');
            return;
        }

        const target = targetFromUrl(url);
        if (!target) {
            socketService.emitLog(`Unsupported gallery URL skipped: ${url}\n`);
            this.processQueue();
            return;
        }

        this.currentUrl = url;
        this.currentTarget = target;
        createMarker(target);
        this.emitState();
        socketService.emitLog(`\n--- STARTING ${target.provider}:${target.galleryId} ---\n`);
        if (target.provider === 'imhentai') this.runImhentai(target);
        else this.runGalleryDl(target);
    }

    public updateQueue(rawUrls: string[]): void {
        this.clearRetryBackoff();
        this.downloadQueue = getUniqueItems(rawUrls.filter(isSupportedGalleryUrl), this.currentUrl);
        this.stopSignal = false;
        this.emitState();
        this.processQueue();
    }

    public injectImmediate(rawUrls: string[]): void {
        const urls = getUniqueItems(rawUrls.filter(isSupportedGalleryUrl), this.currentUrl);
        if (urls.length === 0) return;
        this.clearRetryBackoff();
        this.stopSignal = false;

        const [newActive, ...newFront] = urls;
        const combined = [...newFront];
        if (this.currentUrl) combined.push(this.currentUrl);
        combined.push(...this.downloadQueue);
        this.downloadQueue = getUniqueItems(combined, newActive);
        this.downloadQueue.unshift(newActive);

        if (this.activeDownload) {
            this.isInterrupted = true;
            this.activeDownload.cancel();
            setTimeout(() => {
                this.isInterrupted = false;
                this.processQueue();
            }, 1_000);
        } else {
            this.processQueue();
        }
        this.emitState();
    }

    public pause(): void {
        this.pauseSignal = true;
        this.emitState();
        socketService.emitLog('\n--- PAUSED (will finish current download) ---\n');
    }

    public resume(): void {
        this.pauseSignal = false;
        this.emitState();
        this.processQueue();
    }

    public cancel(): void {
        this.clearRetryBackoff();
        this.stopSignal = true;
        const target = this.currentTarget;
        this.activeDownload?.cancel();
        if (target) deletePartialGallery(target);
        this.downloadQueue = [];
        this.currentUrl = null;
        this.currentTarget = null;
        this.activeDownload = null;
        this.pauseSignal = false;
        this.emitState();
        socketService.emitLog('\n--- QUEUE STOPPED ---\n');
    }

    public append(galleries: CandidateGallery[]): number {
        const existingUrls = new Set(this.downloadQueue);
        if (this.currentUrl) existingUrls.add(this.currentUrl);
        let added = 0;
        for (const gallery of galleries) {
            if (existingUrls.has(gallery.url)) continue;
            this.downloadQueue.push(gallery.url);
            existingUrls.add(gallery.url);
            added++;
        }
        if (added > 0) {
            this.stopSignal = false;
            this.emitState();
            this.processQueue();
        }
        return added;
    }

    public start(): void {
        this.stopSignal = false;
        this.emitState();
        this.processQueue();
    }

    public retainQueuedGalleryIds(provider: SourceId, allowedIds: Set<number>): number {
        const before = this.downloadQueue.length;
        this.downloadQueue = this.downloadQueue.filter(url => {
            const target = targetFromUrl(url);
            if (!target || target.provider !== provider) return true;
            return allowedIds.has(Number(target.galleryId));
        });
        const removed = before - this.downloadQueue.length;
        if (removed > 0) this.emitState();
        return removed;
    }

    public restore(startProcessing = true): void {
        const saved = loadQueue();
        if (!saved) return;
        this.downloadQueue = saved.queue;
        this.stopSignal = false;
        this.pauseSignal = saved.paused;
        this.emitState();
        if (!saved.paused && startProcessing) this.processQueue();
    }

    private clearRetryBackoff(): void {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.retryAt = null;
        this.retryAttempt = 0;
    }
}

export const queueManager = new QueueManager();
