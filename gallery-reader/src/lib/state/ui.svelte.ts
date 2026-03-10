import type { ViewMode } from '../types.js';

export class UIState {
    viewMode = $state<ViewMode>('list');
    viewStack = $state<ViewMode[]>([]);
    stripScrolls: Record<number, number> = {};
    isSwiping = $state(false);
    swipeProgress = $state(0);
    swipeAnimating = $state(false);

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

}
