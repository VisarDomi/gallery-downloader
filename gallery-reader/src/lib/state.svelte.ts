import { PAGE_SIZE, SPRITE_THUMB_WIDTH } from './config.js';
import type { Gallery, ViewMode } from './types.js';
import * as api from './services/api.js';
import * as db from './services/db.js';

// -- Toast --
class ToastState {
    items = $state<{ id: number; message: string }[]>([]);
    private nextId = 0;

    show(message: string, duration = 2000) {
        const id = this.nextId++;
        this.items = [...this.items, { id, message }];
        setTimeout(() => {
            this.items = this.items.filter(t => t.id !== id);
        }, duration);
    }
}

// -- UI State --
class UIState {
    viewMode = $state<ViewMode>('list');
    previousViewMode = $state<ViewMode>('list');
    // Gallery ID → horizontal scrollLeft (pixels) for thumbnail strips
    stripScrolls: Record<number, number> = {};
    // Swipe-to-go-back gesture state
    swipeProgress = $state(0);    // 0 = reader fully visible, 1 = fully swiped away
    isSwiping = $state(false);     // true while layers should be mounted (drag + animation)
    swipeAnimating = $state(false); // true during release animation (enables CSS transition)

    // Centralized sprite fetch abort — frees HTTP connections synchronously
    private _spriteControllers = new Set<AbortController>();

    registerSpriteController(c: AbortController) { this._spriteControllers.add(c); }
    unregisterSpriteController(c: AbortController) { this._spriteControllers.delete(c); }

    abortAllSprites() {
        for (const c of this._spriteControllers) c.abort();
        this._spriteControllers.clear();
    }

    setView(mode: ViewMode) {
        this.previousViewMode = this.viewMode;
        this.viewMode = mode;
    }
}

// -- Search State --
class SearchState {
    allGalleries = $state<Gallery[]>([]);
    currentQuery = $state('');
    currentPage = $state(0);
    isLoading = $state(false);

    // Filter dropdowns
    selectedLanguage = $state('japanese');
    selectedArtist = $state('');
    selectedGroup = $state('');
    availableLanguages = $state<[string, number][]>([]);
    availableArtists = $state<[string, number][]>([]);
    availableGroups = $state<[string, number][]>([]);

    get totalPages() {
        return Math.max(1, Math.ceil(this.allGalleries.length / PAGE_SIZE));
    }

    get paginatedGalleries(): Gallery[] {
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
            console.error('Failed to load filter options:', e);
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
            console.error('Search failed:', e);
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
}

// -- Reader State --
class ReaderState {
    activeGallery = $state<Gallery | null>(null);
    currentPageIndex = $state(0);
    progress = $state<Record<number, number>>({});

    async loadProgress() {
        this.progress = await db.getAllProgress();
    }

    getProgress(galleryId: number): number {
        return this.progress[galleryId] ?? 0;
    }

    openReader(gallery: Gallery, startPage: number, uiState: UIState) {
        // Abort all sprite fetches synchronously to free HTTP connections
        // before reader starts loading images (avoids HTTP/1.1 6-conn queuing)
        uiState.abortAllSprites();
        this.activeGallery = gallery;
        this.currentPageIndex = startPage;
        // Save progress immediately so resume works even with immediate back
        this.saveProgress(gallery.gallery_id, startPage);
        uiState.setView('reader');
    }

    closeReader(uiState: UIState) {
        if (this.activeGallery) {
            const galleryId = this.activeGallery.gallery_id;
            const rawTarget = this.currentPageIndex * SPRITE_THUMB_WIDTH;
            uiState.stripScrolls[galleryId] = rawTarget;

            // Directly scroll the strip, centered on current page
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
        uiState.setView(uiState.previousViewMode);
    }

    async saveProgress(galleryId: number, pageIndex: number) {
        this.progress[galleryId] = pageIndex;
        this.currentPageIndex = pageIndex;
        await db.setProgress(galleryId, pageIndex);
    }
}

// -- Favorites State --
class FavoritesState {
    favoriteIds = $state<Set<number>>(new Set());
    favoriteQueries = $state<Record<number, string>>({});
    favoriteGalleries = $state<Gallery[]>([]);
    currentPage = $state(0);

    get totalPages() {
        return Math.max(1, Math.ceil(this.favoriteGalleries.length / PAGE_SIZE));
    }

    get paginatedGalleries(): Gallery[] {
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

    async toggle(id: number, currentQuery: string) {
        const newQueries = { ...this.favoriteQueries };
        let newIds: Set<number>;

        if (this.favoriteIds.has(id)) {
            newIds = new Set(this.favoriteIds);
            newIds.delete(id);
            delete newQueries[id];
            await db.removeFavorite(id);
        } else {
            // Prepend new favorite (newest first)
            newIds = new Set([id, ...this.favoriteIds]);
            if (currentQuery) newQueries[id] = currentQuery;
            await db.addFavorite(id, currentQuery);
        }

        this.favoriteIds = newIds;
        this.favoriteQueries = newQueries;

        // If in favorites view, remove gallery from display
        if (appState.ui.viewMode === 'favorites') {
            this.favoriteGalleries = this.favoriteGalleries.filter(g => newIds.has(g.gallery_id));
        }
    }

    async loadView() {
        appState.ui.setView('favorites');
        this.currentPage = 0;
        const ids = [...this.favoriteIds];
        if (ids.length === 0) {
            this.favoriteGalleries = [];
            return;
        }

        try {
            const galleries = await api.getGalleries(ids);
            // Re-sort to match favoriteIds order (already sorted by savedAt desc from DB)
            const idOrder = new Map(ids.map((id, i) => [id, i]));
            galleries.sort((a, b) => (idOrder.get(a.gallery_id) ?? 0) - (idOrder.get(b.gallery_id) ?? 0));
            this.favoriteGalleries = galleries;
        } catch (e) {
            console.error('Failed to load favorites:', e);
        }
    }

    async replaySearch(galleryId: number) {
        const query = this.favoriteQueries[galleryId];
        if (!query) return;

        await appState.searchState.restoreFromQuery(query);

        // Find gallery index and compute page
        const idx = appState.searchState.allGalleries.findIndex(g => g.gallery_id === galleryId);
        if (idx >= 0) {
            appState.searchState.currentPage = Math.floor(idx / PAGE_SIZE);
        }

        appState.ui.setView('list');

        // After DOM update, scroll to gallery and highlight
        setTimeout(() => {
            const el = document.getElementById(`gallery-${galleryId}`);
            if (el) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
                el.classList.add('replay-highlight');
                setTimeout(() => el.classList.remove('replay-highlight'), 1500);
            }
        }, 100);
    }
}

// -- Saved Searches State --
class SavedState {
    savedSearches = $state<string[]>([]);

    async init() {
        this.savedSearches = await db.getAllSavedSearches();
    }

    async save(query: string) {
        if (!query || this.savedSearches.includes(query)) return;
        await db.addSavedSearch(query);
        this.savedSearches = [...this.savedSearches, query];
    }

    async remove(query: string) {
        await db.removeSavedSearch(query);
        this.savedSearches = this.savedSearches.filter(q => q !== query);
    }
}

// -- Downloader State --
class DownloaderState {
    async sendToDownloader(query: string) {
        if (!query) return;
        try {
            await api.sendToDownloader(query);
            appState.toast.show('Queued for download');
        } catch (e) {
            console.error('Download failed:', e);
        }
    }
}

// -- App State Singleton --
class AppState {
    ui = new UIState();
    searchState = new SearchState();
    reader = new ReaderState();
    favorites = new FavoritesState();
    saved = new SavedState();
    downloader = new DownloaderState();
    toast = new ToastState();

    async init() {
        await Promise.all([
            this.saved.init(),
            this.favorites.init(),
            this.reader.loadProgress(),
        ]);

        // Fire and forget refresh
        api.refreshIndex().catch(console.error);

        await this.searchState.loadFilterOptions();
    }
}

export const appState = new AppState();
