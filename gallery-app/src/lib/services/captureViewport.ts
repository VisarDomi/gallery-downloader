import type { Gallery } from '$lib/types.js';

export interface OcrViewportImage {
    pageIndex: number;
    mediaPath: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface OcrViewportRequest {
    viewport: {
        width: number;
        height: number;
        scale: number;
        devicePixelRatio: number;
    };
    images: OcrViewportImage[];
}

interface RectLike {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
}

function intersect(a: RectLike, b: RectLike): RectLike | null {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function viewportRect(): RectLike {
    const visualViewport = window.visualViewport;
    if (visualViewport) {
        return {
            left: 0,
            top: 0,
            right: visualViewport.width,
            bottom: visualViewport.height,
            width: visualViewport.width,
            height: visualViewport.height,
        };
    }
    return {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
    };
}

export function buildReaderViewportRequest(root: HTMLElement, gallery: Gallery): OcrViewportRequest {
    const rootRect = root.getBoundingClientRect();
    const captureRect = intersect(rootRect, viewportRect());
    if (!captureRect || captureRect.width <= 0 || captureRect.height <= 0) {
        throw new Error('Reader viewport is not ready');
    }

    const visualViewport = window.visualViewport;
    const scale = Math.max(1, visualViewport?.scale || 1);
    const devicePixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const pages = Array.from(root.querySelectorAll<HTMLElement>('.reader-page'));
    const images: OcrViewportImage[] = [];

    for (const page of pages) {
        const pageIndex = Number(page.dataset.pageIndex ?? '-1');
        if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= gallery.fullFiles.length) continue;

        const img = page.querySelector<HTMLImageElement>('img');
        if (!img || !img.complete || !img.src) continue;

        const rect = img.getBoundingClientRect();
        const visible = intersect(captureRect, rect);
        if (!visible) continue;

        images.push({
            pageIndex,
            mediaPath: `${gallery.path}/${gallery.fullFiles[pageIndex]}`,
            left: rect.left - captureRect.left,
            top: rect.top - captureRect.top,
            width: rect.width,
            height: rect.height,
        });
    }

    if (images.length === 0) {
        throw new Error('No visible reader images found');
    }

    return {
        viewport: {
            width: captureRect.width,
            height: captureRect.height,
            scale,
            devicePixelRatio,
        },
        images,
    };
}
