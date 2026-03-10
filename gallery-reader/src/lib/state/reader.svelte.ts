import { SPRITE_THUMB_WIDTH } from '../config.js';
import type { Gallery, GalleryListItem, PagePosition } from '../types.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';
import type { UIState } from './ui.svelte.js';

const scheduleIdle = globalThis.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0));

let sessionCounter = 0;

/** Owns all resources for one open→close reader cycle. */
export class ReaderSession {
    readonly id: number;
    readonly gallery: Gallery;
    readonly abortController: AbortController;
    readonly blobUrls = new Map<number, string>();
    readonly loadingPages = new Set<number>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly rafIds = new Set<number>();
    private observer: IntersectionObserver | null = null;
    private scrollCleanup: (() => void) | null = null;
    private _dropped = false;

    constructor(gallery: Gallery) {
        this.id = ++sessionCounter;
        this.gallery = gallery;
        this.abortController = new AbortController();
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

/** Owns sprite resources for one GalleryRow. */
export class SpriteScope {
    abortController: AbortController;
    readonly blobUrls: string[] = [];

    constructor() {
        this.abortController = new AbortController();
    }

    get signal(): AbortSignal {
        return this.abortController.signal;
    }

    addBlobUrl(url: string) {
        this.blobUrls.push(url);
    }

    /** Abort in-flight fetches without revoking existing blobs. */
    abort() {
        this.abortController.abort();
    }

    /** New AbortController, keep existing blobs — for resuming sprite fetches. */
    refresh() {
        this.abortController = new AbortController();
    }

    /** Full cleanup — abort + revoke all blobs. */
    drop() {
        this.abortController.abort();
        for (const url of this.blobUrls) URL.revokeObjectURL(url);
        this.blobUrls.length = 0;
    }
}

export class ReaderState {
    session = $state<ReaderSession | null>(null);
    currentPosition = $state<PagePosition>({ pageIndex: 0, fraction: 0 });
    progress = $state<Record<number, PagePosition>>({});

    private ui: UIState;
    private debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private _lastSyncedPageIndex = -1;

    constructor(ui: UIState) {
        this.ui = ui;
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

    async openReader(item: GalleryListItem, startPage: number) {
        // Drop previous session if still alive
        this.session?.drop();

        const gallery = await api.getGallery(item.gallery_id);
        const s = new ReaderSession(gallery);
        this.session = s;

        const position: PagePosition = { pageIndex: startPage, fraction: 0 };
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
        }
        this.progress = newProgress;
    }

    /** Silently scroll the thumbnail strip in the hidden back view to match current page. */
    syncStripScroll(galleryId: number, pageIndex: number) {
        const rawTarget = pageIndex * SPRITE_THUMB_WIDTH;
        this.ui.stripScrolls[galleryId] = rawTarget;

        const backView = this.ui.peekBack();
        const viewId = backView ? `view-${backView}` : null;
        if (!viewId) return;

        const container = document.getElementById(viewId);
        const row = container?.querySelector(`#gallery-${galleryId}`) as HTMLElement | null;
        const strip = row?.querySelector('.row-strip') as HTMLElement;
        if (strip) {
            const centered = rawTarget - (strip.clientWidth / 2) + (SPRITE_THUMB_WIDTH / 2);
            strip.scrollLeft = Math.max(0, centered);
        }
    }

    async restoreReader(galleryId: number, position: PagePosition): Promise<boolean> {
        try {
            const gallery = await api.getGallery(galleryId);
            const s = new ReaderSession(gallery);
            this.session = s;
            this._lastSyncedPageIndex = -1;
            this.currentPosition = position;
            return true;
        } catch {
            return false;
        }
    }
}
