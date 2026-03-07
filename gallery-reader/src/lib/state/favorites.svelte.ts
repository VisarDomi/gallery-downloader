import { PAGE_SIZE } from '../config.js';
import type { GalleryListItem } from '../types.js';
import * as api from '../services/api.js';
import * as db from '../services/db.js';

export class FavoritesState {
    favoriteIds = $state<Set<number>>(new Set());
    favoriteQueries = $state<Record<number, string>>({});
    favoriteGalleries = $state<GalleryListItem[]>([]);
    currentPage = $state(0);

    get totalPages() {
        return Math.max(1, Math.ceil(this.favoriteGalleries.length / PAGE_SIZE));
    }

    get paginatedGalleries(): GalleryListItem[] {
        const start = this.currentPage * PAGE_SIZE;
        return this.favoriteGalleries.slice(start, start + PAGE_SIZE);
    }

    async init() {
        const entries = await db.getAllFavorites();
        const ids = new Set<number>();
        const queries: Record<number, string> = {};
        for (const entry of entries) {
            ids.add(entry.galleryId);
            if (entry.query) queries[entry.galleryId] = entry.query;
        }
        this.favoriteIds = ids;
        this.favoriteQueries = queries;
    }

    async toggle(id: number, currentQuery: string, isInFavoritesView: boolean) {
        const newQueries = { ...this.favoriteQueries };
        let newIds: Set<number>;

        if (this.favoriteIds.has(id)) {
            newIds = new Set(this.favoriteIds);
            newIds.delete(id);
            delete newQueries[id];
            await db.removeFavorite(id);
        } else {
            newIds = new Set([id, ...this.favoriteIds]);
            if (currentQuery) newQueries[id] = currentQuery;
            await db.addFavorite(id, currentQuery);
        }

        this.favoriteIds = newIds;
        this.favoriteQueries = newQueries;

        if (isInFavoritesView) {
            this.favoriteGalleries = this.favoriteGalleries.filter(g => newIds.has(g.gallery_id));
        }
    }

    async loadGalleries() {
        this.currentPage = 0;
        const ids = [...this.favoriteIds];
        if (ids.length === 0) {
            this.favoriteGalleries = [];
            return;
        }

        try {
            const galleries = await api.getGalleries(ids);
            const idOrder = new Map(ids.map((id, i) => [id, i]));
            galleries.sort((a, b) => (idOrder.get(a.gallery_id) ?? 0) - (idOrder.get(b.gallery_id) ?? 0));
            this.favoriteGalleries = galleries;
        } catch (e) {
            console.error('Failed to load favorites:', e);
        }
    }

    getQuery(id: number): string | undefined {
        return this.favoriteQueries[id];
    }

    removeGalleries(ids: Set<number>) {
        const newFavIds = new Set(this.favoriteIds);
        const newQueries = { ...this.favoriteQueries };
        for (const id of ids) {
            newFavIds.delete(id);
            delete newQueries[id];
        }
        this.favoriteIds = newFavIds;
        this.favoriteQueries = newQueries;
        this.favoriteGalleries = this.favoriteGalleries.filter(g => !ids.has(g.gallery_id));
    }
}
