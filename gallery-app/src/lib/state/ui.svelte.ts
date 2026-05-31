import type { LogEmit } from '../services/LogService.js';
import type { RootViewMode, ViewMode } from '../types.js';

export class UIState {
    viewMode = $state<ViewMode>('list');
    rootView = $state<RootViewMode>('list');
    viewStack = $state<RootViewMode[]>([]);
    stripScrolls: Record<number, number> = {};

    onViewChange: (() => void) | null = null;
    private emit: LogEmit;

    constructor(emit: LogEmit) {
        this.emit = emit;
    }

    peekBack(): RootViewMode | null {
        return this.viewMode === 'reader' ? this.rootView : null;
    }

    pushView(mode: ViewMode) {
        const from = this.viewMode;
        if (mode === 'reader') {
            this.viewStack = [this.rootView];
            this.viewMode = 'reader';
        } else {
            this.rootView = mode;
            this.viewStack = [];
            this.viewMode = mode;
        }
        this.emit('view-push', { from, to: mode });
        this.measureTransition(from, mode);
        this.onViewChange?.();
    }

    popView() {
        if (this.viewMode !== 'reader') return;
        const from = this.viewMode;
        this.viewMode = this.rootView;
        this.viewStack = [];
        this.emit('view-pop', { from, to: this.viewMode });
        this.measureTransition(from, this.viewMode);
        this.onViewChange?.();
    }

    setRoot(mode: RootViewMode) {
        const from = this.viewMode;
        this.rootView = mode;
        this.viewMode = mode;
        this.viewStack = [];
        this.emit('view-push', { from, to: mode });
        this.measureTransition(from, mode);
        this.onViewChange?.();
    }

    setViewDirect(mode: ViewMode, root: RootViewMode = 'list') {
        this.rootView = root;
        this.viewMode = mode;
        this.viewStack = mode === 'reader' ? [root] : [];
    }

    getViewTier(viewId: string): 'active' | 'back' | 'deep' {
        if (this.viewMode === viewId) return 'active';
        if (this.viewMode === 'reader' && this.rootView === viewId) return 'back';
        return 'deep';
    }

    private measureTransition(from: string, to: string) {
        const t0 = performance.now();
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                this.emit('view-transition', {
                    from,
                    to,
                    frameMs: Math.round(performance.now() - t0),
                });
            });
        });
    }
}
