import { PAGE_SIZE, RESUME_RECOVERY_MS, DEEP_SLEEP_MS } from '../config.js';
import type { PageTurn, PaginatedGallerySource, RootViewMode, ViewMode } from '../types.js';
import * as api from '../services/api.js';
import { LogService } from '../services/LogService.js';
import { setDbLogger } from '../services/db.js';
import { getJson, setJson, remove } from '../services/storage.js';
import { ToastState } from './toast.svelte.js';
import { UIState } from './ui.svelte.js';
import { SearchState } from './search.svelte.js';
import { ReaderState } from './reader.svelte.js';
import { FavoritesState } from './favorites.svelte.js';
import { SavedState } from './saved.svelte.js';
import { DeleteState } from './delete.svelte.js';
import { ArtistsState } from './artists.svelte.js';
import { saveSession, loadSession, clearSession, type SessionSnapshot } from './session.js';

class AppState {
    readonly log = new LogService();
    toast = new ToastState();
    ui: UIState;
    searchState: SearchState;
    favorites: FavoritesState;
    saved: SavedState;
    reader: ReaderState;
    delete_: DeleteState;
    artists: ArtistsState;

    private lastTick = Date.now();
    private tickInterval: ReturnType<typeof setInterval> | undefined;
    private cleanups: (() => void)[] = [];
    private scrollTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
        const emit = this.log.emit;
        this.ui = new UIState(emit);
        this.searchState = new SearchState(emit);
        this.favorites = new FavoritesState(emit);
        this.saved = new SavedState(emit);
        this.reader = new ReaderState(this.ui, emit);
        this.delete_ = new DeleteState({
            favorites: this.favorites,
            reader: this.reader,
            search: this.searchState,
        });
        this.artists = new ArtistsState(this.toast, emit);
        this.ui.onViewChange = () => this.persistSession();
    }

    async init() {
        const t0 = Date.now();

        // LogService owns global error handlers — start first so crashes during init are captured
        this.log.start();
        this.log.emit('boot-start');

        // Crash sentinel: detect if previous session died without clean shutdown
        const sentinel = getJson<{ action: string; view: string; page: number } | null>('sentinel', null);
        if (sentinel) {
            this.log.emit('crash-detected', {
                lastAction: sentinel.action,
                lastView: sentinel.view,
                lastPage: sentinel.page,
            });
        }
        setJson('sentinel', { action: 'boot', view: 'list', page: 0 });

        // Clean shutdown clears the sentinel
        const onBeforeUnload = () => remove('sentinel');
        window.addEventListener('beforeunload', onBeforeUnload);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') remove('sentinel');
        });
        this.cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));

        // Wire db module's logger to our LogService
        setDbLogger((op, error) => this.log.emit('db-error', { op, error }));

        try {
            await Promise.all([
                this.saved.init(),
                this.favorites.init(),
                this.reader.loadProgress(),
                this.artists.init(),
            ]);

            api.refreshIndex().catch((e) =>
                this.log.emit('refresh-index-failed', { message: String(e) }),
            );

            await this.searchState.loadFilterOptions();

            await this.restoreSession();

            this.setupResumeDetection();
            this.setupScrollPersistence();

            this.log.emit('boot-ready', { ms: Date.now() - t0, view: this.ui.viewMode });
        } catch (e) {
            this.log.emit('init-crash', {
                message: String((e as Error)?.message ?? e),
                stack: (e as Error)?.stack ?? '',
                ms: Date.now() - t0,
            });
        }
    }

    /** Update crash sentinel before expensive operations. */
    updateSentinel(action: string) {
        setJson('sentinel', { action, view: this.ui.viewMode, page: this.searchState.currentPage });
    }

    /** Single owner of page-change orchestration: log, sentinel, persist, scroll. */
    changePage(view: ViewMode, source: PaginatedGallerySource, page: number) {
        const previousPage = source.currentPage;
        const turn = this.classifyPageTurn(previousPage, page);
        this.log.emit('page-change', { view, from: previousPage, to: page, totalItems: source.totalPages * PAGE_SIZE });
        this.updateSentinel(`page-change:${view}:${page}`);
        source.currentPage = page;
        this.persistSession();
        this.applyPageTurnScroll(view, turn);
    }

    private classifyPageTurn(from: number, to: number): PageTurn {
        if (to < from) return { direction: 'backward', scrollAnchor: 'bottom' };
        if (to > from) return { direction: 'forward', scrollAnchor: 'top' };
        return { direction: 'same', scrollAnchor: 'top' };
    }

    private applyPageTurnScroll(view: ViewMode, turn: PageTurn) {
        requestAnimationFrame(() => {
            const container = document.getElementById(`view-${view}`);
            if (!container) return;
            const top = turn.scrollAnchor === 'bottom' ? container.scrollHeight : 0;
            container.scrollTo(0, top);
        });
    }

    /** Single owner of search→persist flow. */
    async searchAndPersist(searchFn: () => Promise<void>) {
        this.saved.hide();
        this.ui.setRoot('list');
        await searchFn();
        this.persistSession();
    }

    // -- Cross-domain orchestration --

    openFavorites() {
        this.saved.hide();
        this.ui.setRoot('favorites');
        this.favorites.loadGalleries();
    }

    openList() {
        this.saved.hide();
        this.ui.setRoot('list');
    }

    // -- Session persistence --

    /** Debounced session persist — call freely, writes at most every 500ms. */
    persistSession() {
        clearTimeout(this.scrollTimer);
        this.scrollTimer = setTimeout(() => this.flushSession(), 500);
    }

    /** Immediate write — used by persistSession debounce and destroy. */
    private flushSession() {
        clearTimeout(this.scrollTimer);
        saveSession({
            viewMode: this.ui.viewMode,
            viewStack: this.ui.viewMode === 'reader' ? [this.ui.rootView] : [],
            activeGalleryId: this.reader.activeGallery?.gallery_id,
            searchQuery: this.searchState.currentQuery || undefined,
            searchPage: this.searchState.currentPage || undefined,
            favoritesPage: this.favorites.currentPage || undefined,
            listScroll: document.getElementById('view-list')?.scrollTop || undefined,
            favoritesScroll: document.getElementById('view-favorites')?.scrollTop || undefined,
        });
    }

    private async restoreSession() {
        const snap = loadSession();
        if (!snap) {
            this.log.emit('restore-none');
            await this.searchState.search('');
            return;
        }

        this.log.emit('restore-start', {
            view: snap.viewMode,
            galleryId: snap.activeGalleryId ?? null,
            hasQuery: !!snap.searchQuery,
        });

        clearSession();

        const rootView = this.sessionRootView(snap);
        if (rootView === 'list') {
            if (snap.searchQuery) {
                await this.searchState.search(snap.searchQuery);
                if (snap.searchPage) {
                    this.searchState.currentPage = snap.searchPage;
                }
            } else {
                await this.searchState.search(this.searchState.currentQuery);
            }
        }

        // Restore view based on saved mode
        switch (snap.viewMode) {
            case 'reader':
                if (snap.activeGalleryId != null) {
                    // IDB progress is the single owner of persistent position data —
                    // always fresher than the session snapshot (which only updates on view changes)
                        const position = this.reader.getProgress(snap.activeGalleryId);
                    try {
                        await this.reader.restoreReader(snap.activeGalleryId, position);
                        this.ui.setViewDirect('reader', rootView);
                        await this.prepareBackViews(snap);
                        this.persistSession();
                        this.log.emit('restore-ok', { view: 'reader', galleryId: snap.activeGalleryId });
                        return;
                    } catch (e) {
                        this.log.emit('restore-fallback', { view: 'reader', reason: String((e as Error)?.message ?? e) });
                    }
                }
                // Fallback to list
                break;

            case 'favorites':
                this.ui.setViewDirect('favorites', 'favorites');
                await this.favorites.loadGalleries();
                if (snap.favoritesPage != null) {
                    this.favorites.currentPage = Math.min(snap.favoritesPage, this.favorites.totalPages - 1);
                }
                this.restoreScrollPositions(snap);
                this.persistSession();
                this.log.emit('restore-ok', { view: 'favorites' });
                return;

            case 'list':
                // Already restored search above, just stay in list
                break;
        }

        this.ui.setViewDirect('list', 'list');
        this.restoreScrollPositions(snap);
        this.persistSession();
        this.log.emit('restore-ok', { view: 'list' });
    }

    private sessionRootView(snap: SessionSnapshot): RootViewMode {
        if (snap.viewMode === 'favorites') return 'favorites';
        if (snap.viewMode === 'reader' && snap.viewStack.includes('favorites')) return 'favorites';
        return 'list';
    }

    private restoreScrollPositions(snap: SessionSnapshot) {
        requestAnimationFrame(() => {
            if (snap.listScroll) {
                const listView = document.getElementById('view-list');
                if (listView) listView.scrollTop = snap.listScroll;
            }
            if (snap.favoritesScroll) {
                const favsView = document.getElementById('view-favorites');
                if (favsView) favsView.scrollTop = snap.favoritesScroll;
            }
        });
    }

    /**
     * Pre-position back views so swipe-back reveals the correct scroll position.
     * During normal usage the DOM owns scroll position (views stay mounted).
     * On restore the DOM is fresh — derive position from the active gallery.
     */
    private async prepareBackViews(snap: SessionSnapshot) {
        if (!snap.activeGalleryId) return;

        const backView = this.sessionRootView(snap);

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

    private setupScrollPersistence() {
        const onScroll = () => this.persistSession();
        const listView = document.getElementById('view-list');
        const favsView = document.getElementById('view-favorites');
        listView?.addEventListener('scroll', onScroll, { passive: true });
        favsView?.addEventListener('scroll', onScroll, { passive: true });
        this.cleanups.push(
            () => listView?.removeEventListener('scroll', onScroll),
            () => favsView?.removeEventListener('scroll', onScroll),
        );
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
        this.flushSession();
        this.log.destroy();
        clearInterval(this.tickInterval);
        clearTimeout(this.scrollTimer);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        for (const fn of this.cleanups) fn();
        this.cleanups = [];
        this.reader.destroy();
        this.toast.destroy();
    }

    private handleResume() {
        const snap = loadSession();
        if (!snap) return;

        const elapsed = Date.now() - this.lastTick;

        if (elapsed > DEEP_SLEEP_MS) {
            this.log.emit('resume', { kind: 'deep-sleep', elapsedMs: elapsed });
            this.toast.show('Session expired, refreshing...');
            this.searchState.search(this.searchState.currentQuery);
            return;
        }

        if (elapsed > RESUME_RECOVERY_MS) {
            this.log.emit('resume', { kind: 'recovery', elapsedMs: elapsed });
            this.searchState.search(this.searchState.currentQuery);
        }
    }
}

export const appState = new AppState();
