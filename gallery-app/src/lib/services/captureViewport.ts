function intersect(a: DOMRect, b: DOMRect) {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.right, b.right);
    const bottom = Math.min(a.bottom, b.bottom);
    if (right <= left || bottom <= top) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export async function captureReaderViewport(root: HTMLElement): Promise<Blob> {
    const width = root.clientWidth;
    const height = root.clientHeight;
    if (width <= 0 || height <= 0) {
        throw new Error('Reader viewport is not ready');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context unavailable');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const rootRect = root.getBoundingClientRect();
    const images = Array.from(root.querySelectorAll<HTMLImageElement>('.reader-page img'));

    for (const img of images) {
        if (!img.complete || !img.naturalWidth || !img.naturalHeight || !img.src) continue;
        const rect = img.getBoundingClientRect();
        const visible = intersect(rootRect, rect);
        if (!visible) continue;

        const scaleX = img.naturalWidth / rect.width;
        const scaleY = img.naturalHeight / rect.height;

        const sx = (visible.left - rect.left) * scaleX;
        const sy = (visible.top - rect.top) * scaleY;
        const sw = visible.width * scaleX;
        const sh = visible.height * scaleY;

        const dx = visible.left - rootRect.left;
        const dy = visible.top - rootRect.top;

        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, visible.width, visible.height);
    }

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Failed to encode viewport image');
    return blob;
}
