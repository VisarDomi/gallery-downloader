interface SwipeBackOptions {
    onClose: () => void;
    ui: { swipeProgress: number; isSwiping: boolean; swipeAnimating: boolean };
}

export function swipeBack(node: HTMLElement, options: SwipeBackOptions) {
    const EDGE_ZONE = 30;
    const SWIPE_THRESHOLD = 0.3;
    let opts = options;
    let tracking = false;
    let startX = 0;
    let startY = 0;
    let locked = false;
    let rejected = false;

    function onStart(e: TouchEvent) {
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
            opts.ui.isSwiping = true;
        }

        e.preventDefault();

        const progress = Math.max(0, Math.min(1, dx / window.innerWidth));
        opts.ui.swipeProgress = progress;
    }

    function onEnd() {
        if (!tracking || !locked) {
            tracking = false;
            return;
        }

        tracking = false;
        const progress = opts.ui.swipeProgress;

        opts.ui.swipeAnimating = true;

        if (progress > SWIPE_THRESHOLD) {
            opts.ui.swipeProgress = 1;
            setTimeout(() => {
                opts.ui.isSwiping = false;
                opts.ui.swipeAnimating = false;
                opts.ui.swipeProgress = 0;
                opts.onClose();
            }, 250);
        } else {
            opts.ui.swipeProgress = 0;
            setTimeout(() => {
                opts.ui.isSwiping = false;
                opts.ui.swipeAnimating = false;
            }, 250);
        }
    }

    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd, { passive: true });

    return {
        update(newOptions: SwipeBackOptions) { opts = newOptions; },
        destroy() {
            node.removeEventListener('touchstart', onStart);
            node.removeEventListener('touchmove', onMove);
            node.removeEventListener('touchend', onEnd);
        }
    };
}
