import { hitomi } from 'gallery-sources';

export const PAGE_SIZE = 25; // putting this to 100 just breaks the pwa on ios... we need to think of a better design for this app
export const SPRITE_THUMB_WIDTH = hitomi.sprite.thumbWidth;
export const SPRITE_THUMB_HEIGHT = hitomi.sprite.thumbHeight;
export const MAX_THUMBS_PER_STRIP = hitomi.sprite.maxPerStrip;

export const RESUME_RECOVERY_MS = 5_000;
export const DEEP_SLEEP_MS = 10 * 60 * 1000;

// API URL builders — same-origin, works in both dev proxy and prod
export const API = {
    SEARCH: (query: string) => {
        const params = new URLSearchParams();
        if (query) params.set('q', query);
        return `/search?${params}`;
    },
    GALLERY: (id: number) => `/gallery/${id}`,
    FACETS: () => '/facets',
    GALLERIES: () => '/galleries',
    REFRESH: () => '/refresh',
    QUERIES: () => '/queries',
    SPRITE: (galleryId: number, stripIndex: number) => `/api/sprite/${galleryId}/${stripIndex}`,
    MEDIA: (path: string) => `/media/${path.split('/').map(encodeURIComponent).join('/')}`,
    DELETE: () => '/api/delete',
};
