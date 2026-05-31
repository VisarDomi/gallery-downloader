export type { Gallery, ImageDimension } from 'gallery-sources';
import type { Gallery } from 'gallery-sources';

export interface GalleryListItem {
    gallery_id: number;
    title: string;
    title_jpn: string;
    type: string;
    language: string;
    date: string;
    count: number;
    thumb_count: number;
}

export interface SearchResponse {
    total: number;
    normalized: string;
    items: GalleryListItem[];
}

export interface PagePosition {
    pageIndex: number;
    fraction: number; // 0.0 = top of page, 1.0 = bottom of page
}

export type RootViewMode = 'list' | 'favorites';
export type ViewMode = RootViewMode | 'reader';

export type PageTurn =
    | { direction: 'backward'; scrollAnchor: 'bottom' }
    | { direction: 'forward' | 'same'; scrollAnchor: 'top' };

/** Shared interface for paginated gallery sources (SearchState, FavoritesState). */
export interface PaginatedGallerySource {
    readonly paginatedGalleries: GalleryListItem[];
    readonly totalPages: number;
    currentPage: number;
}
