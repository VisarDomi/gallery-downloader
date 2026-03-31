import type { LogEmit } from '../services/LogService.js';
import type { ViewMode } from '../types.js';

export class UIState {
    viewMode = $state<ViewMode>('list');
    viewStack = $state<ViewMode[]>([]);
    stripScrolls: Record<number, number> = {};

    onViewChange: (() => void) | null = null;
    private emit: LogEmit;

    constructor(emit: LogEmit) {
        this.emit = emit;
    }

    peekBack(): ViewMode | null {
        return this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
    }

    pushView(mode: ViewMode) {
        const from = this.viewMode;
        this.viewStack = [...this.viewStack, this.viewMode];
        this.viewMode = mode;
        this.emit('view-push', { from, to: mode });
        this.measureTransition(from, mode);
        this.onViewChange?.();
    }

    popView() {
        if (this.viewStack.length === 0) return;
        const from = this.viewMode;
        this.viewMode = this.viewStack[this.viewStack.length - 1];
        this.viewStack = this.viewStack.slice(0, -1);
        this.emit('view-pop', { from, to: this.viewMode });
        this.measureTransition(from, this.viewMode);
        this.onViewChange?.();
    }

    setViewDirect(mode: ViewMode, stack: ViewMode[]) {
        this.viewMode = mode;
        this.viewStack = stack;
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
