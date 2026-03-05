import { appState } from '$lib/state.svelte.js';

export function swipeBack(node: HTMLElement, onComplete: () => void) {
    const EDGE_ZONE = 30;
    const SWIPE_THRESHOLD = 0.3;
    let tracking = false;
    let startX = 0;
    let startY = 0;
    let locked = false;
    let rejected = false;

    function onStart(e: TouchEvent) {
        if (!appState.ui.backTarget) return;
        const touch = e.touches[0];
        if (touch.clientX <= EDGE_ZONE) {
            tracking = true;
            locked = false;
            rejected = false;
            startX = touch.clientX;
            startY = touch.clientY;
        }
    }

    function onMove(e: TouchEvent) {
        if (!tracking || rejected) return;

        const touch = e.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;

        if (!locked) {
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            if (absDx < 10 && absDy < 10) return;
            if (absDy > absDx) {
                rejected = true;
                tracking = false;
                return;
            }
            locked = true;
            appState.ui.isSwiping = true;
        }

        e.preventDefault();

        const progress = Math.max(0, Math.min(1, dx / window.innerWidth));
        appState.ui.swipeProgress = progress;
    }

    function onEnd() {
        if (!tracking || !locked) {
            tracking = false;
            return;
        }

        tracking = false;
        const progress = appState.ui.swipeProgress;

        appState.ui.swipeAnimating = true;

        if (progress > SWIPE_THRESHOLD) {
            appState.ui.swipeProgress = 1;
            setTimeout(() => {
                appState.ui.isSwiping = false;
                appState.ui.swipeAnimating = false;
                appState.ui.swipeProgress = 0;
                onComplete();
            }, 250);
        } else {
            appState.ui.swipeProgress = 0;
            setTimeout(() => {
                appState.ui.isSwiping = false;
                appState.ui.swipeAnimating = false;
            }, 250);
        }
    }

    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd, { passive: true });

    return {
        destroy() {
            node.removeEventListener('touchstart', onStart);
            node.removeEventListener('touchmove', onMove);
            node.removeEventListener('touchend', onEnd);
        }
    };
}
