import { hitomi } from 'gallery-sources';

export const PAGE_SIZE = 25;
export const SPRITE_THUMB_WIDTH = hitomi.sprite.thumbWidth;
export const SPRITE_THUMB_HEIGHT = hitomi.sprite.thumbHeight;
export const MAX_THUMBS_PER_STRIP = hitomi.sprite.maxPerStrip;

// API URL builders — same-origin, works in both dev proxy and prod
export const API = {
    SEARCH: (query: string) => {
        const params = new URLSearchParams({ limit: '10000' });
        if (query) params.set('q', query);
        return `/search?${params}`;
    },
    FACETS: () => '/facets',
    GALLERIES: () => '/galleries',
    REFRESH: () => '/refresh',
    DOWNLOADER: () => '/immediate',
    SPRITE: (galleryId: number, stripIndex: number) => `/api/sprite/${galleryId}/${stripIndex}`,
    MEDIA: (path: string) => `/media/${path.split('/').map(encodeURIComponent).join('/')}`,
};
