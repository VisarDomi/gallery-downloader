import { appDimensions } from '$lib/state/appDimensions.js';
import { SWIPE_THRESHOLD, DEADZONE_RATIO, EDGE_ZONE_RATIO } from '$lib/constants.js';

interface SwipeBackOptions {
	onClose: () => void;
	peekBack: () => string | null;
}

export function swipeBack(node: HTMLElement, options: SwipeBackOptions) {
	let opts = options;
	let tracking = false;
	let startX = 0;
	let startY = 0;
	let locked = false;
	let rejected = false;
	let lockDx = 0;
	let progress = 0;

	let activeLayer: HTMLElement | null = null;
	let backLayer: HTMLElement | null = null;
	let cleanedUp = false;
	let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

	function cleanup() {
		if (cleanedUp) return;
		cleanedUp = true;
		clearTimeout(fallbackTimer);
		if (activeLayer) {
			activeLayer.removeEventListener('transitionend', onTransitionEnd);
			activeLayer.classList.remove('swipe-active', 'swipe-animating');
			activeLayer.style.transform = '';
			activeLayer.style.willChange = '';
		}
		if (backLayer) {
			backLayer.classList.remove('swipe-back');
			backLayer.style.willChange = '';
		}
	}

	function onTransitionEnd(e: TransitionEvent) {
		if (e.propertyName !== 'transform') return;
		const shouldClose = progress > SWIPE_THRESHOLD;
		cleanup();
		if (shouldClose) opts.onClose();
	}

	function onStart(e: TouchEvent) {
		const touch = e.touches[0];
		const edgeZone = appDimensions.width * EDGE_ZONE_RATIO;
		if (touch.clientX <= edgeZone) {
			tracking = true;
			locked = false;
			rejected = false;
			lockDx = 0;
			progress = 0;
			cleanedUp = false;
			startX = touch.clientX;
			startY = touch.clientY;
			activeLayer = node.closest('.view-layer') as HTMLElement | null;
			if (activeLayer) {
				activeLayer.style.willChange = 'transform';
			}
			const backId = opts.peekBack();
			backLayer = backId ? document.getElementById('view-' + backId) : null;
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
				if (activeLayer) activeLayer.style.willChange = '';
				return;
			}
			locked = true;
			lockDx = dx;
			if (backLayer) {
				backLayer.style.willChange = 'transform';
				backLayer.classList.add('swipe-back');
			}
			if (activeLayer) activeLayer.classList.add('swipe-active');
		}

		e.preventDefault();

		const travel = dx - lockDx;
		const maxTravel = appWidth - lockDx;
		progress = Math.max(0, Math.min(1, travel / maxTravel));
		if (activeLayer) {
			activeLayer.style.transform = `translateX(${progress * 100}%)`;
		}
	}

	function onEnd() {
		if (!tracking) return;
		tracking = false;

		if (!locked) {
			if (activeLayer) activeLayer.style.willChange = '';
			return;
		}

		if (activeLayer) {
			activeLayer.classList.add('swipe-animating');
			activeLayer.addEventListener('transitionend', onTransitionEnd);
			fallbackTimer = setTimeout(() => {
				const shouldClose = progress > SWIPE_THRESHOLD;
				cleanup();
				if (shouldClose) opts.onClose();
			}, 300);
		}

		if (progress > SWIPE_THRESHOLD) {
			if (activeLayer) activeLayer.style.transform = 'translateX(100%)';
		} else {
			if (activeLayer) activeLayer.style.transform = 'translateX(0)';
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
