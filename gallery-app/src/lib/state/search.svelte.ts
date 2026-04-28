import { PAGE_SIZE } from '../config.js';
import type { GalleryListItem } from '../types.js';
import type { LogEmit } from '../services/LogService.js';
import * as api from '../services/api.js';
import { normalizeTaggedQuery, tokenToQuery, type SearchNamespace } from 'gallery-sources';

export class SearchState {
    private emit: LogEmit;
    allGalleries = $state<GalleryListItem[]>([]);
    currentQuery = $state('language:japanese');
    currentPage = $state(0);
    isLoading = $state(false);

    availableLanguages = $state<[string, number][]>([]);
    availableArtists = $state<[string, number][]>([]);
    availableGroups = $state<[string, number][]>([]);

    constructor(emit: LogEmit) {
        this.emit = emit;
    }

    get totalPages() {
        return Math.max(1, Math.ceil(this.allGalleries.length / PAGE_SIZE));
    }

    get paginatedGalleries(): GalleryListItem[] {
        const start = this.currentPage * PAGE_SIZE;
        return this.allGalleries.slice(start, start + PAGE_SIZE);
    }

    async loadFilterOptions() {
        try {
            const data = await api.facets();
            this.availableLanguages = data.languages;
            this.availableArtists = data.artists;
            this.availableGroups = data.groups;
        } catch (e) {
            this.emit('filter-load-failed', { error: String(e) });
        }
    }

    async search(query: string) {
        this.isLoading = true;
        this.currentPage = 0;

        try {
            const normalizedQuery = normalizeTaggedQuery(query);
            this.currentQuery = normalizedQuery;
            const data = await api.search(normalizedQuery);
            this.allGalleries = data.items;
        } catch (e) {
            this.emit('search-failed', { error: String(e) });
            this.allGalleries = [];
        } finally {
            this.isLoading = false;
        }
    }

    async searchToken(namespace: SearchNamespace, value: string) {
        await this.search(tokenToQuery(namespace, value));
    }

    removeGalleries(ids: Set<number>) {
        this.allGalleries = this.allGalleries.filter(g => !ids.has(g.gallery_id));
    }
}
