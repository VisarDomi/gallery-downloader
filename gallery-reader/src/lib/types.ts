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

export type ViewMode = 'list' | 'reader' | 'saved' | 'favorites';
