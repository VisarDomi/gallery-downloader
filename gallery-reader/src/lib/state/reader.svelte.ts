import { SPRITE_THUMB_WIDTH } from '../config.js';
import type { Gallery, GalleryListItem, PagePosition } from '../types.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';
import type { UIState } from './ui.svelte.js';

export class ReaderState {
    activeGallery = $state<Gallery | null>(null);
    currentPosition = $state<PagePosition>({ pageIndex: 0, fraction: 0 });
    progress = $state<Record<number, PagePosition>>({});

    private ui: UIState;
    private onBeforeOpen?: () => void;
    private debounceTimers = new Map<number, ReturnType<typeof setTimeout>>();
    private _lastSyncedPageIndex = -1;

    constructor(ui: UIState, opts?: { onBeforeOpen?: () => void }) {
        this.ui = ui;
        this.onBeforeOpen = opts?.onBeforeOpen;
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
        this.onBeforeOpen?.();

        const gallery = await api.getGallery(item.gallery_id);
        this.activeGallery = gallery;
        const position: PagePosition = { pageIndex: startPage, fraction: 0 };
        this._lastSyncedPageIndex = -1;
        this.currentPosition = position;
        this.saveProgress(gallery.gallery_id, position);
        this.ui.pushView('reader');
    }

    closeReader() {
        this.activeGallery = null;
        this.ui.popView();
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
            this.activeGallery = gallery;
            this._lastSyncedPageIndex = -1;
            this.currentPosition = position;
            return true;
        } catch {
            return false;
        }
    }
}
