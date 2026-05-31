import { hitomi } from 'gallery-sources';

export const PAGE_SIZE = 100;
export const THUMB_WIDTH = 100;
export const THUMB_HEIGHT = 300;

export const RESUME_RECOVERY_MS = 5_000;
export const DEEP_SLEEP_MS = 10 * 60 * 1000;

/** Build a thumbnail URL for a gallery.
 *  Pattern: /media/gallery-dl/hitomi/{id}/hitomi_{id}_thumb_{NNNN}.webp */
export function thumbUrl(galleryId: number, thumbIndex: number): string {
    const padded = String(thumbIndex + 1).padStart(4, '0');
    const subdir = hitomi.gallerySubdir;
    return `/media/${subdir}/${galleryId}/hitomi_${galleryId}_thumb_${padded}.webp`;
}

// API URL builders — same-origin, works in both dev proxy and prod
export const API = {
    SEARCH: (query: string) => {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        return `/search?${params}`;
    },
    GALLERY: (id: number) => `/gallery/${id}`,
    GALLERIES: () => '/galleries',
    REFRESH: () => '/refresh',
    QUERIES: () => '/queries',
    MEDIA: (path: string) => `/media/${path.split('/').map(encodeURIComponent).join('/')}`,
    DELETE: () => '/api/delete',
    OCR_STATUS: () => '/api/ocr/status',
    OCR_BACKENDS: () => '/api/ocr/backends',
    OCR_LOOKUP: () => '/api/ocr/lookup',
    ARTISTS: () => '/artists',
    ARTISTS_ADD: () => '/artists/add',
    REMOVE: () => '/remove',
    REMOVE_STATUS: () => '/remove/status',
};
