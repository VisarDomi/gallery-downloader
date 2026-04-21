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

export async function fetchDefaultQueries(): Promise<string[]> {
    const res = await fetch(API.QUERIES());
    return res.json();
}

export async function refreshIndex(): Promise<void> {
    await fetch(API.REFRESH(), { method: 'POST' });
}

export async function getTrackedArtists(): Promise<string[]> {
    const res = await fetch(API.ARTISTS());
    return res.json();
}

export async function addArtist(line: string): Promise<{ status: string }> {
    const res = await fetch(API.ARTISTS_ADD(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

export async function removeArtist(line: string): Promise<void> {
    const res = await fetch(API.REMOVE(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: 'artists', line }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
}

export async function getRemoveStatus(): Promise<{ phase: string; error: string | null }> {
    const res = await fetch(API.REMOVE_STATUS());
    return res.json();
}

export async function deleteGalleries(ids: number[]): Promise<{
    deleted: number[];
    skipped: { id: number; reason: string }[];
}> {
    const res = await fetch(API.DELETE(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

export async function ocrLookup(image: Blob): Promise<{
    text: string;
    lines: string[];
    warnings: string[];
    elapsedMs: number;
}> {
    const res = await fetch(API.OCR_LOOKUP(), {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: image,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}
