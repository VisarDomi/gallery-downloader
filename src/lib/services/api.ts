import { API } from '../config.js';
import type { Gallery, SearchResponse } from '../types.js';

function normalizeGallery(g: Record<string, unknown>): Gallery {
    if (!Array.isArray(g.artist)) g.artist = [];
    if (!Array.isArray(g.group)) g.group = [];
    if (!Array.isArray(g.parody)) g.parody = [];
    if (!Array.isArray(g.characters)) g.characters = [];
    if (!Array.isArray(g.tags)) g.tags = [];
    if (!Array.isArray(g.files)) g.files = [];
    if (!Array.isArray(g.fullFiles)) g.fullFiles = [];
    if (!Array.isArray(g.thumbnailFiles)) g.thumbnailFiles = [];
    if (!Array.isArray(g.dimensions)) g.dimensions = [];

    if (typeof g.gallery_id !== 'number') {
        g.gallery_id = Number(g.gallery_id) || 0;
    }

    return g as unknown as Gallery;
}

export async function search(query: string = ''): Promise<SearchResponse> {
    const res = await fetch(API.SEARCH(query));
    const data = await res.json();

    if (data.items && Array.isArray(data.items)) {
        data.items = data.items.map(normalizeGallery);
    } else {
        data.items = [];
    }

    return data;
}

export async function getGalleries(ids: number[]): Promise<Gallery[]> {
    const res = await fetch(API.GALLERIES(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
    });
    const items = await res.json();
    return items.map(normalizeGallery);
}

function toHitomiUrl(input: string): string {
    const trimmed = input.trim();
    if (/^https?:\/\//.test(trimmed)) return trimmed;
    // Bare gallery ID
    if (/^\d+$/.test(trimmed)) return `https://hitomi.la/galleries/${trimmed}.html`;
    // Search query like "language:japanese artist:urakan"
    return `https://hitomi.la/search.html?${encodeURIComponent(trimmed)}`;
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
    const url = toHitomiUrl(query);
    await fetch(API.DOWNLOADER(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: url }),
    });
}

export async function refreshIndex(): Promise<void> {
    await fetch(API.REFRESH(), { method: 'POST' });
}
