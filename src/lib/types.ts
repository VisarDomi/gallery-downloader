export interface ImageDimension {
    width: number;
    height: number;
}

export interface Gallery {
    gallery_id: number;
    title: string;
    title_jpn: string;
    type: string;
    language: string;
    lang: string;
    date: string;
    tags: string[];
    artist: string[];
    group: string[];
    parody: string[];
    characters: string[];
    count: number;
    category: string;
    subcategory: string;
    files: string[];
    fullFiles: string[];
    thumbnailFiles: string[];
    dimensions: ImageDimension[];
    path: string;
}

export interface SearchResponse {
    total: number;
    normalized: string;
    items: Gallery[];
}

export type ViewMode = 'list' | 'reader' | 'saved' | 'favorites';
