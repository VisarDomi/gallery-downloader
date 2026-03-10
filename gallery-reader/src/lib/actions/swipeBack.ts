import { appDimensions } from '$lib/state/appDimensions.js';

interface SwipeBackOptions {
	onClose: () => void;
	ui: { isSwiping: boolean; peekBack(): string | null };
}

const EDGE_ZONE_RATIO = 0.077;
const DEADZONE_RATIO = 0.026;
const SWIPE_THRESHOLD = 0.3;

export function swipeBack(node: HTMLElement, options: SwipeBackOptions) {
	let opts = options;
	let tracking = false;
	let startX = 0;
	let startY = 0;
	let locked = false;
	let rejected = false;
	let lockDx = 0;
	let progress = 0;
	let viewLayer: HTMLElement | null = null;
	let backEl: HTMLElement | null = null;

	function onStart(e: TouchEvent) {
		const touch = e.touches[0];
		const edgeZone = appDimensions.width * EDGE_ZONE_RATIO;
		if (touch.clientX <= edgeZone) {
			tracking = true;
			locked = false;
			rejected = false;
			lockDx = 0;
			progress = 0;
			startX = touch.clientX;
			startY = touch.clientY;
			viewLayer = node.closest('.view-layer') as HTMLElement | null;
			const backMode = opts.ui.peekBack();
			backEl = backMode ? document.getElementById('view-' + backMode) : null;
			// Pre-show back view during deadzone so paint cost is spread
			// before the axis locks and transforms begin
			backEl?.classList.add('swipe-back');
		}
	}

	function onMove(e: TouchEvent) {
		if (!tracking || rejected) return;

		const touch = e.touches[0];
		const dx = touch.clientX - startX;
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
				backEl?.classList.remove('swipe-back');
				return;
			}
			locked = true;
			lockDx = dx;
			opts.ui.isSwiping = true;
			viewLayer?.classList.add('swipe-active');
		}

		e.preventDefault();

		const travel = dx - lockDx;
		const maxTravel = appWidth - lockDx;
		progress = Math.max(0, Math.min(1, travel / maxTravel));
		if (viewLayer) {
			viewLayer.style.transform = 'translateX(' + (progress * 100) + '%)';
		}
	}

	function onEnd() {
		if (!tracking || !locked) {
			if (tracking) backEl?.classList.remove('swipe-back');
			tracking = false;
			return;
		}
		tracking = false;

		viewLayer?.classList.add('swipe-animating');

		if (progress > SWIPE_THRESHOLD) {
			if (viewLayer) viewLayer.style.transform = 'translateX(100%)';
			setTimeout(() => {
				cleanup();
				opts.onClose();
			}, 250);
		} else {
			if (viewLayer) viewLayer.style.transform = '';
			setTimeout(cleanup, 250);
		}
	}

	function cleanup() {
		viewLayer?.classList.remove('swipe-active', 'swipe-animating');
		backEl?.classList.remove('swipe-back');
		if (viewLayer) viewLayer.style.transform = '';
		opts.ui.isSwiping = false;
		viewLayer = null;
		backEl = null;
		progress = 0;
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
