import { PAGE_SIZE, RESUME_RECOVERY_MS, DEEP_SLEEP_MS } from '../config.js';
import * as api from '../services/api.js';
import { LogService } from '../services/LogService.js';
import { setDbLogger } from '../services/db.js';
import { ToastState } from './toast.svelte.js';
import { UIState } from './ui.svelte.js';
import { SearchState } from './search.svelte.js';
import { ReaderState } from './reader.svelte.js';
import { FavoritesState } from './favorites.svelte.js';
import { SavedState } from './saved.svelte.js';
import { DeleteState } from './delete.svelte.js';
import { saveSession, loadSession, clearSession } from './session.js';

class AppState {
    readonly log = new LogService();
    toast = new ToastState();
    ui = new UIState();
    searchState = new SearchState();
    favorites = new FavoritesState();
    saved = new SavedState();
    reader: ReaderState;
    delete_: DeleteState;

    private lastTick = Date.now();
    private tickInterval: ReturnType<typeof setInterval> | undefined;

    constructor() {
        this.reader = new ReaderState(this.ui);
        this.delete_ = new DeleteState({
            favorites: this.favorites,
            reader: this.reader,
            search: this.searchState,
        });
        this.ui.onViewChange = () => this.persistSession();
    }

    async init() {
        const t0 = Date.now();

        // LogService owns global error handlers — start first so crashes during init are captured
        this.log.start();
        this.log.log('boot-start');

        // Wire db module's logger to our LogService
        setDbLogger((op, error) => this.log.log('db-error', { op, error }));

        try {
            await Promise.all([
                this.saved.init(),
                this.favorites.init(),
                this.reader.loadProgress(),
            ]);

            api.refreshIndex().catch((e) =>
                this.log.log('refresh-index-failed', { message: String(e) }),
            );

            await this.searchState.loadFilterOptions();

            await this.restoreSession();

            this.setupResumeDetection();

            this.log.log('boot-ready', { ms: Date.now() - t0, view: this.ui.viewMode });
        } catch (e) {
            this.log.log('init-crash', {
                message: String((e as Error)?.message ?? e),
                stack: (e as Error)?.stack ?? '',
                ms: Date.now() - t0,
            });
        }
    }

    // -- Cross-domain orchestration --

    async replaySearch(galleryId: number) {
        const query = this.favorites.getQuery(galleryId);
        if (!query) return;

        await this.searchState.restoreFromQuery(query);

        const idx = this.searchState.allGalleries.findIndex(g => g.gallery_id === galleryId);
        if (idx >= 0) {
            this.searchState.currentPage = Math.floor(idx / PAGE_SIZE);
        }

        this.ui.pushView('list');

        setTimeout(() => {
            const container = document.getElementById('view-list');
            const el = container?.querySelector(`#gallery-${galleryId}`) as HTMLElement | null;
            if (el) {
                el.scrollIntoView({ behavior: 'auto', block: 'center' });
                el.classList.add('replay-highlight');
                setTimeout(() => el.classList.remove('replay-highlight'), 1500);
            }
        }, 100);
    }

    openFavorites() {
        this.ui.pushView('favorites');
        this.favorites.loadGalleries();
    }

    // -- Session persistence --

    private persistSession() {
        saveSession({
            viewMode: this.ui.viewMode,
            viewStack: this.ui.viewStack,
            activeGalleryId: this.reader.activeGallery?.gallery_id,
            searchQuery: this.searchState.fullQuery || undefined,
            searchPage: this.searchState.currentPage || undefined,
            favoritesPage: this.favorites.currentPage || undefined,
        });
    }

    private async restoreSession() {
        const snap = loadSession();
        if (!snap) {
            this.log.log('restore-none');
            await this.searchState.search('');
            return;
        }

        this.log.log('restore-start', {
            view: snap.viewMode,
            galleryId: snap.activeGalleryId ?? null,
            hasQuery: !!snap.searchQuery,
        });

        clearSession();

        // Restore search if we had one
        if (snap.searchQuery) {
            await this.searchState.restoreFromQuery(snap.searchQuery);
            if (snap.searchPage) {
                this.searchState.currentPage = snap.searchPage;
            }
        } else {
            await this.searchState.search('');
        }

        // Restore view based on saved mode
        switch (snap.viewMode) {
            case 'reader':
                if (snap.activeGalleryId != null) {
                    // IDB progress is the single owner of persistent position data —
                    // always fresher than the session snapshot (which only updates on view changes)
                    const position = this.reader.getProgress(snap.activeGalleryId);
                    const ok = await this.reader.restoreReader(snap.activeGalleryId, position);
                    if (ok) {
                        this.ui.setViewDirect('reader', snap.viewStack);
                        await this.prepareBackViews(snap);
                        this.persistSession();
                        this.log.log('restore-ok', { view: 'reader', galleryId: snap.activeGalleryId });
                        return;
                    }
                    this.log.log('restore-fallback', { view: 'reader', reason: 'gallery-load-failed' });
                }
                // Fallback to list
                break;

            case 'favorites':
                this.ui.setViewDirect('favorites', snap.viewStack);
                await this.favorites.loadGalleries();
                if (snap.favoritesPage) {
                    this.favorites.currentPage = snap.favoritesPage;
                }
                this.persistSession();
                this.log.log('restore-ok', { view: 'favorites' });
                return;

            case 'saved':
                this.ui.setViewDirect('saved', snap.viewStack);
                this.persistSession();
                this.log.log('restore-ok', { view: 'saved' });
                return;

            case 'list':
                // Already restored search above, just stay in list
                break;
        }

        this.persistSession();
        this.log.log('restore-ok', { view: 'list' });
    }

    /**
     * Pre-position back views so swipe-back reveals the correct scroll position.
     * During normal usage the DOM owns scroll position (views stay mounted).
     * On restore the DOM is fresh — derive position from the active gallery.
     */
    private async prepareBackViews(snap: import('./session.js').SessionSnapshot) {
        if (!snap.activeGalleryId) return;

        const backView = snap.viewStack[snap.viewStack.length - 1];

        if (backView === 'favorites') {
            await this.favorites.loadGalleries();
            // Derive the correct page from the gallery's position in the list
            const idx = this.favorites.favoriteGalleries.findIndex(
                g => g.gallery_id === snap.activeGalleryId
            );
            if (idx >= 0) {
                this.favorites.currentPage = Math.floor(idx / PAGE_SIZE);
            }
            this.scrollViewToGallery('view-favorites', snap.activeGalleryId);
        } else if (backView === 'list') {
            this.scrollViewToGallery('view-list', snap.activeGalleryId);
        }
    }

    /** Scroll a view container to center a gallery row, and sync its thumbnail strip. */
    private scrollViewToGallery(viewId: string, galleryId: number) {
        const pageIndex = this.reader.getProgress(galleryId).pageIndex;
        requestAnimationFrame(() => {
            const container = document.getElementById(viewId);
            const el = container?.querySelector(`#gallery-${galleryId}`);
            if (el) {
                el.scrollIntoView({ block: 'center' });
            }
            // Also sync the strip to current page (reader.syncStripScroll needs
            // peekBack() which requires the reader view to be active — do it directly)
            this.reader.syncStripScroll(galleryId, pageIndex);
        });
    }

    // -- Resume detection --

    private onVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
            this.handleResume();
        }
    };

    private setupResumeDetection() {
        document.addEventListener('visibilitychange', this.onVisibilityChange);

        // iOS sentinel: detect deep sleep via tick drift
        this.lastTick = Date.now();
        this.tickInterval = setInterval(() => {
            const now = Date.now();
            const drift = now - this.lastTick;
            this.lastTick = now;
            if (drift > 3000) {
                this.handleResume();
            }
        }, 1000);
    }

    destroy() {
        this.log.destroy();
        clearInterval(this.tickInterval);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.reader.destroy();
        this.toast.destroy();
    }

    private handleResume() {
        const snap = loadSession();
        if (!snap) return;

        const elapsed = Date.now() - this.lastTick;

        if (elapsed > DEEP_SLEEP_MS) {
            this.log.log('resume', { kind: 'deep-sleep', elapsedMs: elapsed });
            this.toast.show('Session expired, refreshing...');
            this.searchState.search(this.searchState.currentQuery);
            return;
        }

        if (elapsed > RESUME_RECOVERY_MS) {
            this.log.log('resume', { kind: 'recovery', elapsedMs: elapsed });
            this.searchState.search(this.searchState.currentQuery);
        }
    }
}

export const appState = new AppState();
