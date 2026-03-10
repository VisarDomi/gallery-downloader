import type { ViewMode } from '../types.js';

export class UIState {
    viewMode = $state<ViewMode>('list');
    viewStack = $state<ViewMode[]>([]);
    stripScrolls: Record<number, number> = {};
    isSwiping = $state(false);

    onViewChange: (() => void) | null = null;

    peekBack(): ViewMode | null {
        return this.viewStack.length > 0 ? this.viewStack[this.viewStack.length - 1] : null;
    }

    pushView(mode: ViewMode) {
        this.viewStack = [...this.viewStack, this.viewMode];
        this.viewMode = mode;
        this.onViewChange?.();
    }

    popView() {
        if (this.viewStack.length === 0) return;
        this.viewMode = this.viewStack[this.viewStack.length - 1];
        this.viewStack = this.viewStack.slice(0, -1);
        this.onViewChange?.();
    }

    setViewDirect(mode: ViewMode, stack: ViewMode[]) {
        this.viewMode = mode;
        this.viewStack = stack;
    }

    private _spriteControllers = new Set<AbortController>();

    registerSpriteController(c: AbortController) { this._spriteControllers.add(c); }
    unregisterSpriteController(c: AbortController) { this._spriteControllers.delete(c); }

    abortAllSprites() {
        for (const c of this._spriteControllers) c.abort();
        this._spriteControllers.clear();
    }
}
