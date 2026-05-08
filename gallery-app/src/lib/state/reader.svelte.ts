import { THUMB_WIDTH } from '../config.js';
import type { Gallery, GalleryListItem, PagePosition } from '../types.js';
import type { LogEmit } from '../services/LogService.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';
import type { UIState } from './ui.svelte.js';

const scheduleIdle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0));

let sessionCounter = 0;

type LoadSource = 'idle' | 'observer' | 'eager';

/** Per-session accounting — plain counters, not reactive. */
interface LoadStats {
    total: number;
    loaded: number;
    failed: number;
    /** Pages initiated by each source (before dedup guard). */
    bySource: Record<LoadSource, number>;
    idleCallbacksRun: number;
    idleComplete: boolean;
    startMs: number;
}

/** Owns all resources for one open→close reader cycle. */
export class ReaderSession {
    readonly id: number;
    readonly gallery: Gallery;
    readonly abortController: AbortController;
    readonly blobUrls = new Map<number, string>();
    readonly loadingPages = new Set<number>();
    readonly loadStats: LoadStats;
    private readonly emit: LogEmit;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly rafIds = new Set<number>();
    private observer: IntersectionObserver | null = null;
    private scrollCleanup: (() => void) | null = null;
    private _dropped = false;

    readonly startPosition: PagePosition;

    constructor(gallery: Gallery, emit: LogEmit, startPosition: PagePosition) {
        this.id = ++sessionCounter;
        this.gallery = gallery;
        this.emit = emit;
        this.startPosition = startPosition;
        this.abortController = new AbortController();
        this.loadStats = {
            total: gallery.count,
            loaded: 0,
            failed: 0,
            bySource: { idle: 0, observer: 0, eager: 0 },
            idleCallbacksRun: 0,
            idleComplete: false,
            startMs: 0,
        };
    }

    // -- Load tracking --

    beginLoading(startPage: number, hasRoot: boolean) {
        this.loadStats.startMs = Date.now();
        this.emit('reader-setup', {
            galleryId: this.gallery.gallery_id,
            pageCount: this.loadStats.total,
            startPage,
            hasRoot,
        });
    }

    /** Record that a page load was initiated (passed the dedup guard). */
    recordLoadStart(source: LoadSource) {
        this.loadStats.bySource[source]++;
    }

    recordLoadOk() {
        this.loadStats.loaded++;
    }

    recordLoadFail() {
        this.loadStats.failed++;
    }

    recordIdleCallback() {
        this.loadStats.idleCallbacksRun++;
    }

    markIdleDone(pagesScheduled: number) {
        this.loadStats.idleComplete = true;
        this.emit('reader-idle-done', {
            galleryId: this.gallery.gallery_id,
            idleCallbacks: this.loadStats.idleCallbacksRun,
            pagesScheduled,
        });
    }

    get signal(): AbortSignal {
        return this.abortController.signal;
    }

    get isDropped(): boolean {
        return this._dropped;
    }

    addBlobUrl(pageIndex: number, url: string) {
        if (this._dropped) {
            URL.revokeObjectURL(url);
            return;
        }
        this.blobUrls.set(pageIndex, url);
    }

    hasPage(pageIndex: number): boolean {
        return this.blobUrls.has(pageIndex);
    }

    markLoading(pageIndex: number) {
        this.loadingPages.add(pageIndex);
    }

    unmarkLoading(pageIndex: number) {
        this.loadingPages.delete(pageIndex);
    }

    isLoading(pageIndex: number): boolean {
        return this.loadingPages.has(pageIndex);
    }

    setObserver(obs: IntersectionObserver) {
        this.observer?.disconnect();
        this.observer = obs;
    }

    setScrollCleanup(fn: () => void) {
        this.scrollCleanup?.();
        this.scrollCleanup = fn;
    }

    addTimer(id: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
        if (this._dropped) {
            clearTimeout(id);
            return id;
        }
        this.timers.add(id);
        return id;
    }

    clearTimer(id: ReturnType<typeof setTimeout>) {
        clearTimeout(id);
        this.timers.delete(id);
    }

    addRaf(id: number): number {
        if (this._dropped) {
            cancelAnimationFrame(id);
            return id;
        }
        this.rafIds.add(id);
        return id;
    }

    clearRaf(id: number) {
        cancelAnimationFrame(id);
        this.rafIds.delete(id);
    }

    /** Deterministic cleanup — idempotent. */
    drop() {
        if (this._dropped) return;
        this._dropped = true;

        // Emit load summary before cleaning up
        const s = this.loadStats;
        this.emit('reader-drop', {
            galleryId: this.gallery.gallery_id,
            total: s.total,
            loaded: s.loaded,
            failed: s.failed,
            idle: s.bySource.idle,
            observer: s.bySource.observer,
            eager: s.bySource.eager,
            idleCallbacks: s.idleCallbacksRun,
            idleComplete: s.idleComplete,
            elapsedMs: s.startMs > 0 ? Date.now() - s.startMs : 0,
        });

        this.abortController.abort();

        this.observer?.disconnect();
        this.observer = null;

        this.scrollCleanup?.();
        this.scrollCleanup = null;

        for (const t of this.timers) clearTimeout(t);
        this.timers.clear();

        for (const r of this.rafIds) cancelAnimationFrame(r);
        this.rafIds.clear();

        for (const url of this.blobUrls.values()) URL.revokeObjectURL(url);
        this.blobUrls.clear();

        this.loadingPages.clear();
    }
}

export class ReaderState {
    session = $state<ReaderSession | null>(null);
    currentPosition = $state<PagePosition>({ pageIndex: 0, fraction: 0 });
    progress = $state<Record<number, PagePosition>>({});

    private ui: UIState;
    private emit: LogEmit;
    private debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private _lastSyncedPageIndex = -1;

    constructor(ui: UIState, emit: LogEmit) {
        this.ui = ui;
        this.emit = emit;
    }

    /** Backward-compat readonly getter for templates and session persistence. */
    get activeGallery(): Gallery | null {
        return this.session?.gallery ?? null;
    }

    get currentPageIndex(): number {
        return this.currentPosition.pageIndex;
    }

    async loadProgress() {
        this.progress = await db.getAllProgress();
    }

    getProgress(galleryId: number): PagePosition {
        return this.progress[galleryId] ?? { pageIndex: 0, fraction: 0 };
    }

    getProgressIndex(galleryId: number): number {
        return this.progress[galleryId]?.pageIndex ?? 0;
    }

    async openReader(item: GalleryListItem, startPage: number, startFraction = 0) {
        // Drop previous session if still alive
        this.session?.drop();

        const gallery = await api.getGallery(item.gallery_id);
        const pageIndex = Math.max(0, Math.min(gallery.count - 1, startPage));
        const fraction = Math.max(0, Math.min(1, startFraction));
        const position: PagePosition = { pageIndex, fraction };
        const s = new ReaderSession(gallery, this.emit, position);
        this.session = s;

        this._lastSyncedPageIndex = -1;
        this.currentPosition = position;
        this.saveProgress(gallery.gallery_id, position);
        this.ui.pushView('reader');
    }

    closeReader() {
        // Capture local reference — the idle callback can never touch this.session
        const closingSession = this.session;
        this.session = null;
        this.ui.popView();
        scheduleIdle(() => closingSession?.drop());
    }

    saveProgress(galleryId: number, position: PagePosition) {
        // Only write $state when page actually changes
        if (position.pageIndex !== this._lastSyncedPageIndex) {
            this._lastSyncedPageIndex = position.pageIndex;
            this.progress[galleryId] = position;
            this.currentPosition = position;
            this.syncStripScroll(galleryId, position.pageIndex);
        }

        // Debounce IDB writes (250ms trailing edge)
        const existing = this.debounceTimers.get(galleryId);
        if (existing != null) clearTimeout(existing);
        this.debounceTimers.set(galleryId, setTimeout(() => {
            this.debounceTimers.delete(galleryId);
            db.setProgress(galleryId, position);
        }, 250));
    }

    removeProgress(ids: Set<number>) {
        const newProgress = { ...this.progress };
        for (const id of ids) {
            delete newProgress[id];
            const timer = this.debounceTimers.get(id);
            if (timer != null) {
                clearTimeout(timer);
                this.debounceTimers.delete(id);
            }
        }
        this.progress = newProgress;
    }

    destroy() {
        this.session?.drop();
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
    }

    /** Silently scroll the thumbnail strip in the hidden back view to match current page. */
    syncStripScroll(galleryId: number, pageIndex: number) {
        const rawTarget = pageIndex * THUMB_WIDTH + THUMB_WIDTH / 2;
        this.ui.stripScrolls[galleryId] = rawTarget;

        const backView = this.ui.peekBack();
        const viewId = backView ? `view-${backView}` : null;
        if (!viewId) return;

        const container = document.getElementById(viewId);
        const row = container?.querySelector(`#gallery-${galleryId}`) as HTMLElement | null;
        const strip = row?.querySelector('.row-strip') as HTMLElement;
        if (strip) {
            const centered = rawTarget - (strip.clientWidth / 2);
            strip.scrollLeft = Math.max(0, centered);
        }
    }

    async restoreReader(galleryId: number, position: PagePosition): Promise<boolean> {
        const gallery = await api.getGallery(galleryId);
        const s = new ReaderSession(gallery, this.emit, position);
        this.session = s;
        this._lastSyncedPageIndex = -1;
        this.currentPosition = position;
        return true;
    }
}
