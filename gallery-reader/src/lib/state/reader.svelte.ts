import { SPRITE_THUMB_WIDTH } from '../config.js';
import type { Gallery, GalleryListItem } from '../types.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';
import type { UIState } from './ui.svelte.js';

export class ReaderState {
    activeGallery = $state<Gallery | null>(null);
    currentPageIndex = $state(0);
    progress = $state<Record<number, number>>({});

    private ui: UIState;
    private onBeforeOpen?: () => void;

    constructor(ui: UIState, opts?: { onBeforeOpen?: () => void }) {
        this.ui = ui;
        this.onBeforeOpen = opts?.onBeforeOpen;
    }

    async loadProgress() {
        this.progress = await db.getAllProgress();
    }

    getProgress(galleryId: number): number {
        return this.progress[galleryId] ?? 0;
    }

    async openReader(item: GalleryListItem, startPage: number) {
        this.onBeforeOpen?.();

        const gallery = await api.getGallery(item.gallery_id);
        this.activeGallery = gallery;
        this.currentPageIndex = startPage;
        this.saveProgress(gallery.gallery_id, startPage);
        this.ui.pushView('reader');
    }

    closeReader() {
        if (this.activeGallery) {
            const galleryId = this.activeGallery.gallery_id;
            const rawTarget = this.currentPageIndex * SPRITE_THUMB_WIDTH;
            this.ui.stripScrolls[galleryId] = rawTarget;

            requestAnimationFrame(() => {
                const row = document.getElementById(`gallery-${galleryId}`);
                const strip = row?.querySelector('.row-strip') as HTMLElement;
                if (strip) {
                    const centered = rawTarget - (strip.clientWidth / 2) + (SPRITE_THUMB_WIDTH / 2);
                    strip.scrollLeft = Math.max(0, centered);
                }
            });
        }
        this.activeGallery = null;
        this.ui.popView();
    }

    async saveProgress(galleryId: number, pageIndex: number) {
        this.progress[galleryId] = pageIndex;
        this.currentPageIndex = pageIndex;
        await db.setProgress(galleryId, pageIndex);
    }

    removeProgress(ids: Set<number>) {
        const newProgress = { ...this.progress };
        for (const id of ids) {
            delete newProgress[id];
        }
        this.progress = newProgress;
    }

    async restoreReader(galleryId: number, startPage: number): Promise<boolean> {
        try {
            const gallery = await api.getGallery(galleryId);
            this.activeGallery = gallery;
            this.currentPageIndex = startPage;
            return true;
        } catch {
            return false;
        }
    }
}
