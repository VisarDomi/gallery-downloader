import { hitomi } from 'gallery-sources';
import { API } from '../config.js';
import type { Gallery, GalleryListItem, SearchResponse } from '../types.js';

export async function search(query: string = ''): Promise<SearchResponse> {
    const res = await fetch(API.SEARCH(query));
    const data = await res.json();

    if (!Array.isArray(data.items)) {
        data.items = [];
    }

    return data;
}

export async function getGallery(id: number): Promise<Gallery> {
    const res = await fetch(API.GALLERY(id));
    const g = await res.json();

    // Ensure arrays are initialized
    if (!Array.isArray(g.artist)) g.artist = [];
    if (!Array.isArray(g.group)) g.group = [];
    if (!Array.isArray(g.parody)) g.parody = [];
    if (!Array.isArray(g.characters)) g.characters = [];
    if (!Array.isArray(g.tags)) g.tags = [];
    if (!Array.isArray(g.files)) g.files = [];
    if (!Array.isArray(g.fullFiles)) g.fullFiles = [];
    if (!Array.isArray(g.thumbnailFiles)) g.thumbnailFiles = [];
    if (!Array.isArray(g.dimensions)) g.dimensions = [];

    return g as Gallery;
}

export async function getGalleries(ids: number[]): Promise<GalleryListItem[]> {
    const res = await fetch(API.GALLERIES(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
    });
    return res.json();
}

export async function facets(): Promise<{
    languages: [string, number][];
    artists: [string, number][];
    groups: [string, number][];
}> {
    const res = await fetch(API.FACETS());
    return res.json();
}

export async function sendToDownloader(query: string): Promise<void> {
    const url = hitomi.toSourceUrl(query);
    await fetch(API.DOWNLOADER(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: url }),
    });
}

export async function refreshIndex(): Promise<void> {
    await fetch(API.REFRESH(), { method: 'POST' });
}
