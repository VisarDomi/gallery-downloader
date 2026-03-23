const DB_NAME = 'hitomi-reader';
const DB_VERSION = 2;

import type { PagePosition } from '../types.js';

let dbLogger: ((op: string, error: string) => void) | null = null;

/** Wire IDB errors to the LogService. Call once during app init. */
export function setDbLogger(fn: (op: string, error: string) => void): void {
    dbLogger = fn;
}

function reportError(op: string, error: unknown): void {
    dbLogger?.(op, String(error));
}

interface ProgressEntry {
    galleryId: number;
    pageIndex: number;
    fraction?: number;
}

interface FavoriteEntry {
    galleryId: number;
    query: string;
    savedAt: number;
}

interface SavedSearchEntry {
    query: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = request.result;
            const oldVersion = event.oldVersion;

            if (oldVersion < 1) {
                db.createObjectStore('progress', { keyPath: 'galleryId' });
                db.createObjectStore('favorites', { keyPath: 'galleryId' });
                db.createObjectStore('savedSearches', { keyPath: 'query' });
            }

            if (oldVersion < 2) {
                // Backfill savedAt on existing favorites
                const tx = request.transaction!;
                const store = tx.objectStore('favorites');
                const cursor = store.openCursor();
                cursor.onsuccess = () => {
                    const c = cursor.result;
                    if (c) {
                        const entry = c.value;
                        if (entry.savedAt === undefined) {
                            entry.savedAt = 0;
                            c.update(entry);
                        }
                        c.continue();
                    }
                };
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => {
            reportError('openDB', request.error);
            reject(request.error);
        };
    });

    return dbPromise;
}

// Progress
export async function getProgress(galleryId: number): Promise<PagePosition> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('progress', 'readonly');
        const req = tx.objectStore('progress').get(galleryId);
        req.onsuccess = () => {
            const entry = req.result as ProgressEntry | undefined;
            resolve(entry ? { pageIndex: entry.pageIndex, fraction: entry.fraction ?? 0 } : { pageIndex: 0, fraction: 0 });
        };
        req.onerror = () => { reportError('getProgress', req.error); resolve({ pageIndex: 0, fraction: 0 }); };
    });
}

export async function setProgress(galleryId: number, position: PagePosition): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('progress', 'readwrite');
        tx.objectStore('progress').put({ galleryId, pageIndex: position.pageIndex, fraction: position.fraction } satisfies ProgressEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { reportError('setProgress', tx.error); resolve(); };
    });
}

export async function getAllProgress(): Promise<Record<number, PagePosition>> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('progress', 'readonly');
        const req = tx.objectStore('progress').getAll();
        req.onsuccess = () => {
            const map: Record<number, PagePosition> = {};
            for (const entry of req.result as ProgressEntry[]) {
                map[entry.galleryId] = { pageIndex: entry.pageIndex, fraction: entry.fraction ?? 0 };
            }
            resolve(map);
        };
        req.onerror = () => { reportError('getAllProgress', req.error); resolve({}); };
    });
}

// Favorites
export async function addFavorite(galleryId: number, query: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        tx.objectStore('favorites').put({ galleryId, query, savedAt: Date.now() } satisfies FavoriteEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { reportError('addFavorite', tx.error); resolve(); };
    });
}

export async function removeFavorite(galleryId: number): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readwrite');
        tx.objectStore('favorites').delete(galleryId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { reportError('removeFavorite', tx.error); resolve(); };
    });
}

export async function getAllFavorites(): Promise<FavoriteEntry[]> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('favorites', 'readonly');
        const req = tx.objectStore('favorites').getAll();
        req.onsuccess = () => {
            const entries = req.result as FavoriteEntry[];
            entries.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
            resolve(entries);
        };
        req.onerror = () => { reportError('getAllFavorites', req.error); resolve([]); };
    });
}

// Saved Searches
export async function addSavedSearch(query: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('savedSearches', 'readwrite');
        tx.objectStore('savedSearches').put({ query } satisfies SavedSearchEntry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { reportError('addSavedSearch', tx.error); resolve(); };
    });
}

export async function removeSavedSearch(query: string): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('savedSearches', 'readwrite');
        tx.objectStore('savedSearches').delete(query);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { reportError('removeSavedSearch', tx.error); resolve(); };
    });
}

export async function removeGalleries(ids: number[]): Promise<void> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(['progress', 'favorites'], 'readwrite');
        const progressStore = tx.objectStore('progress');
        const favoritesStore = tx.objectStore('favorites');
        for (const id of ids) {
            progressStore.delete(id);
            favoritesStore.delete(id);
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => { reportError('removeGalleries', tx.error); resolve(); };
    });
}

export async function getAllSavedSearches(): Promise<string[]> {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction('savedSearches', 'readonly');
        const req = tx.objectStore('savedSearches').getAll();
        req.onsuccess = () => resolve((req.result as SavedSearchEntry[]).map(e => e.query));
        req.onerror = () => { reportError('getAllSavedSearches', req.error); resolve([]); };
    });
}
