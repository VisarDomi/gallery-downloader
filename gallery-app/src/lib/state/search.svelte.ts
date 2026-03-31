import { PAGE_SIZE } from '../config.js';
import type { GalleryListItem } from '../types.js';
import type { LogEmit } from '../services/LogService.js';
import * as api from '../services/api.js';

export class SearchState {
    private emit: LogEmit;
    allGalleries = $state<GalleryListItem[]>([]);
    currentQuery = $state('');
    currentPage = $state(0);
    isLoading = $state(false);

    selectedLanguage = $state('japanese');
    selectedArtist = $state('');
    selectedGroup = $state('');
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

    get fullQuery(): string {
        const parts: string[] = [];
        const u = (s: string) => s.replace(/ /g, '_');
        if (this.selectedLanguage) parts.push(`language:${u(this.selectedLanguage)}`);
        if (this.selectedArtist) parts.push(`artist:${u(this.selectedArtist)}`);
        if (this.selectedGroup) parts.push(`group:${u(this.selectedGroup)}`);
        if (this.currentQuery) parts.push(this.currentQuery);
        return parts.join(' ');
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
        this.currentQuery = query;
        this.currentPage = 0;

        try {
            const data = await api.search(this.fullQuery);
            this.allGalleries = data.items;
        } catch (e) {
            this.emit('search-failed', { error: String(e) });
            this.allGalleries = [];
        } finally {
            this.isLoading = false;
        }
    }

    async restoreFromQuery(fullQuery: string) {
        let remaining = fullQuery;
        const extract = (prefix: string) => {
            const re = new RegExp(`\\b${prefix}:(\\S+)`);
            const m = remaining.match(re);
            if (m) {
                remaining = remaining.replace(re, '').trim();
                return m[1].replace(/_/g, ' ');
            }
            return '';
        };

        this.selectedLanguage = extract('language');
        this.selectedArtist = extract('artist');
        this.selectedGroup = extract('group');
        await this.search(remaining);
    }

    async searchByFilter(opts: { artist?: string; group?: string; language?: string }) {
        this.selectedLanguage = opts.language ?? '';
        this.selectedArtist = opts.artist ?? '';
        this.selectedGroup = opts.group ?? '';
        this.currentQuery = '';
        await this.search('');
    }

    removeGalleries(ids: Set<number>) {
        this.allGalleries = this.allGalleries.filter(g => !ids.has(g.gallery_id));
    }
}
