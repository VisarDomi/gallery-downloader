export type { Gallery, ImageDimension } from 'gallery-sources';
import type { Gallery } from 'gallery-sources';

export interface SearchResponse {
    total: number;
    normalized: string;
    items: Gallery[];
}

export type ViewMode = 'list' | 'reader' | 'saved' | 'favorites';
