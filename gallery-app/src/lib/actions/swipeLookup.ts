import { appDimensions } from '$lib/state/appDimensions.js';
import { DEADZONE_RATIO, EDGE_ZONE_RATIO, SWIPE_THRESHOLD } from '$lib/constants.js';

interface SwipeLookupOptions {
    onLookup: () => void | Promise<void>;
}

export function swipeLookup(node: HTMLElement, options: SwipeLookupOptions) {
    let opts = options;
    let tracking = false;
    let locked = false;
    let rejected = false;
    let startX = 0;
    let startY = 0;
    let lockDx = 0;
    let progress = 0;
    let fired = false;

    function reset() {
        tracking = false;
        locked = false;
        rejected = false;
        startX = 0;
        startY = 0;
        lockDx = 0;
        progress = 0;
        fired = false;
    }

    function onStart(e: TouchEvent) {
        const touch = e.touches[0];
        const edgeZone = appDimensions.width * EDGE_ZONE_RATIO;
        if (touch.clientX >= appDimensions.width - edgeZone) {
            tracking = true;
            rejected = false;
            locked = false;
            progress = 0;
            fired = false;
            startX = touch.clientX;
            startY = touch.clientY;
        }
    }

    function onMove(e: TouchEvent) {
        if (!tracking || rejected || fired) return;

        const touch = e.touches[0];
        const dx = startX - touch.clientX;
        const dy = touch.clientY - startY;
        const appWidth = appDimensions.width;

        if (!locked) {
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            const deadzone = appWidth * DEADZONE_RATIO;
            if (absDx < deadzone && absDy < deadzone) return;
            if (absDy > absDx) {
                rejected = true;
                tracking = false;
                return;
            }
            locked = true;
            lockDx = dx;
        }

        e.preventDefault();

        const travel = dx - lockDx;
        const maxTravel = Math.max(1, appWidth - (appWidth - startX) - lockDx);
        progress = Math.max(0, Math.min(1, travel / maxTravel));

        if (progress > SWIPE_THRESHOLD && !fired) {
            fired = true;
            tracking = false;
            void opts.onLookup();
        }
    }

    function onEnd() {
        reset();
    }

    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd, { passive: true });

    return {
        update(newOptions: SwipeLookupOptions) { opts = newOptions; },
        destroy() {
            node.removeEventListener('touchstart', onStart);
            node.removeEventListener('touchmove', onMove);
            node.removeEventListener('touchend', onEnd);
        }
    };
}
